// /addons/whatsapp_bot/reminder_editor.js
// Standalone HTTP server for editing reminders via a web UI on port 3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const REMINDERS_FILE = '/data/reminders.json';
const LAST_PROCESSED_FILE = '/data/last_processed.json';
const FRUITS_SCHEDULE_FILE = '/data/fruits_schedule.json';
const EVENTS_FILE = '/data/events.json';

// Group name mapping — set dynamically from config via startEditor()
let GROUP_NAMES = {};
let INCOMING_GROUP_NAMES = {};

function loadReminders() {
  try {
    return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveReminders(reminders) {
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2), 'utf8');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function buildHtmlPage(reminderTimes) {
  const morningTime = reminderTimes?.morning || '08:00';
  const eveningTime = reminderTimes?.evening || '20:00';
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ניהול תזכורות</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0f1117; --surface: #1a1d27; --surface2: #242836;
  --border: #2e3347; --text: #e4e6f0; --text2: #8b8fa3;
  --accent: #6c63ff; --accent2: #8b83ff; --danger: #ff4757;
  --danger2: #ff6b7a; --success: #2ed573; --warn: #ffa502;
  --radius: 12px;
}
body { font-family: 'Heebo', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
.container { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }

header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 32px; padding: 24px; background: var(--surface); border-radius: var(--radius); border: 1px solid var(--border); }
header h1 { font-size: 1.5rem; font-weight: 700; background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
header .stats { font-size: 0.9rem; color: var(--text2); }

.btn { padding: 10px 20px; border: none; border-radius: 8px; font-family: inherit; font-size: 0.9rem; font-weight: 500; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent2); transform: translateY(-1px); box-shadow: 0 4px 15px rgba(108,99,255,0.3); }
.btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
.btn-danger:hover { background: var(--danger); color: #fff; }
.btn-danger-solid { background: var(--danger); color: #fff; border: none; }
.btn-danger-solid:hover { background: var(--danger2); transform: translateY(-1px); box-shadow: 0 4px 15px rgba(255,71,87,0.3); }
.btn-sm { padding: 6px 12px; font-size: 0.8rem; }
.btn-edit { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
.btn-edit:hover { background: var(--accent); color: #fff; }
.btn-secondary { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
.btn-secondary:hover { background: var(--border); transform: translateY(-1px); }
.btn-success { background: var(--success); color: #fff; border: none; }
.btn-success:hover { opacity: 0.9; transform: translateY(-1px); }

.reminder-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 12px; transition: all 0.2s; }
.reminder-card:hover { border-color: var(--accent); transform: translateX(-2px); }
.reminder-card.sent { opacity: 0.5; }
.card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
.card-task { font-size: 1rem; font-weight: 500; line-height: 1.5; flex: 1; }
.card-actions { display: flex; gap: 8px; margin-right: 16px; flex-shrink: 0; }
.card-meta { display: flex; flex-wrap: wrap; gap: 12px; font-size: 0.85rem; color: var(--text2); }
.meta-item { display: flex; align-items: center; gap: 4px; }
.badge { padding: 3px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; }
.badge-evening { background: rgba(108,99,255,0.15); color: var(--accent2); }
.badge-morning { background: rgba(255,165,2,0.15); color: var(--warn); }
.badge-custom { background: rgba(100,200,255,0.15); color: #64c8ff; }
.badge-sent { background: rgba(46,213,115,0.15); color: var(--success); }
.badge-pending { background: rgba(255,71,87,0.15); color: var(--danger2); }
.badge-group { background: var(--surface2); color: var(--text2); }

/* Merged reminder time rows */
.time-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-top: 1px solid var(--border); flex-wrap: wrap; }
.time-row:first-child { border-top: none; }
.time-row .time-info { flex: 1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.time-row .time-actions { display: flex; gap: 4px; }

.empty-state { text-align: center; padding: 60px 20px; color: var(--text2); }
.empty-state .icon { font-size: 3rem; margin-bottom: 16px; }

.columns { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
@media (max-width: 768px) { .columns { grid-template-columns: 1fr; } }
.column { min-width: 0; }
.column-header { padding: 16px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius) var(--radius) 0 0; display: flex; align-items: center; justify-content: space-between; }
.column-header h2 { font-size: 1.1rem; font-weight: 600; }
.column-header .count { font-size: 0.85rem; color: var(--text2); }
.column-body { border: 1px solid var(--border); border-top: none; border-radius: 0 0 var(--radius) var(--radius); padding: 12px; background: var(--bg); min-height: 100px; }

/* Modal */
.modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
.modal-overlay.active { display: flex; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 32px; width: 90%; max-width: 500px; animation: slideUp 0.3s ease; }
@keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
.modal h2 { font-size: 1.2rem; margin-bottom: 24px; font-weight: 600; }
.form-group { margin-bottom: 20px; }
.form-group label { display: block; font-size: 0.85rem; font-weight: 500; margin-bottom: 6px; color: var(--text2); }
.form-group input, .form-group select, .form-group textarea { width: 100%; padding: 10px 14px; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: inherit; font-size: 0.9rem; outline: none; transition: border-color 0.2s; }
.form-group input:focus, .form-group select:focus, .form-group textarea:focus { border-color: var(--accent); }
.form-group textarea { resize: vertical; min-height: 80px; }
.modal-actions { display: flex; gap: 12px; justify-content: flex-start; margin-top: 24px; }

/* Confirm delete modal */
.confirm-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 200; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
.confirm-overlay.active { display: flex; }
.confirm-modal { background: var(--surface); border: 1px solid var(--danger); border-radius: var(--radius); padding: 32px; width: 90%; max-width: 420px; animation: slideUp 0.3s ease; text-align: center; }
.confirm-modal h3 { font-size: 1.1rem; margin-bottom: 12px; color: var(--danger); }
.confirm-modal .confirm-task { background: var(--surface2); border-radius: 8px; padding: 12px 16px; margin: 16px 0; font-size: 0.9rem; line-height: 1.5; text-align: right; max-height: 120px; overflow-y: auto; }
.confirm-modal .confirm-actions { display: flex; gap: 12px; justify-content: center; margin-top: 20px; }

/* Settings panel */
.settings-toggle { cursor: pointer; user-select: none; display: flex; align-items: center; gap: 8px; padding: 12px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 16px; transition: all 0.2s; }
.settings-toggle:hover { border-color: var(--accent); }
.settings-toggle .arrow { transition: transform 0.3s; display: inline-block; }
.settings-toggle .arrow.open { transform: rotate(90deg); }
.settings-panel { display: none; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; margin-bottom: 24px; }
.settings-panel.open { display: block; animation: slideUp 0.3s ease; }
.settings-section { margin-bottom: 24px; }
.settings-section:last-child { margin-bottom: 0; }
.settings-section h3 { font-size: 1rem; font-weight: 600; margin-bottom: 12px; color: var(--accent2); }
.settings-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.settings-row label { min-width: 120px; font-size: 0.85rem; color: var(--text2); }
.settings-row input { padding: 8px 12px; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: inherit; font-size: 0.85rem; outline: none; transition: border-color 0.2s; }
.settings-row input:focus { border-color: var(--accent); }

/* Header buttons row */
.header-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

/* Import mode select modal */
.import-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 200; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
.import-overlay.active { display: flex; }
.import-modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 32px; width: 90%; max-width: 420px; animation: slideUp 0.3s ease; text-align: center; }
.import-modal h3 { font-size: 1.1rem; margin-bottom: 16px; }
.import-modal p { font-size: 0.9rem; color: var(--text2); margin-bottom: 20px; }
.import-modal .import-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }

/* Activity log */
.activity-section { margin-bottom: 24px; }
.activity-header { display: flex; align-items: center; justify-content: space-between; cursor: pointer; padding: 16px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); transition: all 0.2s; user-select: none; }
.activity-header:hover { border-color: var(--accent); }
.activity-header h2 { font-size: 1.1rem; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.activity-header .arrow { transition: transform 0.3s; display: inline-block; }
.activity-header .arrow.open { transform: rotate(90deg); }
.activity-body { display: none; border: 1px solid var(--border); border-top: none; border-radius: 0 0 var(--radius) var(--radius); background: var(--bg); max-height: 600px; overflow-y: auto; }
.activity-body.open { display: block; animation: slideUp 0.2s ease; }
.activity-entry { padding: 16px 20px; border-bottom: 1px solid var(--border); transition: background 0.2s; }
.activity-entry:last-child { border-bottom: none; }
.activity-entry:hover { background: var(--surface); }
.activity-entry.new-entry { animation: highlightNew 2s ease; }
@keyframes highlightNew { from { background: rgba(108,99,255,0.15); } to { background: transparent; } }
.activity-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.activity-group { font-weight: 600; font-size: 0.9rem; }
.activity-time { font-size: 0.8rem; color: var(--text2); }
.activity-count { font-size: 0.75rem; color: var(--text2); background: var(--surface2); padding: 2px 8px; border-radius: 10px; }
.activity-preview { font-size: 0.85rem; color: var(--text2); line-height: 1.4; margin-bottom: 8px; max-height: 60px; overflow: hidden; text-overflow: ellipsis; direction: rtl; }
.activity-outcomes { display: flex; flex-wrap: wrap; gap: 6px; }
.outcome-badge { padding: 3px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 500; }
.outcome-tasks { background: rgba(108,99,255,0.15); color: var(--accent2); }
.outcome-calendar { background: rgba(46,213,115,0.15); color: var(--success); }
.outcome-reminders { background: rgba(255,165,2,0.15); color: var(--warn); }
.outcome-task { background: rgba(46,213,115,0.15); color: var(--success); }
.outcome-ignore { background: var(--surface2); color: var(--text2); }
.outcome-no_tasks { background: var(--surface2); color: var(--text2); }
.outcome-received { background: rgba(108,99,255,0.15); color: var(--accent2); animation: pulse 2s infinite; }
.outcome-error { background: rgba(255,71,87,0.15); color: var(--danger); }
.outcome-reminder_sent { background: rgba(255,165,2,0.15); color: var(--warn); }
.activity-details { margin-top: 8px; padding: 10px 14px; background: var(--surface2); border-radius: 8px; font-size: 0.8rem; line-height: 1.6; display: none; }
.activity-details.open { display: block; }
.activity-toggle { font-size: 0.75rem; color: var(--accent); cursor: pointer; border: none; background: none; font-family: inherit; padding: 0; margin-top: 4px; }
.activity-toggle:hover { color: var(--accent2); }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); display: inline-block; animation: pulse 2s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1>📋 ניהול תזכורות</h1>
      <div class="stats" id="stats"></div>
    </div>
    <div class="header-actions">
      <button class="btn btn-secondary" onclick="fetchReminders(); fetchSettings();" title="רענון">🔄</button>
      <button class="btn btn-secondary" onclick="exportJSON()">📥 ייצוא JSON</button>
      <button class="btn btn-secondary" onclick="triggerImport()">📤 ייבוא JSON</button>
      <button class="btn btn-primary" onclick="openAddModal()">+ תזכורת חדשה</button>
    </div>
    <input type="file" id="import-file" accept=".json" style="display:none" onchange="handleImportFile(event)">
  </header>

  <div class="settings-toggle" onclick="toggleSettings()">
    <span class="arrow" id="settings-arrow">▶</span>
    <span>⚙️ הגדרות ומידע</span>
  </div>
  <div class="settings-panel" id="settings-panel">
    <div class="settings-section">
      <h3>🕐 זמן עיבוד אחרון (last processed)</h3>
      <div id="last-processed-rows"></div>
      <button class="btn btn-success btn-sm" onclick="saveLastProcessed()" style="margin-top:8px">💾 שמור</button>
    </div>
    <div class="settings-section">
      <h3>🍎 תזכורת פירות - תאריך תזמון אחרון</h3>
      <div class="settings-row">
        <label>last_scheduled_date</label>
        <input type="date" id="fruits-last-date">
      </div>
      <button class="btn btn-success btn-sm" onclick="saveFruitsSchedule()" style="margin-top:8px">💾 שמור</button>
    </div>
  </div>

  <div class="activity-section">
    <div class="activity-header" onclick="toggleActivity()">
      <h2><span class="arrow" id="activity-arrow">▶</span> 📊 פעילות אחרונה <span class="live-dot"></span></h2>
      <span class="count" id="activity-count"></span>
    </div>
    <div class="activity-body" id="activity-body"></div>
  </div>

  <div class="columns" id="reminders-list">
    <div class="column" id="col-120363425692029127@g.us"></div>
    <div class="column" id="col-120363424238663971@g.us"></div>
  </div>
</div>

<!-- Delete confirmation modal -->
<div class="confirm-overlay" id="confirm-overlay">
  <div class="confirm-modal">
    <h3>🗑️ מחיקת תזכורת</h3>
    <p>האם למחוק את התזכורת הזו?</p>
    <div class="confirm-task" id="confirm-task-text"></div>
    <div class="confirm-actions">
      <button class="btn btn-danger-solid" id="confirm-delete-btn">מחק</button>
      <button class="btn btn-secondary" onclick="closeConfirm()">ביטול</button>
    </div>
  </div>
</div>

<!-- Import mode selection modal -->
<div class="import-overlay" id="import-overlay">
  <div class="import-modal">
    <h3>📤 ייבוא תזכורות</h3>
    <p id="import-info"></p>
    <div class="import-actions">
      <button class="btn btn-primary" onclick="doImport('merge')">🔀 מיזוג (הוספה)</button>
      <button class="btn btn-danger-solid" onclick="doImport('replace')">🔄 החלפה מלאה</button>
      <button class="btn btn-secondary" onclick="closeImport()">ביטול</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="modal-overlay">
  <div class="modal">
    <h2 id="modal-title">הוספת תזכורת</h2>
    <form id="reminder-form" onsubmit="saveReminder(event)">
      <input type="hidden" id="edit-index" value="-1">
      <div class="form-group">
        <label>תיאור המשימה</label>
        <textarea id="f-task" required></textarea>
      </div>
      <div class="form-group">
        <label>סוג</label>
        <select id="f-type" onchange="onTypeChange()">
          <option value="evening">🌙 תזכורת ערב (${eveningTime})</option>
          <option value="morning">☀️ תזכורת בוקר (${morningTime})</option>
          <option value="custom">🕐 שעה מותאמת</option>
        </select>
      </div>
      <div class="form-group" id="date-group">
        <label>תאריך</label>
        <input type="date" id="f-date" required>
      </div>
      <div class="form-group" id="time-group" style="display:none">
        <label>שעה</label>
        <input type="time" id="f-time">
      </div>
      <input type="hidden" id="f-send-at">
      <div class="form-group">
        <label>קבוצה</label>
        <select id="f-group"></select>
      </div>
      <div class="modal-actions">
        <button type="submit" class="btn btn-primary">שמור</button>
        <button type="button" class="btn btn-danger" onclick="closeModal()">ביטול</button>
      </div>
    </form>
  </div>
</div>

<script>
const GROUP_NAMES = ${JSON.stringify(GROUP_NAMES)};
const INCOMING_GROUP_NAMES = ${JSON.stringify(INCOMING_GROUP_NAMES)};
const MORNING_TIME = '${morningTime}';
const EVENING_TIME = '${eveningTime}';
let reminders = [];

async function fetchReminders() {
    const res = await fetch('api/reminders');
    reminders = await res.json();
    render();
}

function formatDate(ms) {
    return new Date(ms).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function toLocalDatetimeValue(ms) {
    const d = new Date(ms);
    // Adjust to Israel timezone for the input
    const israel = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const yyyy = israel.getFullYear();
    const mm = String(israel.getMonth() + 1).padStart(2, '0');
    const dd = String(israel.getDate()).padStart(2, '0');
    const hh = String(israel.getHours()).padStart(2, '0');
    const mi = String(israel.getMinutes()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd + 'T' + hh + ':' + mi;
}

function groupName(id) {
    return GROUP_NAMES[id] || id || 'לא ידוע';
}

function normalizeTaskKey(task) {
    // Strip מחר/היום and emoji to normalize fruit & regular reminders for grouping
    return (task || '').replace(/מחר/g, '').replace(/היום/g, '').replace(/[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}]/gu, '').replace(/\s+/g, ' ').trim();
}

function render() {
    const pending = reminders.filter(r => !r.sent).length;
    const sent = reminders.filter(r => r.sent).length;
    document.getElementById('stats').textContent = pending + ' ממתינות · ' + sent + ' נשלחו · ' + reminders.length + ' סה"כ';

    const indexed = reminders.map((r, i) => ({ r, i }));

    Object.entries(GROUP_NAMES).forEach(([groupId, groupLabel]) => {
        const col = document.getElementById('col-' + groupId);
        if (!col) return;

        const groupReminders = indexed
            .filter(x => x.r.outgoing_group_id === groupId)
            .sort((a, b) => a.r.send_at - b.r.send_at);

        const pendingCount = groupReminders.filter(x => !x.r.sent).length;

        let html = '<div class="column-header"><h2>' + escapeHtml(groupLabel) + '</h2><span class="count">' + pendingCount + ' ממתינות / ' + groupReminders.length + ' סה"כ</span></div>';
        html += '<div class="column-body">';

        if (groupReminders.length === 0) {
            html += '<div class="empty-state"><div class="icon">📭</div><p>אין תזכורות</p></div>';
        } else {
            // Group reminders by normalized task key
            const groups = [];
            const keyMap = {};
            groupReminders.forEach(item => {
                const key = normalizeTaskKey(item.r.task);
                if (keyMap[key] !== undefined) {
                    groups[keyMap[key]].items.push(item);
                } else {
                    keyMap[key] = groups.length;
                    groups.push({ key, items: [item] });
                }
            });

            groups.forEach(group => {
                const allSent = group.items.every(x => x.r.sent);
                // Use the first item's task as the display title
                const displayTask = group.items[0].r.task;

                html += '<div class="reminder-card' + (allSent ? ' sent' : '') + '">';
                html += '<div class="card-header"><div class="card-task">' + escapeHtml(displayTask) + '</div></div>';

                // Render a time row for each reminder in the group
                group.items.forEach(({ r, i }) => {
                    const typeLabel = r.type === 'evening' ? '🌙 ערב' : r.type === 'morning' ? '☀️ בוקר' : '🕐 מותאם';
                    const typeBadge = r.type === 'evening' ? 'badge-evening' : r.type === 'morning' ? 'badge-morning' : 'badge-custom';
                    const statusBadge = r.sent ? 'badge-sent' : 'badge-pending';
                    const statusLabel = r.sent ? 'נשלח' : 'ממתין';
                    html += '<div class="time-row">' +
                        '<div class="time-info">' +
                            '<span class="badge ' + typeBadge + '">' + typeLabel + '</span>' +
                            '<span class="badge ' + statusBadge + '">' + statusLabel + '</span>' +
                            '<span class="meta-item">🕐 ' + formatDate(r.send_at) + '</span>' +
                        '</div>' +
                        '<div class="time-actions">' +
                            '<button class="btn btn-edit btn-sm" onclick="openEditModal(' + i + ')">✏️</button>' +
                            '<button class="btn btn-danger btn-sm" onclick="confirmDelete(' + i + ')">🗑️</button>' +
                        '</div>' +
                    '</div>';
                });

                html += '</div>';
            });
        }

        html += '</div>';
        col.innerHTML = html;
    });
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}

function populateGroupDropdown() {
    const sel = document.getElementById('f-group');
    sel.innerHTML = Object.entries(GROUP_NAMES).map(([id, name]) =>
        '<option value="' + id + '">' + name + '</option>'
    ).join('');
}

function openAddModal() {
    document.getElementById('modal-title').textContent = 'הוספת תזכורת';
    document.getElementById('edit-index').value = '-1';
    document.getElementById('f-task').value = '';
    document.getElementById('f-type').value = 'evening';
    setDefaultDate();
    onTypeChange();
    populateGroupDropdown();
    document.getElementById('modal-overlay').classList.add('active');
}

function setDefaultDate() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    document.getElementById('f-date').value = yyyy + '-' + mm + '-' + dd;
}

function onTypeChange() {
    const type = document.getElementById('f-type').value;
    const timeGroup = document.getElementById('time-group');
    const timeInput = document.getElementById('f-time');
    if (type === 'custom') {
        timeGroup.style.display = '';
        timeInput.required = true;
        if (!timeInput.value) timeInput.value = '12:00';
    } else {
        timeGroup.style.display = 'none';
        timeInput.required = false;
    }
}

function buildSendAt() {
    const type = document.getElementById('f-type').value;
    const date = document.getElementById('f-date').value;
    const time = type === 'morning' ? MORNING_TIME : type === 'evening' ? EVENING_TIME : document.getElementById('f-time').value;
    return new Date(date + 'T' + time).getTime();
}

function openEditModal(i) {
    const r = reminders[i];
    document.getElementById('modal-title').textContent = 'עריכת תזכורת';
    document.getElementById('edit-index').value = i;
    document.getElementById('f-task').value = r.task;
    const dt = toLocalDatetimeValue(r.send_at);
    document.getElementById('f-date').value = dt.substring(0, 10);
    document.getElementById('f-time').value = dt.substring(11, 16);
    document.getElementById('f-type').value = r.type;
    onTypeChange();
    populateGroupDropdown();
    document.getElementById('f-group').value = r.outgoing_group_id;
    document.getElementById('modal-overlay').classList.add('active');
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('active');
}

async function saveReminder(e) {
    e.preventDefault();
    const idx = parseInt(document.getElementById('edit-index').value);
    const data = {
        task: document.getElementById('f-task').value,
        send_at: buildSendAt(),
        type: document.getElementById('f-type').value,
        outgoing_group_id: document.getElementById('f-group').value,
        original_message_ts: 0,
        sent: false
    };

    if (idx >= 0) {
        // Preserve sent status on edit
        data.sent = reminders[idx].sent;
        data.original_message_ts = reminders[idx].original_message_ts || 0;
        await fetch('api/reminders/' + idx, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    } else {
        await fetch('api/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

        // Suggest morning reminder after adding an evening one
        if (data.type === 'evening') {
            const nextMorning = new Date(data.send_at);
            nextMorning.setDate(nextMorning.getDate() + 1);
            const [mH, mM] = MORNING_TIME.split(':').map(Number);
            nextMorning.setHours(mH, mM, 0, 0);
            const morningStr = nextMorning.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

            if (confirm('להוסיף גם תזכורת בוקר (' + morningStr + ') עם אותו תוכן?')) {
                const morningData = {
                    task: data.task,
                    send_at: nextMorning.getTime(),
                    type: 'morning',
                    outgoing_group_id: data.outgoing_group_id,
                    original_message_ts: 0,
                    sent: false
                };
                await fetch('api/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(morningData) });
            }
        }
    }
    closeModal();
    await fetchReminders();
}

// --- Delete confirmation ---
let pendingDeleteIndex = -1;

function confirmDelete(i) {
    pendingDeleteIndex = i;
    const r = reminders[i];
    document.getElementById('confirm-task-text').textContent = r ? r.task : '';
    document.getElementById('confirm-overlay').classList.add('active');
}

function closeConfirm() {
    pendingDeleteIndex = -1;
    document.getElementById('confirm-overlay').classList.remove('active');
}

async function doDelete() {
    if (pendingDeleteIndex < 0) return;
    try {
        const res = await fetch('api/reminders/' + pendingDeleteIndex, { method: 'DELETE' });
        if (!res.ok) { alert('שגיאה במחיקה: ' + res.status); return; }
        await fetchReminders();
    } catch (err) {
        alert('שגיאה: ' + err.message);
    } finally {
        closeConfirm();
    }
}

document.getElementById('confirm-delete-btn').addEventListener('click', doDelete);
document.getElementById('confirm-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeConfirm();
});

// --- Settings panel ---
function toggleSettings() {
    const panel = document.getElementById('settings-panel');
    const arrow = document.getElementById('settings-arrow');
    panel.classList.toggle('open');
    arrow.classList.toggle('open');
    if (panel.classList.contains('open')) {
        fetchSettings();
    }
}

async function fetchSettings() {
    // Last processed
    try {
        const res = await fetch('api/last-processed');
        const data = await res.json();
        const container = document.getElementById('last-processed-rows');
        let html = '';
        const groups = data.groups || {};

        // Build list of all groups to show: incoming groups + notes group
        const allGroups = Object.entries(INCOMING_GROUP_NAMES).map(([id, name]) => ({ id, name }));

        allGroups.forEach(({ id: incomingId, name }) => {
            const ts = groups[incomingId];
            const val = ts ? toLocalDatetimeValue(ts * 1000) : '';
            const displayDate = ts ? new Date(ts * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'לא נקבע';
            html += '<div class="settings-row">' +
                '<label>' + escapeHtml(name) + '</label>' +
                '<input type="datetime-local" data-group-id="' + incomingId + '" class="lp-input" value="' + val + '">' +
                '<button class="btn btn-sm" onclick="setLpToNow(this)" style="font-size:0.7rem;padding:4px 8px;margin-right:4px" title="עכשיו">🕐 עכשיו</button>' +
                '<span style="font-size:0.8rem;color:var(--text2);margin-right:8px">' + displayDate + '</span>' +
                '</div>';
        });
        container.innerHTML = html;
    } catch (err) {
        console.error('Failed to load last processed:', err);
    }

    // Fruits schedule
    try {
        const res = await fetch('api/fruits-schedule');
        const data = await res.json();
        document.getElementById('fruits-last-date').value = data.last_scheduled_date || '';
    } catch (err) {
        console.error('Failed to load fruits schedule:', err);
    }
}

function setLpToNow(el) {
    const row = el.closest('.settings-row');
    const input = row.querySelector('.lp-input');
    if (input) {
        input.value = toLocalDatetimeValue(Date.now());
    }
}

async function saveLastProcessed() {
    const inputs = document.querySelectorAll('.lp-input');
    const groups = {};
    inputs.forEach(inp => {
        const id = inp.dataset.groupId;
        if (inp.value) {
            groups[id] = Math.floor(new Date(inp.value).getTime() / 1000);
        }
    });
    try {
        await fetch('api/last-processed', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groups })
        });
        alert('זמן עיבוד אחרון נשמר בהצלחה');
    } catch (err) {
        alert('שגיאה: ' + err.message);
    }
}

async function saveFruitsSchedule() {
    const val = document.getElementById('fruits-last-date').value;
    try {
        await fetch('api/fruits-schedule', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ last_scheduled_date: val || null })
        });
        alert('תאריך תזמון פירות נשמר בהצלחה');
    } catch (err) {
        alert('שגיאה: ' + err.message);
    }
}

// --- JSON Export (full state) ---
async function exportJSON() {
    try {
        const res = await fetch('api/full-state');
        const state = await res.json();
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const now = new Date();
        const dateStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
        a.download = 'bot_state_' + dateStr + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        alert('שגיאה בייצוא: ' + err.message);
    }
}

// --- JSON Import (supports full state and legacy reminders-only) ---
let importedData = null;
let importIsFullState = false;

function triggerImport() {
    document.getElementById('import-file').value = '';
    document.getElementById('import-file').click();
}

function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(ev) {
        try {
            const data = JSON.parse(ev.target.result);
            if (Array.isArray(data)) {
                // Legacy format: array of reminders
                importedData = { reminders: data };
                importIsFullState = false;
                document.getElementById('import-info').textContent = 'נמצאו ' + data.length + ' תזכורות בקובץ. מה לעשות?';
            } else if (data && Array.isArray(data.reminders)) {
                // Full state format
                importedData = data;
                importIsFullState = true;
                const parts = [data.reminders.length + ' תזכורות'];
                if (data.events) parts.push(data.events.length + ' אירועים');
                if (data.last_processed) parts.push('זמני עיבוד');
                if (data.fruits_schedule) parts.push('תזמון פירות');
                document.getElementById('import-info').textContent = 'נמצאו: ' + parts.join(', ') + '. מה לעשות?';
            } else {
                alert('קובץ לא תקין: הקובץ חייב להכיל מערך של תזכורות או מצב מלא');
                return;
            }
            document.getElementById('import-overlay').classList.add('active');
        } catch (err) {
            alert('שגיאה בקריאת הקובץ: ' + err.message);
        }
    };
    reader.readAsText(file);
}

