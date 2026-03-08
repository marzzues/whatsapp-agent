// Timezone: Australia/Perth (AWST, UTC+8)
// scheduler.js — Cron-based message scheduler
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { sendToAllGroups, sendToGroups } = require('./whatsapp-helpers');

const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');

// ── Load / Save schedule config ────────────────────────────────────────────
function loadSchedulesFromFile() {
  if (!fs.existsSync(SCHEDULES_FILE)) {
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify([], null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveSchedulesToFile(schedules) {
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
}

// ── In-memory state ────────────────────────────────────────────────────────
let activeJobs = {};   // label → cron.ScheduledTask
let schedules  = [];   // current schedule list

function getSchedules() {
  return schedules;
}

// ── Start a single schedule ────────────────────────────────────────────────
function startJob(schedule, whatsappClient) {
  if (!cron.validate(schedule.cron)) {
    console.error(`❌ Invalid cron for "${schedule.label}": ${schedule.cron}`);
    return false;
  }

  if (activeJobs[schedule.label]) {
    activeJobs[schedule.label].stop();
  }

  console.log(`⏰ Scheduling "${schedule.label}" → ${schedule.cron}`);

  activeJobs[schedule.label] = cron.schedule(schedule.cron, async () => {
    console.log(`\n🚀 Running scheduled job: "${schedule.label}"`);
    try {
      if (schedule.target === 'all_groups') {
        await sendToAllGroups(whatsappClient, schedule.message);
      } else if (schedule.target === 'specific_groups') {
        await sendToGroups(whatsappClient, schedule.message, schedule.group_names || []);
      }
    } catch (err) {
      console.error(`❌ Job "${schedule.label}" failed:`, err.message);
    }
  }, { timezone: 'Australia/Perth' });

  return true;
}

// ── Add a schedule (from chat command) ────────────────────────────────────
function addSchedule(schedule, whatsappClient) {
  if (!cron.validate(schedule.cron)) {
    return { success: false, error: `Invalid cron expression: "${schedule.cron}"` };
  }

  // Remove any existing schedule with the same label
  schedules = schedules.filter((s) => s.label !== schedule.label);
  if (activeJobs[schedule.label]) {
    activeJobs[schedule.label].stop();
    delete activeJobs[schedule.label];
  }

  schedules.push(schedule);
  saveSchedulesToFile(schedules);
  startJob(schedule, whatsappClient);

  return { success: true };
}

// ── Remove a schedule ──────────────────────────────────────────────────────
function removeSchedule(label) {
  const before = schedules.length;
  schedules = schedules.filter((s) => s.label !== label);

  if (schedules.length === before) {
    return { success: false };
  }

  if (activeJobs[label]) {
    activeJobs[label].stop();
    delete activeJobs[label];
  }

  saveSchedulesToFile(schedules);
  return { success: true };
}

// ── Boot: load schedules from file and start all jobs ──────────────────────
async function initScheduler(whatsappClient, appUrl) {
  // Store app URL for use in clock-in messages
  global.APP_URL = appUrl || process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'http://localhost:3000';
  schedules = loadSchedulesFromFile();
  console.log(`📅 Loading ${schedules.length} schedule(s) from schedules.json...`);

  for (const schedule of schedules) {
    startJob(schedule, whatsappClient);
  }

  if (schedules.length === 0) {
    console.log('   (No schedules configured yet)');
  }

  // ── Built-in: Morning clock-in reminder (Mon-Fri 8am Perth) ──────────
  const { getTodayAttendance, formatDailyReport } = require('./clockin');

  cron.schedule('0 8 * * 1-5', async () => {
    const url = global.APP_URL + '/clockin';
    const message = `🌅 Good morning team!\n\nPlease clock in for today:\n👉 ${url}\n\nHave a great day! 😊`;
    console.log('\n⏰ Sending morning clock-in reminder...');
    try {
      const chats = await whatsappClient.getChats();
      const groups = chats.filter(c => c.isGroup);
      for (const group of groups) {
        await whatsappClient.sendMessage(group.id._serialized, message);
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (err) {
      console.error('Morning reminder failed:', err.message);
    }
  }, { timezone: 'Australia/Perth' });

  // ── Built-in: Afternoon clock-out reminder (Mon-Fri 4:30pm Perth) ────
  // Sends personalised WhatsApp messages to staff who haven't clocked out yet
  cron.schedule('30 16 * * 1-5', async () => {
    const { getStillClockedIn } = require('./clockin');
    const url = global.APP_URL + '/clockin';
    console.log('\n⏰ Sending personalised clock-out reminders...');
    try {
      const stillIn = getStillClockedIn();

      if (!stillIn.length) {
        console.log('   Everyone has already clocked out.');
        return;
      }

      for (const staff of stillIn) {
        if (!staff.phone) continue;

        // Normalise AU mobile to WhatsApp format (61XXXXXXXXX)
        let phone = staff.phone.replace(/\s+/g, '').replace(/^\+/, '');
        if (phone.startsWith('0')) phone = '61' + phone.slice(1);

        const message = `Hi ${staff.name}! 👋\n\nThis is a reminder that you haven't clocked out yet today.\n\nTap the link to clock out — you can enter your actual finish time if you've already left:\n\n👉 ${url}\n\nThanks! 😊`;

        try {
          await whatsappClient.sendMessage(`${phone}@c.us`, message);
          console.log(`   ✅ Reminded ${staff.name} (${phone})`);
          await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
          console.error(`   ❌ Could not message ${staff.name} (${phone}):`, err.message);
        }
      }
    } catch (err) {
      console.error('Clock-out reminder failed:', err.message);
    }
  }, { timezone: 'Australia/Perth' });

  // ── Built-in: Daily attendance report to owner (Mon-Fri 6pm Perth) ───
  cron.schedule('0 18 * * 1-5', async () => {
    if (!process.env.PERSONAL_NUMBER) return;
    console.log('\n📊 Sending daily attendance report...');
    try {
      const records = getTodayAttendance();
      const report = formatDailyReport(records);
      await whatsappClient.sendMessage(`${process.env.PERSONAL_NUMBER}@c.us`, report);
    } catch (err) {
      console.error('Daily report failed:', err.message);
    }
  }, { timezone: 'Australia/Perth' });

  console.log('✅ Built-in schedules: clock-in reminder (8am), clock-out reminder (4:30pm), daily report (6pm) — Mon-Fri Perth time');
}

module.exports = { initScheduler, addSchedule, removeSchedule, getSchedules };
