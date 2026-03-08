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

// ── QR state ──────────────────────────────────────────────────────────────
let latestQR = null;
let isReady = false;

// ── HTTP Server (serves scannable QR code page) ───────────────────────────
const server = http.createServer(async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });

  if (isReady) {
    return res.end(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f0f0;">
        <h1 style="color:green;">✅ WhatsApp Agent is Running</h1>
        <p>The agent is authenticated and ready.</p>
        <p>Message your business number from your personal phone to use it.</p>
      </body></html>
    `);
  }

  if (!latestQR) {
    return res.end(`
      <html><head><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f0f0;">
        <h2>⏳ Starting up...</h2>
        <p>Waiting for QR code to be generated. This page will refresh automatically.</p>
      </body></html>
    `);
  }

  try {
    const qrImageUrl = await QRCode.toDataURL(latestQR, { width: 400, margin: 2 });
    res.end(`
      <html>
      <head><meta http-equiv="refresh" content="25"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0;">
        <h2>📱 Scan with WhatsApp Business</h2>
        <p>Open <strong>WhatsApp Business</strong> → Linked Devices → Link a Device → scan below</p>
        <div style="background:white;display:inline-block;padding:20px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.15);">
          <img src="${qrImageUrl}" style="width:350px;height:350px;display:block;" />
        </div>
        <p style="color:#888;margin-top:20px;font-size:14px;">⏱ Page refreshes every 25 seconds. QR codes expire after ~20 seconds.</p>
      </body></html>
    `);
  } catch (err) {
    res.end(`<html><body><p>Error generating QR: ${err.message}</p></body></html>`);
  }
});

// ⚠️ Must bind to 0.0.0.0 for Railway to route traffic correctly
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 QR server listening on 0.0.0.0:${PORT}`);
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

client.on('qr', (qr) => {
  latestQR = qr;
  console.log('📱 QR code ready — open your Railway app URL in a browser to scan it');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  latestQR = null;
  console.log('✅ WhatsApp Business authenticated');
});

client.on('ready', async () => {
  isReady = true;
  console.log('🤖 WhatsApp Agent is ready!\n');
  console.log(`   Listening from : ${PERSONAL_NUMBER || '(not set — accepting ALL messages)'}\n`);
  await initScheduler(client);
});

client.on('auth_failure', (msg) => console.error('❌ Auth failed:', msg));
client.on('disconnected', (reason) => {
  isReady = false;
  console.warn('⚠️  Disconnected:', reason);
});

// ── Message handler ────────────────────────────────────────────────────────
client.on('message', async (msg) => {
  try {
    const contact = await msg.getContact();
    const senderNumber = contact.number;
    if (PERSONAL_NUMBER && senderNumber !== PERSONAL_NUMBER) return;
    const body = msg.body.trim();
    if (!body) return;
    console.log(`\n📩 Message: ${body}`);
    await msg.reply('⏳ On it...');
    const reply = await handleCommand(body, client);
    await msg.reply(reply);
  } catch (err) {
    console.error('Error handling message:', err);
    await msg.reply('❌ Something went wrong. Check the server logs.');
  }
});

client.initialize();