function closeImport() {
    importedData = null;
    importIsFullState = false;
    document.getElementById('import-overlay').classList.remove('active');
}

async function doImport(mode) {
    if (!importedData) return;
    try {
        // Always import reminders via the existing endpoint
        const res = await fetch('api/reminders/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode, reminders: importedData.reminders })
        });
        if (!res.ok) { alert('שגיאה בייבוא תזכורות: ' + res.status); return; }
        const result = await res.json();
        let msg = 'ייבוא הושלם: ' + result.count + ' תזכורות';

        // If full state and replace mode, also restore settings
        if (importIsFullState && mode === 'replace') {
            if (importedData.last_processed) {
                await fetch('api/last-processed', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(importedData.last_processed)
                });
                msg += ' | \u05d6\u05de\u05e0\u05d9 \u05e2\u05d9\u05d1\u05d5\u05d3 \u05e9\u05d5\u05d7\u05d6\u05e8\u05d5';
            }
            if (importedData.fruits_schedule) {
                await fetch('api/fruits-schedule', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(importedData.fruits_schedule)
                });
                msg += ' | \u05ea\u05d6\u05de\u05d5\u05df \u05e4\u05d9\u05e8\u05d5\u05ea \u05e9\u05d5\u05d7\u05d6\u05e8';
            }
            if (importedData.events) {
                await fetch('api/events', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(importedData.events)
                });
                msg += ' | ' + importedData.events.length + ' \u05d0\u05d9\u05e8\u05d5\u05e2\u05d9\u05dd \u05e9\u05d5\u05d7\u05d6\u05e8\u05d5';
            }
        }

        alert(msg);
        closeImport();
        await fetchReminders();
        if (document.getElementById('settings-panel').classList.contains('open')) {
            await fetchSettings();
        }
    } catch (err) {
        alert('שגיאה: ' + err.message);
    }
}

