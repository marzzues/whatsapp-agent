// index.js — WhatsApp AI Agent entry point
//
// Setup:
//   - This agent runs ON your WhatsApp Business number
//   - You control it FROM your personal number
//   - Set PERSONAL_NUMBER in .env to your personal number (digits only)
//   - The agent ignores all messages except those from your personal number

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { handleCommand } = require('./agent');
const { initScheduler } = require('./scheduler');

// ── Config ────────────────────────────────────────────────────────────────
// Your personal number — the ONLY number the agent will listen to
const PERSONAL_NUMBER = process.env.PERSONAL_NUMBER;

// ── WhatsApp Client (runs as your Business number) ────────────────────────
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

// ── QR Code — scan with your WhatsApp BUSINESS app ────────────────────────
client.on('qr', (qr) => {
  console.log('\n📱 Scan this QR code with your WhatsApp BUSINESS app:\n');
  console.log('   WhatsApp Business → Linked Devices → Link a Device\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('✅ WhatsApp Business authenticated'));
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

    // Only accept messages from your personal number
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
