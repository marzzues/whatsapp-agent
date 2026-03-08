// tasks.js — Task storage and reminder scheduling
const Database = require('better-sqlite3');
const cron = require('node-cron');
const path = require('path');
const { format, isValid } = require('date-fns');

const DB_PATH = path.join(__dirname, 'tasks.db');
const db = new Database(DB_PATH);

// ─── Schema ────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   TEXT    NOT NULL,
    title     TEXT    NOT NULL,
    due_at    INTEGER,          -- Unix timestamp (ms), null = no due date
    done      INTEGER DEFAULT 0,
    reminded  INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );
`);

// ─── CRUD ──────────────────────────────────────────────────────────────────
function addTask(userId, title, dueAt = null) {
  const stmt = db.prepare(
    'INSERT INTO tasks (user_id, title, due_at) VALUES (?, ?, ?)'
  );
  const info = stmt.run(userId, title, dueAt);
  return getTask(info.lastInsertRowid);
}

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function listTasks(userId, includeDone = false) {
  const sql = includeDone
    ? 'SELECT * FROM tasks WHERE user_id = ? ORDER BY due_at ASC, id ASC'
    : 'SELECT * FROM tasks WHERE user_id = ? AND done = 0 ORDER BY due_at ASC, id ASC';
  return db.prepare(sql).all(userId);
}

function completeTask(userId, id) {
  const info = db.prepare(
    'UPDATE tasks SET done = 1 WHERE id = ? AND user_id = ?'
  ).run(id, userId);
  return info.changes > 0;
}

function deleteTask(userId, id) {
  const info = db.prepare(
    'DELETE FROM tasks WHERE id = ? AND user_id = ?'
  ).run(id, userId);
  return info.changes > 0;
}

function getPendingReminders() {
  const now = Date.now();
  return db.prepare(`
    SELECT * FROM tasks
    WHERE due_at IS NOT NULL
      AND done = 0
      AND reminded = 0
      AND due_at <= ?
  `).all(now);
}

function markReminded(id) {
  db.prepare('UPDATE tasks SET reminded = 1 WHERE id = ?').run(id);
}

// ─── Formatting helpers ────────────────────────────────────────────────────
function formatTask(task, index) {
  const statusIcon = task.done ? '✅' : '⬜';
  const due = task.due_at
    ? `  ⏰ ${format(new Date(task.due_at), 'MMM d, yyyy h:mm a')}`
    : '';
  const num = index !== undefined ? `${index + 1}. ` : `#${task.id} `;
  return `${statusIcon} ${num}${task.title}${due}`;
}

function formatTaskList(tasks) {
  if (tasks.length === 0) return '📭 No tasks found.';
  return tasks.map((t, i) => formatTask(t, i)).join('\n');
}

// ─── Reminder scheduler (runs every minute) ───────────────────────────────
let reminderCallback = null;

function setReminderCallback(fn) {
  reminderCallback = fn;
}

cron.schedule('* * * * *', () => {
  if (!reminderCallback) return;
  const due = getPendingReminders();
  for (const task of due) {
    markReminded(task.id);
    reminderCallback(task);
  }
});

module.exports = {
  addTask,
  getTask,
  listTasks,
  completeTask,
  deleteTask,
  formatTaskList,
  formatTask,
  setReminderCallback,
};