document.getElementById('import-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeImport();
});

// Close modal on overlay click
document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
});

populateGroupDropdown();

// Auto-set time when type changes (only for new reminders)
document.getElementById('f-type').addEventListener('change', (e) => {
    if (document.getElementById('edit-index').value === '-1') {
        setDefaultTime(e.target.value);
    }
});

fetchReminders();

// --- Activity log ---
let activityLogData = [];
let activityOpen = false;
let lastActivityCount = 0;

function toggleActivity() {
    activityOpen = !activityOpen;
    document.getElementById('activity-body').classList.toggle('open', activityOpen);
    document.getElementById('activity-arrow').classList.toggle('open', activityOpen);
    if (activityOpen && activityLogData.length === 0) fetchActivityLog();
}

async function fetchActivityLog() {
    try {
        const res = await fetch('api/activity-log');
        const data = await res.json();
        const prevCount = activityLogData.length;
        activityLogData = data;
        document.getElementById('activity-count').textContent = data.length + ' רשומות';
        if (activityOpen) renderActivityLog(prevCount < data.length ? prevCount : -1);
    } catch (err) {
        console.error('Failed to fetch activity log:', err);
    }
}

function renderActivityLog(highlightFrom) {
    const body = document.getElementById('activity-body');
    if (activityLogData.length === 0) {
        body.innerHTML = '<div class="empty-state" style="padding:30px"><div class="icon">📭</div><p>אין פעילות עדיין</p></div>';
        return;
    }
    // Show newest first
    const reversed = [...activityLogData].reverse();
    let html = '';
    reversed.forEach((entry, idx) => {
        const realIdx = activityLogData.length - 1 - idx;
        const isNew = highlightFrom >= 0 && realIdx >= highlightFrom;
        const timeStr = new Date(entry.timestamp * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const groupEmoji = entry.type === 'notes' ? '📝' : '🏫';
        const senders = (entry.senders || []).join(', ');

        html += '<div class="activity-entry' + (isNew ? ' new-entry' : '') + '">';
        html += '<div class="activity-top">';
        html += '<span class="activity-group">' + groupEmoji + ' ' + escapeHtml(entry.groupLabel || '') + '</span>';
        html += '<span class="activity-time">🕐 ' + timeStr + '</span>';
        if (entry.messageCount > 1) html += '<span class="activity-count">' + entry.messageCount + ' הודעות</span>';
        if (senders) html += '<span class="activity-count">👤 ' + escapeHtml(senders) + '</span>';
        html += '</div>';

        // Preview
        if (entry.messagePreview) {
            html += '<div class="activity-preview">' + escapeHtml(entry.messagePreview.substring(0, 150)) + (entry.messagePreview.length > 150 ? '...' : '') + '</div>';
        }

        // Outcome badges
        html += '<div class="activity-outcomes">';
        (entry.outcome || []).forEach(o => {
            const labels = { tasks: '📋 משימות', calendar: '📅 יומן', reminders: '⏰ תזכורות', task: '✅ משימה', ignore: '👍 התעלמות', no_tasks: 'אין משימות', received: '⏳ ממתין לעיבוד', error: '❌ שגיאה', reminder_sent: '📨 תזכורת נשלחה' };
            html += '<span class="outcome-badge outcome-' + o + '">' + (labels[o] || o) + '</span>';
        });
        html += '</div>';

        // Expandable details
        if (entry.outcomeDetails && entry.outcomeDetails.length > 0) {
            html += '<button class="activity-toggle" onclick="toggleDetails(this)">▼ פרטים</button>';
            html += '<div class="activity-details">';
            entry.outcomeDetails.forEach(d => {
                html += '<div>' + escapeHtml(d) + '</div>';
            });
            if (entry.summaryText) {
                html += '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px"><strong>סיכום:</strong> ' + escapeHtml(entry.summaryText).substring(0, 300) + '</div>';
            }
            if (entry.tasks && entry.tasks.length > 0) {
                html += '<div style="margin-top:6px">';
                entry.tasks.forEach(t => {
                    html += '<div>• ' + escapeHtml(t.description || '') + (t.due_date ? ' (' + t.due_date + ')' : '') + '</div>';
                });
                html += '</div>';
            }
            if (entry.noteTitle) {
                html += '<div style="margin-top:4px"><strong>כותרת:</strong> ' + escapeHtml(entry.noteTitle) + '</div>';
            }
            html += '</div>';
        }

        html += '</div>';
    });
    body.innerHTML = html;
}

function toggleDetails(btn) {
    const details = btn.nextElementSibling;
    if (details) {
        details.classList.toggle('open');
        btn.textContent = details.classList.contains('open') ? '▲ הסתר' : '▼ פרטים';
    }
}

// Auto-poll activity log every 5 seconds
setInterval(() => {
    fetchActivityLog();
}, 5000);
// Initial fetch
fetchActivityLog();
</script>
</body>
</html>`;
}

function startEditor(port = 3000, groupNames = {}, incomingGroupNames = {}, callbacks = {}) {
  GROUP_NAMES = groupNames;
  INCOMING_GROUP_NAMES = incomingGroupNames;
  const { onRemindersChanged, onLastProcessedChanged, onFruitsScheduleChanged, onEventsChanged, getActivityLog, reminderTimes } = callbacks;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // API: GET /api/reminders
      if (req.method === 'GET' && url.pathname === '/api/reminders') {
        sendJSON(res, 200, loadReminders());
        return;
      }

      // API: POST /api/reminders
      if (req.method === 'POST' && url.pathname === '/api/reminders') {
        const data = await parseBody(req);
        const reminders = loadReminders();
        reminders.push(data);
        saveReminders(reminders);
        if (onRemindersChanged) onRemindersChanged();
        console.log(`[Editor] Reminder ADDED: "${data.task}" -> ${new Date(data.send_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);
        sendJSON(res, 201, data);
        return;
      }

      // API: PUT /api/reminders/:index
      const putMatch = req.method === 'PUT' && url.pathname.match(/^\/api\/reminders\/(\d+)$/);
      if (putMatch) {
        const idx = parseInt(putMatch[1]);
        const data = await parseBody(req);
        const reminders = loadReminders();
        if (idx < 0 || idx >= reminders.length) {
          sendJSON(res, 404, { error: 'Not found' });
          return;
        }
        reminders[idx] = data;
        saveReminders(reminders);
        if (onRemindersChanged) onRemindersChanged();
        console.log(`[Editor] Reminder MODIFIED [${idx}]: "${data.task}" -> ${new Date(data.send_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);
        sendJSON(res, 200, data);
        return;
      }

      // API: DELETE /api/reminders/:index
      const delMatch = req.method === 'DELETE' && url.pathname.match(/^\/api\/reminders\/(\d+)$/);
      if (delMatch) {
        const idx = parseInt(delMatch[1]);
        const reminders = loadReminders();
        if (idx < 0 || idx >= reminders.length) {
          sendJSON(res, 404, { error: 'Not found' });
          return;
        }
        const deleted = reminders.splice(idx, 1)[0];
        saveReminders(reminders);
        if (onRemindersChanged) onRemindersChanged();
        console.log(`[Editor] Reminder DELETED [${idx}]: "${deleted.task}"`);
        sendJSON(res, 200, { ok: true });
        return;
      }

      // API: POST /api/reminders/import
      if (req.method === 'POST' && url.pathname === '/api/reminders/import') {
        const data = await parseBody(req);
        const mode = data.mode; // 'merge' or 'replace'
        const incoming = data.reminders;
        if (!Array.isArray(incoming)) {
          sendJSON(res, 400, { error: 'reminders must be an array' });
          return;
        }
        let reminders;
        if (mode === 'replace') {
          reminders = incoming;
        } else {
          reminders = loadReminders();
          reminders.push(...incoming);
        }
        saveReminders(reminders);
        if (onRemindersChanged) onRemindersChanged();
        console.log(`[Editor] Reminders IMPORTED (${mode}): ${incoming.length} items, total now: ${reminders.length}`);
        sendJSON(res, 200, { ok: true, count: reminders.length });
        return;
      }

      // API: GET /api/last-processed
      if (req.method === 'GET' && url.pathname === '/api/last-processed') {
        try {
          const data = JSON.parse(fs.readFileSync(LAST_PROCESSED_FILE, 'utf8'));
          sendJSON(res, 200, data);
        } catch {
          sendJSON(res, 200, { groups: {} });
        }
        return;
      }

      // API: PUT /api/last-processed
      if (req.method === 'PUT' && url.pathname === '/api/last-processed') {
        const data = await parseBody(req);
        fs.writeFileSync(LAST_PROCESSED_FILE, JSON.stringify(data, null, 2), 'utf8');
        if (onLastProcessedChanged) onLastProcessedChanged();
        console.log('[Editor] Last processed UPDATED:', JSON.stringify(data));
        sendJSON(res, 200, { ok: true });
        return;
      }

      // API: GET /api/fruits-schedule
      if (req.method === 'GET' && url.pathname === '/api/fruits-schedule') {
        try {
          const data = JSON.parse(fs.readFileSync(FRUITS_SCHEDULE_FILE, 'utf8'));
          sendJSON(res, 200, data);
        } catch {
          sendJSON(res, 200, { last_scheduled_date: null });
        }
        return;
      }

      // API: PUT /api/fruits-schedule
      if (req.method === 'PUT' && url.pathname === '/api/fruits-schedule') {
        const data = await parseBody(req);
        fs.writeFileSync(FRUITS_SCHEDULE_FILE, JSON.stringify(data, null, 2), 'utf8');
        if (onFruitsScheduleChanged) onFruitsScheduleChanged();
        console.log('[Editor] Fruits schedule UPDATED:', JSON.stringify(data));
        sendJSON(res, 200, { ok: true });
        return;
      }

      // API: GET /api/full-state
      if (req.method === 'GET' && url.pathname === '/api/full-state') {
        const state = {
          reminders: loadReminders(),
          events: (() => { try { return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch { return []; } })(),
          last_processed: (() => { try { return JSON.parse(fs.readFileSync(LAST_PROCESSED_FILE, 'utf8')); } catch { return { groups: {} }; } })(),
          fruits_schedule: (() => { try { return JSON.parse(fs.readFileSync(FRUITS_SCHEDULE_FILE, 'utf8')); } catch { return { last_scheduled_date: null }; } })()
        };
        sendJSON(res, 200, state);
        return;
      }

      // API: GET /api/events
      if (req.method === 'GET' && url.pathname === '/api/events') {
        try {
          const data = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
          sendJSON(res, 200, data);
        } catch {
          sendJSON(res, 200, []);
        }
        return;
      }

      // API: PUT /api/events (replace all events)
      if (req.method === 'PUT' && url.pathname === '/api/events') {
        const data = await parseBody(req);
        fs.writeFileSync(EVENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
        if (onEventsChanged) onEventsChanged();
        console.log(`[Editor] Events REPLACED: ${data.length} items`);
        sendJSON(res, 200, { ok: true });
        return;
      }

      // API: GET /api/activity-log
      if (req.method === 'GET' && url.pathname === '/api/activity-log') {
        if (getActivityLog) {
          sendJSON(res, 200, getActivityLog());
        } else {
          // Fallback: read from file
          try {
            const data = JSON.parse(fs.readFileSync('/data/activity_log.json', 'utf8'));
            sendJSON(res, 200, data);
          } catch {
            sendJSON(res, 200, []);
          }
        }
        return;
      }

      // Serve the HTML UI
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildHtmlPage(reminderTimes));
        return;
      }

      sendJSON(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('Editor server error:', err);
      sendJSON(res, 500, { error: err.message });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Reminder editor UI running at http://0.0.0.0:${port}`);
  });
}

module.exports = { startEditor };
