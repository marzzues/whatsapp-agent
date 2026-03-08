// index.js — WhatsApp AI Agent entry point
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');
const { handleCommand } = require('./agent');
const { initScheduler } = require('./scheduler');

// ── Config ────────────────────────────────────────────────────────────────
const PERSONAL_NUMBER = process.env.PERSONAL_NUMBER;
const PORT = process.env.PORT || 3000;

// ── QR Code web server ────────────────────────────────────────────────────
// Serves the QR code as a scannable image at http://your-app-url/
let latestQR = null;

const server = http.createServer(async (req, res) => {
  if (req.url === '/') {
    if (!latestQR) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px;">
          <h2>WhatsApp Agent</h2>
          <p>✅ Already authenticated — no QR code needed.</p>
          <p>The agent is running. Message your business number from your personal phone to use it.</p>
        </body></html>
      `);
    } else {
      const qrImageUrl = await QRCode.toDataURL(latestQR);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5;">
          <h2>📱 Scan with WhatsApp Business</h2>
          <p>Open <strong>WhatsApp Business</strong> → Linked Devices → Link a Device</p>
          <img src="${qrImageUrl}" style="width:300px;height:300px;border:8px solid white;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.15);" />
          <p style="color:#888;font-size:14px;">Page auto-refreshes every 30 seconds. QR codes expire after ~20 seconds.</p>
          <script>setTimeout(() => location.reload(), 30000);</script>
        </body></html>
      `);
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n🌐 QR Code server running on port ${PORT}`);
  console.log(`   Open your Railway app URL in a browser to scan the QR code\n`);
});

// ── WhatsApp Client ────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'whatsapp-agent' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  },
});

// ── QR Code ────────────────────────────────────────────────────────────────
client.on('qr', (qr) => {
  latestQR = qr;
  console.log('📱 New QR code generated — open your Railway app URL in a browser to scan it');
  qrcode.generate(qr, { small: true }); // also log it as fallback
});

client.on('authenticated', () => {
  latestQR = null; // clear QR once authenticated
  console.log('✅ WhatsApp Business authenticated');
});

client.on('ready', async () => {
  console.log('🤖 WhatsApp Agent is ready!\n');
  console.log(`   Listening for commands from : ${PERSONAL_NUMBER || '(not set — accepting ALL messages)'}`);
  console.log(`   Tip: Message your business number from your personal phone\n`);
  await initScheduler(client);
});

client.on('auth_failure', (msg) => console.error('❌ Auth failed:', msg));
client.on('disconnected', (reason) => console.warn('⚠️  Disconnected:', reason));

// ── Message handler ────────────────────────────────────────────────────────
client.on('message', async (msg) => {
  try {
    const contact = await msg.getContact();
    const senderNumber = contact.number;

    if (PERSONAL_NUMBER && senderNumber !== PERSONAL_NUMBER) return;

    const body = msg.body.trim();
    if (!body) return;

    console.log(`\n📩 Command from personal number: ${body}`);
    await msg.reply('⏳ On it...');

    const reply = await handleCommand(body, client);
    await msg.reply(reply);

  } catch (err) {
    console.error('Error handling message:', err);
    await msg.reply('❌ Something went wrong. Check the server logs.');
  }
});

client.initialize();
