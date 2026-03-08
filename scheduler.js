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
  });

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
async function initScheduler(whatsappClient) {
  schedules = loadSchedulesFromFile();
  console.log(`📅 Loading ${schedules.length} schedule(s) from schedules.json...`);

  for (const schedule of schedules) {
    startJob(schedule, whatsappClient);
  }

  if (schedules.length === 0) {
    console.log('   (No schedules configured yet)');
  }
}

module.exports = { initScheduler, addSchedule, removeSchedule, getSchedules };
