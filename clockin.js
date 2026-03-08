// clockin.js — Clock in/out system with SQLite storage
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'attendance.db');
const db = new Database(DB_PATH);

// ── Schema ─────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS attendance (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    phone           TEXT,
    date            TEXT NOT NULL,
    clock_in        INTEGER,
    clock_out       INTEGER,
    clock_out_time  TEXT,
    hours           REAL,
    fit_for_work    INTEGER DEFAULT 1,
    project         TEXT
  );
`);

// ── Projects table ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE,
    active    INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// Seed default project if table is empty
const projectCount = db.prepare('SELECT COUNT(*) as c FROM projects').get();
if (projectCount.c === 0) {
  db.prepare("INSERT INTO projects (name) VALUES (?)").run('CoR - Read Street');
}

// Migrations for existing databases
try { db.exec(`ALTER TABLE attendance ADD COLUMN clock_out_time TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE attendance ADD COLUMN fit_for_work INTEGER DEFAULT 1`); } catch (e) {}
try { db.exec(`ALTER TABLE attendance ADD COLUMN project TEXT`); } catch (e) {}

// ── Helpers ────────────────────────────────────────────────────────────────
function getPerthDate() {
  return new Date().toLocaleDateString('en-AU', {
    timeZone: 'Australia/Perth',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).split('/').reverse().join('-');
}

function getPerthTime(ts) {
  return new Date(ts).toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Perth',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

function computeHours(clockIn, clockOut) {
  return Math.round((clockOut - clockIn) / 1000 / 60 / 60 * 10) / 10;
}

// Convert "HH:MM" time string (today, Perth) to a Unix timestamp
function timeStringToTimestamp(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const perthDateStr = getPerthDate();
  const ts = new Date(`${perthDateStr}T${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:00+08:00`);
  return ts.getTime();
}

// Format "HH:MM" -> "5:30 PM"
function formatTimeStr(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${ampm}`;
}

