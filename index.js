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

// ── Health tracking ────────────────────────────────────────────────────────
let botStartTime = Date.now();
let lastMessageTs = null;
let disconnectAlertSent = false;

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

  // ── Health check endpoint ────────────────────────────────────────────────
  if (url.pathname === '/health') {
    const uptimeSecs = Math.floor((Date.now() - botStartTime) / 1000);
    const status = {
      status: isReady ? 'ok' : 'degraded',
      whatsapp: isReady ? 'connected' : 'disconnected',
      uptime_seconds: uptimeSecs,
      last_message: lastMessageTs ? new Date(lastMessageTs).toISOString() : null,
      timestamp: new Date().toISOString(),
    };
    res.writeHead(isReady ? 200 : 503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(status));
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

            // Post clock-in to Timesheet Bot group
            if (action === 'in') {
              const groupMsg = `🟢 *${name}* clocked in at *${result.time}*${project ? `\n📋 ${project}` : ''}`;
              sendToTimesheetBot(groupMsg);
            }
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
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600&family=DM+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --green: #00C48C; --red: #FF5A5F; --orange: #FF9500;
    --dark: #0F1117; --card: #1A1D27; --border: #2A2D3A;
    --text: #E8EAF0; --muted: #6B7280;
  }
  body {
    background: var(--dark); color: var(--text);
    font-family: 'DM Sans', sans-serif;
    min-height: 100vh; display: flex;
    align-items: center; justify-content: center; padding: 24px;
  }
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 20px; padding: 40px; width: 100%; max-width: 420px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.4);
  }
  .logo { width: 48px; height: 48px; background: var(--green); border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px; margin-bottom: 24px; }
  h1 { font-size: 22px; font-weight: 600; margin-bottom: 6px; }
  .subtitle { color: var(--muted); font-size: 14px; margin-bottom: 28px; }
  .live-clock { font-family: 'DM Mono', monospace; font-size: 34px; font-weight: 500; color: var(--green); letter-spacing: -0.02em; margin-bottom: 4px; }
  .live-date { font-size: 13px; color: var(--muted); margin-bottom: 28px; }

  label.lbl { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.08em; }
  .field { margin-bottom: 18px; }
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 18px; }
  .field-row .field { margin-bottom: 0; }
  input[type=text], input[type=tel], input[type=time], select {
    width: 100%; background: var(--dark); border: 1.5px solid var(--border);
    border-radius: 12px; padding: 14px 16px; font-size: 16px; color: var(--text);
    font-family: 'DM Sans', sans-serif; outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  input:focus, select:focus { border-color: var(--green); box-shadow: 0 0 0 3px rgba(0,196,140,0.12); }
  input::placeholder { color: var(--muted); }
  select { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236B7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 16px center; cursor: pointer; }
  select option { background: #1A1D27; color: var(--text); }
  input[type=time]::-webkit-calendar-picker-indicator { filter: invert(0.5); cursor: pointer; }
  .hint { font-size: 11px; color: var(--muted); margin-top: 6px; line-height: 1.4; }

  .fit-box { background: var(--dark); border: 1.5px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 18px; cursor: pointer; display: flex; align-items: flex-start; gap: 14px; user-select: none; transition: border-color 0.2s, box-shadow 0.2s; }
  .fit-box:hover { border-color: var(--green); }
  .fit-box.checked { border-color: var(--green); background: rgba(0,196,140,0.06); box-shadow: 0 0 0 3px rgba(0,196,140,0.12); }
  .fit-box.shake { animation: shake 0.35s ease; border-color: var(--red) !important; box-shadow: 0 0 0 3px rgba(255,90,95,0.15) !important; }
  @keyframes shake { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-6px)} 40%{transform:translateX(6px)} 60%{transform:translateX(-4px)} 80%{transform:translateX(4px)} }
  .chkbox { width: 22px; height: 22px; min-width: 22px; border-radius: 6px; border: 2px solid var(--border); background: var(--card); display: flex; align-items: center; justify-content: center; transition: all 0.2s; margin-top: 1px; }
  .fit-box.checked .chkbox { background: var(--green); border-color: var(--green); }
  .chkmark { opacity: 0; transform: scale(0); transition: all 0.15s; color: #000; font-size: 13px; font-weight: 700; }
  .fit-box.checked .chkmark { opacity: 1; transform: scale(1); }
  .fit-title { font-size: 14px; font-weight: 600; margin-bottom: 3px; }
  .fit-desc { font-size: 12px; color: var(--muted); line-height: 1.5; }

  .late-panel { display: none; background: rgba(255,149,0,0.07); border: 1.5px solid rgba(255,149,0,0.3); border-radius: 12px; padding: 16px; margin-bottom: 18px; }
  .late-panel.visible { display: block; }
  .late-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .late-icon { width: 28px; height: 28px; background: rgba(255,149,0,0.15); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; }
  .late-title { font-size: 13px; font-weight: 600; color: var(--orange); }
  .late-desc { font-size: 12px; color: var(--muted); margin-bottom: 12px; }

  .btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  button { padding: 15px; border: none; border-radius: 12px; font-size: 15px; font-weight: 600; font-family: 'DM Sans', sans-serif; cursor: pointer; transition: transform 0.1s, opacity 0.15s, box-shadow 0.15s; }
  button:hover { opacity: 0.9; box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
  button:active { transform: scale(0.97); }
  button:disabled { opacity: 0.35; cursor: not-allowed; box-shadow: none !important; transform: none !important; }
  .btn-in { background: var(--green); color: #000; }
  .btn-out-ghost { background: transparent; color: var(--red); border: 1.5px solid var(--red); }
  .btn-out-full { width: 100%; background: transparent; color: var(--red); border: 1.5px solid var(--red); }

  .msg { display: none; margin-top: 16px; padding: 14px 16px; border-radius: 12px; font-size: 14px; font-weight: 500; text-align: center; }
  .msg.success { background: rgba(0,196,140,0.12); color: var(--green); border: 1px solid rgba(0,196,140,0.25); }
  .msg.error { background: rgba(255,90,95,0.12); color: var(--red); border: 1px solid rgba(255,90,95,0.25); }

  /* ── CLOCKED-IN STATE ── */
  @keyframes fadeUp { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
  #ciView { display: none; }
  #ciView.show { display: block; animation: fadeUp 0.35s ease; }
  #signInView.hide { display: none; }

  .ci-status-badge { display: inline-flex; align-items: center; gap: 8px; background: rgba(0,196,140,0.1); border: 1px solid rgba(0,196,140,0.3); color: var(--green); font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 20px; margin-bottom: 28px; letter-spacing: 0.05em; text-transform: uppercase; }
  .pulse-dot { width: 7px; height: 7px; background: var(--green); border-radius: 50%; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  .ci-name { font-size: 20px; font-weight: 600; margin-bottom: 6px; }
  .ci-time-lbl { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; margin-top: 24px; }
  .ci-time-val { font-family: 'DM Mono', monospace; font-size: 48px; font-weight: 500; color: var(--text); letter-spacing: -0.03em; line-height: 1; margin-bottom: 8px; }
  .ci-meta { font-size: 13px; color: var(--muted); margin-bottom: 24px; }
  .ci-project-tag { display: inline-block; background: rgba(255,255,255,0.06); border: 1px solid var(--border); border-radius: 8px; padding: 3px 10px; font-size: 12px; margin-left: 8px; color: var(--text); }

  .duration-box { background: var(--dark); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
  .dur-lbl { font-size: 12px; color: var(--muted); margin-bottom: 3px; }
  .dur-val { font-family: 'DM Mono', monospace; font-size: 22px; font-weight: 500; }

  .switch-link { font-size: 12px; color: var(--muted); text-align: center; margin-top: 14px; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
  .switch-link:hover { color: var(--text); }

  .divider { height: 1px; background: var(--border); margin: 24px 0; }
  .footer { font-size: 12px; color: var(--muted); text-align: center; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">&#9201;</div>
  <h1>Staff Attendance</h1>
  <p class="subtitle">Record your clock in and clock out times</p>

  <div class="live-clock" id="liveClock"></div>
  <div class="live-date" id="liveDate"></div>

  <!-- ═══════════════════════════════════
       VIEW A — Sign in form
  ═══════════════════════════════════ -->
  <div id="signInView">
    <div class="field-row" id="namePhoneRow">
      <div class="field">
        <label class="lbl">Full Name</label>
        <input type="text" id="nameInput" placeholder="John Smith" autocomplete="off" oninput="onNameInput(this)" list="staffList">
        <datalist id="staffList"></datalist>
      </div>
      <div class="field">
        <label class="lbl">Mobile Number</label>
        <input type="tel" id="phoneInput" placeholder="04XX XXX XXX" autocomplete="tel" oninput="this.dataset.edited='1'">
        <p class="hint">Enter your WhatsApp number with area code</p>
      </div>
    </div>

    <div class="field">
      <label class="lbl">Project</label>
      <select id="projectInput">
        <option value="">Select a project...</option>
      </select>
    </div>

    <label class="lbl">Declaration</label>
    <div class="fit-box" id="fitBox" onclick="toggleFit()">
      <div class="chkbox"><span class="chkmark">&#10003;</span></div>
      <div>
        <div class="fit-title">I am fit for work today</div>
        <div class="fit-desc">I confirm I am in a suitable physical and mental condition to perform my duties safely.</div>
      </div>
    </div>

    <div class="btn-row">
      <button class="btn-in" id="btnClockIn" onclick="doClockIn()">&#128994; Clock In</button>
      <button class="btn-out-ghost" onclick="startClockOut()">&#128308; Clock Out</button>
    </div>

    <div class="late-panel" id="latePanelA">
      <div class="late-header">
        <div class="late-icon">&#128336;</div>
        <div class="late-title">Clocking out late?</div>
      </div>
      <div class="late-desc">Enter your actual finish time if you left earlier.</div>
      <label class="lbl">Actual finish time</label>
      <input type="time" id="lateTimeA">
    </div>

    <div class="msg" id="msgA"></div>
  </div>

  <!-- ═══════════════════════════════════
       VIEW B — Already clocked in
  ═══════════════════════════════════ -->
  <div id="ciView">
    <div class="ci-status-badge"><span class="pulse-dot"></span> Clocked In</div>

    <div class="ci-name" id="ciName"></div>

    <div class="ci-time-lbl">Clocked in at</div>
    <div class="ci-time-val" id="ciTimeVal"></div>
    <div class="ci-meta" id="ciMeta"></div>

    <div class="duration-box">
      <div>
        <div class="dur-lbl">Time on site today</div>
        <div class="dur-val" id="durVal">—</div>
      </div>
      <span style="font-size:28px">&#9201;</span>
    </div>

    <div class="late-panel" id="latePanelB">
      <div class="late-header">
        <div class="late-icon">&#128336;</div>
        <div class="late-title">Clocking out late?</div>
      </div>
      <div class="late-desc">Enter your actual finish time if you left earlier.</div>
      <label class="lbl">Actual finish time</label>
      <input type="time" id="lateTimeB">
    </div>

    <button class="btn-out-full" onclick="doClockOut()">&#128308; Clock Out</button>
    <div class="msg" id="msgB"></div>

    <div class="switch-link" onclick="switchUser()">Not you? Switch account</div>
  </div>

  <div class="divider"></div>
  <div class="footer">Perth, Western Australia (AWST)</div>
</div>

<script>
  let fitChecked = false;
  let lateShownA = false;
  let lateShownB = false;
  let durInterval = null;
  let clockInTs = null;   // ms timestamp when they clocked in
  let knownStaff = [];
  let savedUser = null;
  const LATE_HOUR = 17;

  // ── Clock ──────────────────────────────────────────────────────
  function tick() {
    const now = new Date();
    document.getElementById('liveClock').textContent =
      now.toLocaleTimeString('en-AU', { timeZone:'Australia/Perth', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true });
    document.getElementById('liveDate').textContent =
      now.toLocaleDateString('en-AU', { timeZone:'Australia/Perth', weekday:'long', year:'numeric', month:'long', day:'numeric' });
  }
  tick(); setInterval(tick, 1000);

  // ── View switching ─────────────────────────────────────────────
  function showSignIn() {
    document.getElementById('signInView').classList.remove('hide');
    document.getElementById('ciView').classList.remove('show');
    stopDuration();
  }

  function showClockedIn(name, timeStr, project, ts) {
    document.getElementById('signInView').classList.add('hide');
    document.getElementById('ciView').classList.add('show');
    document.getElementById('ciName').textContent = name;
    document.getElementById('ciTimeVal').textContent = timeStr;
    const today = new Date().toLocaleDateString('en-AU', { timeZone:'Australia/Perth', weekday:'long', day:'numeric', month:'long' });
    document.getElementById('ciMeta').innerHTML = today + (project ? ' &nbsp;<span class="ci-project-tag">&#128196; ' + project + '</span>' : '');
    clockInTs = ts || Date.now();
    startDuration();
  }

  // ── Duration counter ───────────────────────────────────────────
  function startDuration() {
    stopDuration();
    updateDur();
    durInterval = setInterval(updateDur, 30000);
  }
  function stopDuration() { if (durInterval) { clearInterval(durInterval); durInterval = null; } }
  function updateDur() {
    if (!clockInTs) return;
    const mins = Math.floor((Date.now() - clockInTs) / 60000);
    document.getElementById('durVal').textContent = Math.floor(mins/60) + 'h ' + (mins%60) + 'm';
  }

  // ── Device memory ──────────────────────────────────────────────
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem('ci_user')); } catch(e) { return null; }
  }
  function persist(name, phone) {
    try { localStorage.setItem('ci_user', JSON.stringify({name, phone})); } catch(e) {}
  }
  function switchUser() {
    try { localStorage.removeItem('ci_user'); } catch(e) {}
    savedUser = null; clockInTs = null;
    document.getElementById('nameInput').value = '';
    document.getElementById('phoneInput').value = '';
    document.getElementById('namePhoneRow').style.display = '';
    document.getElementById('latePanelA').classList.remove('visible');
    document.getElementById('latePanelB').classList.remove('visible');
    lateShownA = false; lateShownB = false;
    showSignIn();
  }

  // ── Init ───────────────────────────────────────────────────────
  async function init() {
    await Promise.all([loadStaff(), loadProjects()]);
    savedUser = loadSaved();
    if (!savedUser) return;
    document.getElementById('nameInput').value = savedUser.name;
    document.getElementById('phoneInput').value = savedUser.phone;
    document.getElementById('namePhoneRow').style.display = 'none';
    // Ask server if they're still clocked in today
    try {
      const r = await fetch('/status?name=' + encodeURIComponent(savedUser.name));
      const d = await r.json();
      if (d.clockedIn && !d.clockedOut) {
        showClockedIn(savedUser.name, d.clockInTime, d.project, d.clockInTs);
      }
    } catch(e) { /* offline — stay on sign-in */ }
  }
  init();

  // ── Staff + Projects ───────────────────────────────────────────
  async function loadStaff() {
    try {
      const r = await fetch('/staff');
      knownStaff = await r.json();
      const dl = document.getElementById('staffList');
      dl.innerHTML = '';
      knownStaff.forEach(s => { const o = document.createElement('option'); o.value = s.name; dl.appendChild(o); });
    } catch(e) {}
  }
  async function loadProjects() {
    const sel = document.getElementById('projectInput');
    try {
      const r = await fetch('/projects');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ps = await r.json();
      sel.innerHTML = '<option value="">Select a project...</option>';
      if (ps.length === 0) {
        const o = document.createElement('option');
        o.value = 'CoR - Read Street'; o.textContent = 'CoR - Read Street';
        sel.appendChild(o);
      } else {
        ps.forEach(p => {
          const o = document.createElement('option');
          o.value = p.name; o.textContent = p.name;
          sel.appendChild(o);
        });
      }
    } catch(e) {
      // Fallback: keep hardcoded option so field is never empty
      sel.innerHTML = '<option value="">Select a project...</option><option value="CoR - Read Street">CoR - Read Street</option>';
    }
  }

  // ── Name typing ────────────────────────────────────────────────
  let statusTimer = null;
  function onNameInput(el) {
    const pos = el.selectionStart;
    el.value = el.value.replace(/\\b\\w/g, c => c.toUpperCase());
    el.setSelectionRange(pos, pos);
    const phone = document.getElementById('phoneInput');
    const match = knownStaff.find(s => s.name.toLowerCase() === el.value.toLowerCase());
    if (match && match.phone && !phone.dataset.edited) { phone.value = match.phone; }
    else if (!match && !phone.dataset.edited) { phone.value = ''; }
    clearTimeout(statusTimer);
    if (el.value.trim().length < 2) return;
    statusTimer = setTimeout(async () => {
      try {
        const r = await fetch('/status?name=' + encodeURIComponent(el.value.trim()));
        const d = await r.json();
        document.getElementById('btnClockIn').disabled = (d.clockedIn && !d.clockedOut);
      } catch(e) {}
    }, 600);
  }

  // ── Fit for work ───────────────────────────────────────────────
  function toggleFit() {
    fitChecked = !fitChecked;
    document.getElementById('fitBox').classList.toggle('checked', fitChecked);
    document.getElementById('fitBox').classList.remove('shake');
  }

  // ── Clock In ───────────────────────────────────────────────────
  async function doClockIn() {
    const name = document.getElementById('nameInput').value.trim();
    const phone = document.getElementById('phoneInput').value.trim();
    const project = document.getElementById('projectInput').value;
    const msgEl = document.getElementById('msgA');

    if (!name) { showMsg(msgEl, 'error', '⚠️ Please enter your name.'); return; }
    if (!phone) { showMsg(msgEl, 'error', '⚠️ Please enter your mobile number.'); return; }
    if (!fitChecked) {
      showMsg(msgEl, 'error', '⚠️ Please confirm you are fit for work.');
      const fb = document.getElementById('fitBox');
      fb.classList.remove('shake'); void fb.offsetWidth; fb.classList.add('shake');
      return;
    }

    let data;
    try {
      const body = new URLSearchParams({ name, phone, project, action:'in', fit_for_work:'true' });
      const r = await fetch('/clockin', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
      data = await r.json();
    } catch(e) {
      showMsg(document.getElementById('msgA'), 'error', '❌ Could not reach server. Please try again.');
      return;
    }

    if (!data.success) {
      if (data.message && data.message.toLowerCase().includes('already clocked in')) {
        persist(name, phone);
        savedUser = { name, phone };
        showClockedIn(name, data.clockInTime || '—', project, data.clockInTs || Date.now());
      } else {
        showMsg(msgEl, 'error', '⚠️ ' + (data.message || 'Something went wrong.'));
      }
      return;
    }

    persist(name, phone);
    savedUser = { name, phone };
    showClockedIn(name, data.time, project, Date.now());
  }

  // ── Clock Out ──────────────────────────────────────────────────
  function startClockOut() {
    // Called from sign-in view Out button
    const h = new Date().toLocaleString('en-AU',{timeZone:'Australia/Perth',hour:'numeric',hour12:false});
    if (parseInt(h) >= LATE_HOUR && !lateShownA) {
      const p = document.getElementById('latePanelA');
      p.classList.add('visible'); lateShownA = true;
      document.getElementById('lateTimeA').value = new Date().toLocaleTimeString('en-AU',{timeZone:'Australia/Perth',hour:'2-digit',minute:'2-digit',hour12:false});
      return;
    }
    submitOut('A');
  }

  function doClockOut() {
    // Called from clocked-in view
    const h = new Date().toLocaleString('en-AU',{timeZone:'Australia/Perth',hour:'numeric',hour12:false});
    if (parseInt(h) >= LATE_HOUR && !lateShownB) {
      const p = document.getElementById('latePanelB');
      p.classList.add('visible'); lateShownB = true;
      document.getElementById('lateTimeB').value = new Date().toLocaleTimeString('en-AU',{timeZone:'Australia/Perth',hour:'2-digit',minute:'2-digit',hour12:false});
      return;
    }
    submitOut('B');
  }

  async function submitOut(panel) {
    const name = (savedUser && savedUser.name) || document.getElementById('nameInput').value.trim();
    const customTime = panel === 'B'
      ? document.getElementById('lateTimeB').value
      : document.getElementById('lateTimeA').value;
    const msgEl = panel === 'B' ? document.getElementById('msgB') : document.getElementById('msgA');

    if (!name) { showMsg(msgEl, 'error', '⚠️ Please enter your name first.'); return; }

    let data;
    try {
      const body = new URLSearchParams({ name, action:'out', clock_out_time: customTime || '' });
      const r = await fetch('/clockin', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
      data = await r.json();
    } catch(e) {
      showMsg(msgEl, 'error', '❌ Could not reach server. Please try again.');
      return;
    }

    if (!data.success) { showMsg(msgEl, 'error', '⚠️ ' + (data.message || 'Something went wrong.')); return; }

    const t = data.time || customTime || '—';
    const hrs = data.hours ? ' · ' + data.hours + 'h worked' : '';
    showMsg(msgEl, 'success', '✅ Clocked out at ' + t + hrs + '. See you tomorrow!');

    stopDuration();
    clockInTs = null;

    // After 3s go back to sign-in, pre-filled
    setTimeout(() => {
      lateShownA = false; lateShownB = false;
      fitChecked = false;
      document.getElementById('fitBox').classList.remove('checked');
      document.getElementById('latePanelA').classList.remove('visible');
      document.getElementById('latePanelB').classList.remove('visible');
      document.getElementById('msgA').style.display = 'none';
      document.getElementById('msgB').style.display = 'none';
      document.getElementById('projectInput').value = '';
      if (savedUser) {
        document.getElementById('nameInput').value = savedUser.name;
        document.getElementById('phoneInput').value = savedUser.phone;
        document.getElementById('namePhoneRow').style.display = 'none';
      }
      showSignIn();
    }, 3000);
  }

  function showMsg(el, type, txt) {
    el.className = 'msg ' + type;
    el.style.display = 'block';
    el.textContent = txt;
  }
</script>
</body>
</html>`);
  }

  // ── QR code page ──────────────────────────────────────────────────────────
  if (url.pathname === '/' || url.pathname === '/qr') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    try {
      if (!latestQR) {
        return res.end(`<html><body style="background:#0F1117;color:#E8EAF0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;"><div><h2>WhatsApp Agent</h2><p style="color:#6B7280;margin-top:8px;">${isReady ? '✅ Connected and ready' : '⏳ Starting up... refresh in a moment'}</p></div></body></html>`);
      }
      const qrImageUrl = await QRCode.toDataURL(latestQR);
      return res.end(`<html><body style="background:#0F1117;color:#E8EAF0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;text-align:center;gap:20px;"><h2>Scan with WhatsApp Business</h2><p>Open WhatsApp Business → Linked Devices → Link a Device</p><div style="background:white;display:inline-block;padding:20px;border-radius:16px;"><img src="${qrImageUrl}" style="width:350px;height:350px;display:block;" /></div><p style="color:#888;font-size:14px;margin-top:16px;">Refreshes every 25 seconds.</p></body></html>`);
    } catch (err) {
      res.end(`<html><body><p>Error: ${err.message}</p></body></html>`);
    }
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

async function sendToTimesheetBot(message) {
  if (!whatsappReady) return;
  try {
    const chats = await client.getChats();
    const group = chats.find(c => c.isGroup && c.name === 'Timesheet Bot');
    if (!group) {
      console.warn('⚠️ "Timesheet Bot" group not found');
      return;
    }
    await group.sendMessage(message);
  } catch (err) {
    console.error('Could not send to Timesheet Bot group:', err.message);
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
  disconnectAlertSent = false;

  // ── Health ping at 6am and 6pm daily ─────────────────────────────────────
  const cron = require('node-cron');
  cron.schedule('0 6,18 * * *', async () => {
    const hour = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Perth', hour: 'numeric', hour12: true });
    const uptime = Math.floor((Date.now() - botStartTime) / 1000 / 60);
    notifyOwner(`✅ *Bot health check — ${hour}*\nStatus: Online\nUptime: ${uptime} mins\nClock-in form: ${APP_URL}/clockin`);
  }, { timezone: 'Australia/Perth' });

  // ── Watchdog: check every 15 mins ────────────────────────────────────────
  cron.schedule('*/15 * * * *', async () => {
    if (!isReady && !disconnectAlertSent) {
      disconnectAlertSent = true;
      notifyOwner('🚨 *Bot alert*: WhatsApp is disconnected.\nVisit ' + APP_URL + ' to scan the QR code and reconnect.');
    }
    if (isReady) disconnectAlertSent = false;
  }, { timezone: 'Australia/Perth' });
});

client.on('auth_failure', (msg) => console.error('❌ Auth failed:', msg));
client.on('disconnected', async (reason) => {
  isReady = false;
  whatsappReady = false;
  console.warn('⚠️ Disconnected:', reason);
  // Try to reinitialise after 10 seconds
  setTimeout(() => {
    console.log('🔄 Attempting to reinitialise WhatsApp client...');
    try { client.initialize(); } catch(e) { console.error('Reinit failed:', e.message); }
  }, 10000);
});

// ── Message handler ────────────────────────────────────────────────────────
client.on('message', async (msg) => {
  lastMessageTs = Date.now();
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
