// index.js — WhatsApp AI Agent entry point
require('dotenv').config();
const { Client, LocalAuth, MessageTypes } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');
const { handleCommand } = require('./agent');
const { initScheduler } = require('./scheduler');
// Voice transcription not yet configured
const { clockIn, clockOut, getTodayAttendance, formatDailyReport, getKnownStaff, getTodayStatusForName, getProjects, addProject, removeProject, getHoursForPhone, getNameFromPhone } = require('./clockin');

// ── Config ────────────────────────────────────────────────────────────────
const PERSONAL_NUMBER = process.env.PERSONAL_NUMBER;
const PORT = process.env.PORT || 3000;
const TIMESHEET_GROUP = process.env.TIMESHEET_GROUP_NAME || 'Timesheet';
const APP_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;

// ── QR state ──────────────────────────────────────────────────────────────
let latestQR = null;
let isReady = false;

// ── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // ── Today's clock-in status for a given name ──────────────────────────────
  if (url.pathname === '/status') {
    const name = url.searchParams.get('name') || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      const status = getTodayStatusForName(name);
      return res.end(JSON.stringify(status || { clockedIn: false }));
    } catch (err) {
      return res.end(JSON.stringify({ clockedIn: false }));
    }
  }

  // ── Projects list ──────────────────────────────────────────────────────────
  if (url.pathname === '/projects') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      return res.end(JSON.stringify(getProjects()));
    } catch (err) {
      return res.end(JSON.stringify([]));
    }
  }

  // ── Known staff list (for name autocomplete + phone autofill) ────────────
  if (url.pathname === '/staff') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      const staff = getKnownStaff();
      return res.end(JSON.stringify(staff));
    } catch (err) {
      return res.end(JSON.stringify([]));
    }
  }

  // ── Clock In/Out form ──────────────────────────────────────────────────
  if (url.pathname === '/clockin') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const params = new URLSearchParams(body);
          const name = (params.get('name') || '').trim();
          const phone = (params.get('phone') || '').trim() || null;
          const action = params.get('action'); // 'in' or 'out'
          const customTime = (params.get('clock_out_time') || '').trim() || null;
          const fitForWork = params.get('fit_for_work') !== 'false';
          const project = (params.get('project') || '').trim() || null;

          if (!name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: 'Name is required.' }));
          }

          const result = action === 'out'
            ? clockOut(name, customTime)
            : clockIn(name, phone, fitForWork, project);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));

          // Notify owner
          if (result.success && whatsappReady) {
            const msg = action === 'out'
              ? `🟠 *${name}* clocked OUT at ${result.time}${result.wasLate ? ' _(manual time)_' : ''} (${result.hours}h worked)`
              : `🟢 *${name}* clocked IN at ${result.time}${phone ? ` — 📱 ${phone}` : ''}`;
            notifyOwner(msg);
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
      });
      return;
    }

    // Serve the clock in/out form
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Staff Attendance</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --green: #00C48C;
    --red: #FF5A5F;
    --dark: #0F1117;
    --card: #1A1D27;
    --border: #2A2D3A;
    --text: #E8EAF0;
    --muted: #6B7280;
  }

  body {
    background: var(--dark);
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 40px;
    width: 100%;
    max-width: 420px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.4);
  }

  .logo {
    width: 48px;
    height: 48px;
    background: var(--green);
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    margin-bottom: 24px;
  }

  h1 {
    font-size: 22px;
    font-weight: 600;
    margin-bottom: 6px;
  }

  .subtitle {
    color: var(--muted);
    font-size: 14px;
    margin-bottom: 32px;
  }

  .time-display {
    font-family: 'DM Mono', monospace;
    font-size: 32px;
    font-weight: 500;
    color: var(--green);
    margin-bottom: 4px;
  }

  .date-display {
    font-size: 13px;
    color: var(--muted);
    margin-bottom: 32px;
  }

  label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: var(--muted);
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  input[type="text"] {
    width: 100%;
    background: var(--dark);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    font-size: 16px;
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    outline: none;
    transition: border-color 0.2s;
    margin-bottom: 20px;
  }

  input[type="text"]:focus {
    border-color: var(--green);
  }

  input[type="text"]::placeholder { color: var(--muted); }

  .btn-group {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  button {
    padding: 14px;
    border: none;
    border-radius: 12px;
    font-size: 15px;
    font-weight: 600;
    font-family: 'DM Sans', sans-serif;
    cursor: pointer;
    transition: transform 0.1s, opacity 0.2s;
  }

  button:active { transform: scale(0.97); }

  .btn-in {
    background: var(--green);
    color: #000;
  }

  .btn-out {
    background: transparent;
    color: var(--red);
    border: 1.5px solid var(--red);
  }

  .result {
    display: none;
    margin-top: 20px;
    padding: 16px;
    border-radius: 12px;
    font-size: 14px;
    font-weight: 500;
    text-align: center;
  }

  .result.success { background: rgba(0,196,140,0.12); color: var(--green); border: 1px solid rgba(0,196,140,0.25); }
  .result.error { background: rgba(255,90,95,0.12); color: var(--red); border: 1px solid rgba(255,90,95,0.25); }

  .divider {
    height: 1px;
    background: var(--border);
    margin: 28px 0;
  }

  .footer {
    font-size: 12px;
    color: var(--muted);
    text-align: center;
  }
</style>
</head>
<body>
<div class="card">
  <div class="logo">⏱</div>
  <h1>Staff Attendance</h1>
  <p class="subtitle">Record your clock in and clock out times</p>

  <div class="time-display" id="clock">--:--:--</div>
  <div class="date-display" id="dateDisplay"></div>

  <label>Your Full Name</label>
  <input type="text" id="nameInput" placeholder="e.g. John Smith" autocomplete="name" />

  <div class="btn-group">
    <button class="btn-in" onclick="submit('in')">🟢 Clock In</button>
    <button class="btn-out" onclick="submit('out')">🔴 Clock Out</button>
  </div>

  <div class="result" id="result"></div>

  <div class="divider"></div>
  <div class="footer">Perth, Western Australia (AWST)</div>
</div>

<script>
  // Live clock
  function updateClock() {
    const now = new Date();
    const opts = { timeZone: 'Australia/Perth', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true };
    const dateOpts = { timeZone: 'Australia/Perth', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    document.getElementById('clock').textContent = now.toLocaleTimeString('en-AU', opts);
    document.getElementById('dateDisplay').textContent = now.toLocaleDateString('en-AU', dateOpts);
  }
  updateClock();
  setInterval(updateClock, 1000);

  async function submit(action) {
    const name = document.getElementById('nameInput').value.trim();
    const resultEl = document.getElementById('result');

    if (!name) {
      resultEl.className = 'result error';
      resultEl.style.display = 'block';
      resultEl.textContent = '⚠️ Please enter your name first.';
      return;
    }

    try {
      const res = await fetch('/clockin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'name=' + encodeURIComponent(name) + '&action=' + action
      });
      const data = await res.json();

      resultEl.style.display = 'block';
      if (data.success) {
        resultEl.className = 'result success';
        if (action === 'in') {
          resultEl.textContent = '✅ Clocked in at ' + data.time + '. Have a great day, ' + data.name + '!';
        } else {
          resultEl.textContent = '✅ Clocked out at ' + data.time + '. Total: ' + data.hours + 'h. See you tomorrow!';
        }
        document.getElementById('nameInput').value = '';
      } else {
        resultEl.className = 'result error';
        resultEl.textContent = '⚠️ ' + data.message;
      }
    } catch (err) {
      resultEl.className = 'result error';
      resultEl.style.display = 'block';
      resultEl.textContent = '❌ Something went wrong. Please try again.';
    }
  }
</script>
</body>
</html>`);
  }

  // ── QR / Status page ───────────────────────────────────────────────────
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (isReady) {
    return res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f0f0;">
      <h1 style="color:green;">✅ WhatsApp Agent is Running</h1>
      <p>Message your business number from your personal phone to use it.</p>
    </body></html>`);
  }
  if (!latestQR) {
    return res.end(`<html><head><meta http-equiv="refresh" content="3"></head>
    <body style="font-family:sans-serif;text-align:center;padding:60px;">
      <h2>⏳ Starting up...</h2><p>Page refreshes automatically.</p>
    </body></html>`);
  }
  try {
    const qrImageUrl = await QRCode.toDataURL(latestQR, { width: 400, margin: 2 });
    res.end(`<html><head><meta http-equiv="refresh" content="25"></head>
    <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0;">
      <h2>📱 Scan with WhatsApp Business</h2>
      <p>Open WhatsApp Business → Linked Devices → Link a Device</p>
      <div style="background:white;display:inline-block;padding:20px;border-radius:16px;">
        <img src="${qrImageUrl}" style="width:350px;height:350px;display:block;" />
      </div>
      <p style="color:#888;font-size:14px;margin-top:16px;">Refreshes every 25 seconds.</p>
    </body></html>`);
  } catch (err) {
    res.end(`<html><body><p>Error: ${err.message}</p></body></html>`);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server listening on 0.0.0.0:${PORT}`);
  console.log(`📋 Clock-in form: ${APP_URL}/clockin\n`);
});

// ── WhatsApp Client ────────────────────────────────────────────────────────
let whatsappReady = false;

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'whatsapp-agent' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-zygote', '--single-process'],
  },
});

async function notifyOwner(message) {
  if (!PERSONAL_NUMBER || !whatsappReady) return;
  try {
    await client.sendMessage(`${PERSONAL_NUMBER}@c.us`, message);
  } catch (err) {
    console.error('Could not notify owner:', err.message);
  }
}

client.on('qr', (qr) => {
  latestQR = qr;
  console.log('📱 QR code ready — open your Railway app URL to scan');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => { latestQR = null; console.log('✅ Authenticated'); });

client.on('ready', async () => {
  isReady = true;
  whatsappReady = true;
  console.log('🤖 WhatsApp Agent is ready!');
  console.log(`   Personal number : ${PERSONAL_NUMBER}`);
  console.log(`   Clock-in URL    : ${APP_URL}/clockin\n`);
  await initScheduler(client, APP_URL);
});

client.on('auth_failure', (msg) => console.error('❌ Auth failed:', msg));
client.on('disconnected', (reason) => { isReady = false; whatsappReady = false; console.warn('⚠️ Disconnected:', reason); });

// ── Message handler ────────────────────────────────────────────────────────
client.on('message', async (msg) => {
  try {
    const contact = await msg.getContact();
    const senderNumber = contact.number;

    // ── Timesheet group handler ──────────────────────────────────────────
    const chat = await msg.getChat();
    if (chat.isGroup && chat.name === TIMESHEET_GROUP) {
      const body = msg.body.trim().toLowerCase();
      const period = body.includes('today') ? 'today'
        : body.includes('week') ? 'week'
        : body.includes('month') ? 'month'
        : null;

      if (!period) return; // ignore non-hours messages in the group

      // Format sender number to match stored phone
      let phone = senderNumber;
      if (!phone.startsWith('0') && !phone.startsWith('+')) phone = '+' + phone;

      const report = getHoursForPhone(senderNumber, period);
      const name = getNameFromPhone(senderNumber) || contact.pushname || 'there';

      // Reply privately to the sender — not in the group
      await client.sendMessage(`${senderNumber}@c.us`, report);

      // Send a brief acknowledgement in the group so others know it was received
      await msg.reply(`✅ Sent your hours privately, ${name.split(' ')[0]}!`);
      return;
    }

    // ── Personal number only beyond this point ───────────────────────────
    if (PERSONAL_NUMBER && senderNumber !== PERSONAL_NUMBER) return;

    const body = msg.body.trim();
    if (!body) return;
    console.log(`\n📩 Message: ${body}`);
    await msg.reply('⏳ On it...');
    const reply = await handleCommand(body, client, APP_URL);
    await msg.reply(reply);
  } catch (err) {
    console.error('Error:', err);
    await msg.reply('❌ Something went wrong. Check the server logs.');
  }
});

client.initialize();