// ── Clock In ───────────────────────────────────────────────────────────────
function clockIn(name, phone = null, fitForWork = true, project = null) {
  const date = getPerthDate();
  const now = Date.now();

  const existing = db.prepare(
    'SELECT * FROM attendance WHERE name = ? AND date = ?'
  ).get(name, date);

  if (existing) {
    if (existing.clock_out) {
      return { success: false, message: `${name} has already completed their shift today.` };
    }
    return { success: false, message: `${name} is already clocked in at ${getPerthTime(existing.clock_in)}.` };
  }

  db.prepare(
    'INSERT INTO attendance (name, phone, date, clock_in, fit_for_work, project) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, phone, date, now, fitForWork ? 1 : 0, project);

  return { success: true, time: getPerthTime(now), name, phone };
}

// ── Clock Out ──────────────────────────────────────────────────────────────
function clockOut(name, customTime = null) {
  const date = getPerthDate();
  const now = Date.now();

  const record = db.prepare(
    'SELECT * FROM attendance WHERE name = ? AND date = ? AND clock_out IS NULL'
  ).get(name, date);

  if (!record) {
    return { success: false, message: `No active clock-in found for ${name} today.` };
  }

  const clockOutTs = customTime ? timeStringToTimestamp(customTime) : now;
  const hours = computeHours(record.clock_in, clockOutTs);

  db.prepare(
    'UPDATE attendance SET clock_out = ?, clock_out_time = ?, hours = ? WHERE id = ?'
  ).run(clockOutTs, customTime || null, hours, record.id);

  const displayTime = customTime ? formatTimeStr(customTime) : getPerthTime(now);

  return {
    success: true,
    time: displayTime,
    name,
    hours,
    clockInTime: getPerthTime(record.clock_in),
    wasLate: !!customTime,
  };
}

// ── Get staff still clocked in (with phone numbers) ───────────────────────
function getStillClockedIn() {
  const date = getPerthDate();
  return db.prepare(
    'SELECT * FROM attendance WHERE date = ? AND clock_out IS NULL'
  ).all(date);
}

// ── Get today's attendance ─────────────────────────────────────────────────
function getTodayAttendance() {
  const date = getPerthDate();
  return db.prepare(
    'SELECT * FROM attendance WHERE date = ? ORDER BY clock_in ASC'
  ).all(date);
}

// ── Get attendance for a specific date ────────────────────────────────────
function getAttendanceByDate(date) {
  return db.prepare(
    'SELECT * FROM attendance WHERE date = ? ORDER BY clock_in ASC'
  ).all(date);
}

// ── Format daily report ────────────────────────────────────────────────────
function formatDailyReport(records) {
  if (!records.length) return '📭 No attendance records for today.';

  const date = getPerthDate();
  const clockedIn = records.filter(r => !r.clock_out);
  const completed = records.filter(r => r.clock_out);

  let report = `📊 *Attendance Report — ${date}*\n\n`;

  if (completed.length) {
    report += `✅ *Completed shifts (${completed.length}):*\n`;
    report += completed.map(r => {
      const outTime = r.clock_out_time
        ? formatTimeStr(r.clock_out_time) + ' _(manual)_'
        : getPerthTime(r.clock_out);
      return `• ${r.name}${r.project ? ' [' + r.project + ']' : ''}: ${getPerthTime(r.clock_in)} → ${outTime} (${r.hours}h)`;
    }).join('\n');
    report += '\n\n';
  }

  if (clockedIn.length) {
    report += `⏳ *Still clocked in (${clockedIn.length}):*\n`;
    report += clockedIn.map(r =>
      `• ${r.name}${r.project ? ' [' + r.project + ']' : ''}: in at ${getPerthTime(r.clock_in)}${r.phone ? ' 📱 ' + r.phone : ''}`
    ).join('\n');
  }

  const totalHours = completed.reduce((sum, r) => sum + (r.hours || 0), 0);
  if (completed.length) {
    report += `\n\n⏱ *Total hours worked: ${Math.round(totalHours * 10) / 10}h*`;
  }

  return report;
}

module.exports = {
  getHoursForPhone,
  getNameFromPhone,
  getProjects,
  addProject,
  removeProject,
  getTodayStatusForName,
  getKnownStaff,
  clockIn,
  clockOut,
  getTodayAttendance,
  getAttendanceByDate,
  getStillClockedIn,
  formatDailyReport,
  getPerthDate,
  getPerthTime,
};


// ── Check if a name has already clocked in today ──────────────────────────
function getTodayStatusForName(name) {
  const date = getPerthDate();
  const record = db.prepare(
    'SELECT * FROM attendance WHERE name = ? AND date = ?'
  ).get(name, date);
  if (!record) return null;
  return {
    clockedIn: true,
    clockedOut: !!record.clock_out,
    clockInTime: getPerthTime(record.clock_in),
    clockOutTime: record.clock_out ? getPerthTime(record.clock_out) : null,
    project: record.project,
  };
}


// ── Project functions ──────────────────────────────────────────────────────
function getProjects(activeOnly = true) {
  return activeOnly
    ? db.prepare('SELECT * FROM projects WHERE active = 1 ORDER BY name ASC').all()
    : db.prepare('SELECT * FROM projects ORDER BY active DESC, name ASC').all();
}

function addProject(name) {
  try {
    db.prepare('INSERT INTO projects (name) VALUES (?)').run(name.trim());
    return { success: true, name: name.trim() };
  } catch (e) {
    if (e.message.includes('UNIQUE')) return { success: false, message: `"${name}" already exists.` };
    throw e;
  }
}

function removeProject(name) {
  const result = db.prepare('UPDATE projects SET active = 0 WHERE name = ?').run(name.trim());
  return result.changes > 0
    ? { success: true }
    : { success: false, message: `Project "${name}" not found.` };
}


// ── Hours query functions ──────────────────────────────────────────────────

function getRecordsForPhone(phone, fromDate, toDate) {
  // Normalise phone to match stored format
  let p = phone.replace(/\s+/g, '').replace(/^\+/, '');
  if (p.startsWith('61')) p = '0' + p.slice(2); // 61412345678 -> 0412345678

  return db.prepare(`
    SELECT * FROM attendance
    WHERE (phone = ? OR phone = ?)
      AND date >= ? AND date <= ?
      AND clock_out IS NOT NULL
    ORDER BY date ASC
  `).all(phone, p, fromDate, toDate);
}

function getPerthDateOffset(daysOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d.toLocaleDateString('en-AU', {
    timeZone: 'Australia/Perth',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).split('/').reverse().join('-');
}

function getWeekBounds() {
  // Week starts Monday
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Perth' }));
  const day = now.getDay(); // 0=Sun
  const diffToMon = (day === 0) ? -6 : 1 - day;
  const mon = new Date(now); mon.setDate(now.getDate() + diffToMon);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const fmt = d => d.toLocaleDateString('en-AU', { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-');
  return { start: fmt(mon), end: fmt(sun) };
}

function getMonthBounds() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Perth' }));
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
  return { start: `${year}-${month}-01`, end: `${year}-${month}-${lastDay}` };
}

function formatHoursReport(records, label, name) {
  if (!records.length) return `📭 No completed shifts found for ${label}.`;

  const totalHours = records.reduce((sum, r) => sum + (r.hours || 0), 0);

  let msg = `📊 *${name} — ${label}*

`;
  msg += records.map(r => {
    const outTime = r.clock_out_time
      ? formatTimeStr(r.clock_out_time) + ' _(manual)_'
      : getPerthTime(r.clock_out);
    return `📅 *${r.date}*${r.project ? ' · ' + r.project : ''}
   ${getPerthTime(r.clock_in)} → ${outTime} · *${r.hours}h*`;
  }).join('

');

  msg += `

⏱ *Total: ${Math.round(totalHours * 10) / 10}h*`;
  return msg;
}

function getHoursForPhone(phone, period) {
  const today = getPerthDate();

  if (period === 'today') {
    const records = getRecordsForPhone(phone, today, today);
    return formatHoursReport(records, 'Today', 'Your hours');
  }

  if (period === 'week') {
    const { start, end } = getWeekBounds();
    const records = getRecordsForPhone(phone, start, end);
    return formatHoursReport(records, `This week (${start} – ${end})`, 'Your hours');
  }

  if (period === 'month') {
    const { start, end } = getMonthBounds();
    const records = getRecordsForPhone(phone, start, end);
    return formatHoursReport(records, `This month (${start} – ${end})`, 'Your hours');
  }

  return null;
}

// Look up a name from phone number (most recent record)
function getNameFromPhone(phone) {
  let p = phone.replace(/\s+/g, '').replace(/^\+/, '');
  if (p.startsWith('61')) p = '0' + p.slice(2);
  const record = db.prepare(`
    SELECT name FROM attendance WHERE phone = ? OR phone = ?
    ORDER BY clock_in DESC LIMIT 1
  `).get(phone, p);
  return record ? record.name : null;
}

// ── Get known staff (distinct name + most recent phone) ───────────────────
function getKnownStaff() {
  return db.prepare(`
    SELECT name, phone
    FROM attendance
    WHERE phone IS NOT NULL AND phone != ''
    GROUP BY name
    ORDER BY MAX(clock_in) DESC
  `).all();
}
