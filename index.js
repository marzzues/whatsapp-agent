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
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&family=DM+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --green: #00C48C;
    --red: #FF5A5F;
    --orange: #FF9500;
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
    animation: fadeUp 0.4s ease;
  }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(16px); }
    to { opacity: 1; transform: translateY(0); }
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

  h1 { font-size: 22px; font-weight: 600; margin-bottom: 6px; }
  .subtitle { color: var(--muted); font-size: 14px; margin-bottom: 32px; }

  .time-display {
    font-family: 'DM Mono', monospace;
    font-size: 36px;
    font-weight: 500;
    color: var(--green);
    margin-bottom: 4px;
    letter-spacing: -0.02em;
  }

  .date-display { font-size: 13px; color: var(--muted); margin-bottom: 32px; }

  label.field-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 20px;
  }

  .field-row .field { margin-bottom: 0; }

  .field { margin-bottom: 20px; }

  input[type="text"],
  input[type="tel"],
  input[type="time"] {
    width: 100%;
    background: var(--dark);
    border: 1.5px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    font-size: 16px;
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  input[type="text"]:focus,
  input[type="tel"]:focus,
  input[type="time"]:focus {
    border-color: var(--green);
    box-shadow: 0 0 0 3px rgba(0,196,140,0.12);
  }

  input::placeholder { color: var(--muted); }

  select {
    width: 100%;
    background: var(--dark);
    border: 1.5px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    font-size: 16px;
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236B7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 16px center;
    cursor: pointer;
    margin-bottom: 0;
  }

  select:focus {
    border-color: var(--green);
    box-shadow: 0 0 0 3px rgba(0,196,140,0.12);
  }

  select option {
    background: #1A1D27;
    color: var(--text);
  }

  /* Style the time input */
  input[type="time"]::-webkit-calendar-picker-indicator {
    filter: invert(0.5);
    cursor: pointer;
  }

  /* Late clock-out panel */
  .late-panel {
    display: none;
    background: rgba(255,149,0,0.07);
    border: 1.5px solid rgba(255,149,0,0.3);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 20px;
    animation: fadeIn 0.25s ease;
  }

  .late-panel.visible { display: block; }

  .late-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }

  .late-icon {
    width: 28px;
    height: 28px;
    background: rgba(255,149,0,0.15);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
  }

  .late-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--orange);
  }

  .late-desc {
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 12px;
  }

  /* Fit for work checkbox */
  .fit-box {
    background: var(--dark);
    border: 1.5px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 20px;
    cursor: pointer;
    transition: border-color 0.2s, box-shadow 0.2s;
    display: flex;
    align-items: flex-start;
    gap: 14px;
    user-select: none;
  }

  .fit-box:hover { border-color: var(--green); }

  .fit-box.checked {
    border-color: var(--green);
    background: rgba(0,196,140,0.06);
    box-shadow: 0 0 0 3px rgba(0,196,140,0.12);
  }

  .fit-box.shake {
    animation: shake 0.35s ease;
    border-color: var(--red) !important;
    box-shadow: 0 0 0 3px rgba(255,90,95,0.15) !important;
  }

  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-6px); }
    40% { transform: translateX(6px); }
    60% { transform: translateX(-4px); }
    80% { transform: translateX(4px); }
  }

  .custom-checkbox {
    width: 22px;
    height: 22px;
    min-width: 22px;
    border-radius: 6px;
    border: 2px solid var(--border);
    background: var(--card);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    margin-top: 1px;
  }

  .fit-box.checked .custom-checkbox {
    background: var(--green);
    border-color: var(--green);
  }

  .checkmark {
    opacity: 0;
    transform: scale(0);
    transition: all 0.15s ease;
    color: #000;
    font-size: 13px;
    font-weight: 700;
  }

  .fit-box.checked .checkmark { opacity: 1; transform: scale(1); }

  .fit-text { flex: 1; }
  .fit-title { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 3px; }
  .fit-desc { font-size: 12px; color: var(--muted); line-height: 1.5; }

  .btn-group { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

  button {
    padding: 15px;
    border: none;
    border-radius: 12px;
    font-size: 15px;
    font-weight: 600;
    font-family: 'DM Sans', sans-serif;
    cursor: pointer;
    transition: transform 0.1s, opacity 0.15s, box-shadow 0.15s;
  }

  button:hover { opacity: 0.9; box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
  button:active { transform: scale(0.97); }

  .btn-in { background: var(--green); color: #000; }
  .btn-out { background: transparent; color: var(--red); border: 1.5px solid var(--red); }

  .result {
    display: none;
    margin-top: 20px;
    padding: 16px;
    border-radius: 12px;
    font-size: 14px;
    font-weight: 500;
    text-align: center;
    animation: fadeIn 0.3s ease;
  }

  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .result.success { background: rgba(0,196,140,0.12); color: var(--green); border: 1px solid rgba(0,196,140,0.25); }
  .result.error { background: rgba(255,90,95,0.12); color: var(--red); border: 1px solid rgba(255,90,95,0.25); }

  .field { margin-bottom: 20px; }

  .already-banner {
    display: none;
    background: rgba(0,196,140,0.08);
    border: 1.5px solid rgba(0,196,140,0.3);
    border-radius: 12px;
    padding: 14px 16px;
    margin-bottom: 20px;
    align-items: center;
    gap: 12px;
    animation: fadeIn 0.3s ease;
  }
  .already-banner.visible { display: flex; }
  .already-icon { font-size: 22px; color: var(--green); }
  .already-title { font-size: 14px; font-weight: 600; color: var(--green); margin-bottom: 2px; }
  .already-sub { font-size: 12px; color: var(--muted); }
  .btn-in:disabled { opacity: 0.35; cursor: not-allowed; box-shadow: none !important; }

  .divider { height: 1px; background: var(--border); margin: 28px 0; }
  .footer { font-size: 12px; color: var(--muted); text-align: center; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">⏱</div>
  <h1>Staff Attendance</h1>
  <p class="subtitle">Record your clock in and clock out times</p>

  <div class="time-display" id="clock">--:--:--</div>
  <div class="date-display" id="dateDisplay"></div>

  <!-- Name + Phone in a row -->
  <div class="field-row">
    <div class="field">
      <label class="field-label">Full Name</label>
      <input type="text" id="nameInput" placeholder="John Smith" autocomplete="off" oninput="onNameInput(this)" list="staffList" />
  <datalist id="staffList"></datalist>
    </div>
    <div class="field">
      <label class="field-label">Mobile Number</label>
      <input type="tel" id="phoneInput" placeholder="04XX XXX XXX" autocomplete="tel" oninput="this.dataset.manuallyEdited = this.value ? '1' : ''" />
    <p style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.4;">Please ensure you enter your WhatsApp number with area code</p>
    </div>
  </div>

  <!-- Project dropdown -->
  <div class="field">
    <label class="field-label">Project</label>
    <select id="projectInput">
      <option value="">Loading projects...</option>
    </select>
  </div>

  <!-- Late clock-out panel (only shown when clocking out late) -->
  <div class="late-panel" id="latePanel">
    <div class="late-header">
      <div class="late-icon">🕐</div>
      <div class="late-title">Clocking out late?</div>
    </div>
    <div class="late-desc">If you actually finished earlier, enter your real clock-out time below. Otherwise leave it blank to use the current time.</div>
    <label class="field-label">Actual Clock-Out Time</label>
    <input type="time" id="clockOutTime" />
  </div>

  <!-- Fit for Work -->
  <label class="field-label">Declaration</label>
  <div class="fit-box" id="fitBox" onclick="toggleFit()">
    <div class="custom-checkbox">
      <span class="checkmark">✓</span>
    </div>
    <div class="fit-text">
      <div class="fit-title">I am fit for work today</div>
      <div class="fit-desc">I confirm I am in a suitable physical and mental condition to perform my duties safely.</div>
    </div>
  </div>

  <!-- Already clocked in banner -->
  <div class="already-banner" id="alreadyBanner">
    <span class="already-icon">&#10003;</span>
    <div>
      <div class="already-title">Already clocked in today</div>
      <div class="already-sub" id="alreadySub"></div>
    </div>
  </div>

  <div class="btn-group">
    <button class="btn-in" onclick="submit('in')">🟢 Clock In</button>
    <button class="btn-out" onclick="handleClockOut()">🔴 Clock Out</button>
  </div>

  <div class="result" id="result"></div>

  <div class="divider"></div>
  <div class="footer">Perth, Western Australia (AWST)</div>
</div>

<script>
  let fitChecked = false;
  let clockOutPanelVisible = false;
  let knownStaff = []; // populated from server on load

  const LATE_AFTER_HOUR = 17;

  // ── Load known staff from server ──────────────────────────────────────
  async function loadKnownStaff() {
    try {
      const res = await fetch('/staff');
      knownStaff = await res.json();
      const datalist = document.getElementById('staffList');
      datalist.innerHTML = '';
      knownStaff.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.name;
        datalist.appendChild(opt);
      });
    } catch (e) { /* demo mode */ }
  }

  async function loadProjects() {
    const select = document.getElementById('projectInput');
    try {
      const res = await fetch('/projects');
      const projects = await res.json();
      select.innerHTML = '<option value="">Select a project...</option>';
      projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        select.appendChild(opt);
      });
    } catch (e) {
      // Demo mode — seed with example project
      select.innerHTML = '<option value="">Select a project...</option><option value="CoR - Read Street">CoR - Read Street</option>';
    }
  }

  loadKnownStaff();
  loadProjects();

  function capitaliseName(input) {
    const pos = input.selectionStart;
    input.value = input.value.replace(/\b\w/g, c => c.toUpperCase());
    input.setSelectionRange(pos, pos);
  }

  function onNameInput(input) {
    capitaliseName(input);

    // Auto-fill phone if name matches a known staff member
    const match = knownStaff.find(s => s.name.toLowerCase() === input.value.toLowerCase());
    if (match && match.phone) {
      const phoneField = document.getElementById('phoneInput');
      // Only auto-fill if phone field is empty or previously auto-filled
      if (!phoneField.dataset.manuallyEdited) {
        phoneField.value = match.phone;
        phoneField.style.borderColor = 'var(--green)';
        phoneField.style.boxShadow = '0 0 0 3px rgba(0,196,140,0.12)';
        setTimeout(() => {
          phoneField.style.borderColor = '';
          phoneField.style.boxShadow = '';
        }, 1500);
      }
    } else {
      // Clear auto-filled value if name no longer matches
      const phoneField = document.getElementById('phoneInput');
      if (!phoneField.dataset.manuallyEdited) {
        phoneField.value = '';
      }
    }
  }

  function updateClock() {
    const now = new Date();
    const timeOpts = { timeZone: 'Australia/Perth', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true };
    const dateOpts = { timeZone: 'Australia/Perth', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    document.getElementById('clock').textContent = now.toLocaleTimeString('en-AU', timeOpts);
    document.getElementById('dateDisplay').textContent = now.toLocaleDateString('en-AU', dateOpts);
  }
  updateClock();
  setInterval(updateClock, 1000);

  function capitaliseName(input) {
    const pos = input.selectionStart;
    input.value = input.value.replace(/\b\w/g, c => c.toUpperCase());
    input.setSelectionRange(pos, pos);
  }

  function toggleFit() {
    fitChecked = !fitChecked;
    document.getElementById('fitBox').classList.toggle('checked', fitChecked);
    document.getElementById('fitBox').classList.remove('shake');
  }

  function handleClockOut() {
    // Check if it's past the late threshold — show time picker
    const now = new Date();
    const perthHour = parseInt(now.toLocaleString('en-AU', { timeZone: 'Australia/Perth', hour: 'numeric', hour12: false }));

    if (perthHour >= LATE_AFTER_HOUR && !clockOutPanelVisible) {
      const panel = document.getElementById('latePanel');
      panel.classList.add('visible');
      clockOutPanelVisible = true;

      // Pre-fill with current Perth time
      const perthTime = now.toLocaleTimeString('en-AU', { timeZone: 'Australia/Perth', hour: '2-digit', minute: '2-digit', hour12: false });
      document.getElementById('clockOutTime').value = perthTime;

      const resultEl = document.getElementById('result');
      resultEl.className = 'result';
      resultEl.style.display = 'block';
      resultEl.style.background = 'rgba(255,149,0,0.1)';
      resultEl.style.color = '#FF9500';
      resultEl.style.border = '1px solid rgba(255,149,0,0.25)';
      resultEl.textContent = "🕐 It's past 5pm. Enter your actual finish time above if different, then tap Clock Out again.";
      return;
    }

    submit('out');
  }

  function submit(action) {
    const name = document.getElementById('nameInput').value.trim();
    const phone = document.getElementById('phoneInput').value.trim();
    const resultEl = document.getElementById('result');
    const fitBox = document.getElementById('fitBox');

    // Reset result styles
    resultEl.removeAttribute('style');

    if (!name) {
      resultEl.className = 'result error';
      resultEl.style.display = 'block';
      resultEl.textContent = '⚠️ Please enter your name.';
      return;
    }

    if (!phone) {
      resultEl.className = 'result error';
      resultEl.style.display = 'block';
      resultEl.textContent = '⚠️ Please enter your mobile number.';
      return;
    }

    if (action === 'in' && !fitChecked) {
      resultEl.className = 'result error';
      resultEl.style.display = 'block';
      resultEl.textContent = '⚠️ You must confirm you are fit for work before clocking in.';
      fitBox.classList.remove('shake');
      void fitBox.offsetWidth;
      fitBox.classList.add('shake');
      return;
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-AU', { timeZone: 'Australia/Perth', hour: '2-digit', minute: '2-digit', hour12: true });
    const customTime = document.getElementById('clockOutTime').value;

    resultEl.style.display = 'block';
    resultEl.className = 'result success';

    if (action === 'in') {
      resultEl.textContent = \`✅ Clocked in at \${timeStr}. Have a great day, \${name}!\`;
      fitChecked = false;
      fitBox.classList.remove('checked');
    } else {
      const displayTime = customTime || timeStr;
      resultEl.textContent = \`✅ Clocked out at \${displayTime}. See you tomorrow, \${name}!\`;
      document.getElementById('latePanel').classList.remove('visible');
      clockOutPanelVisible = false;
      document.getElementById('clockOutTime').value = '';
    }

    document.getElementById('nameInput').value = '';
    document.getElementById('phoneInput').value = '';
    document.getElementById('projectInput').value = '';
    document.getElementById('phoneInput').dataset.manuallyEdited = '';
    clearAlreadyBanner();
  }
</script>
</body>
</html>
`);

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
