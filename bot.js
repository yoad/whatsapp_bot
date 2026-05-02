// /addons/whatsapp_bot/bot.js
// Event-driven kindergarten task extractor — via whatsapp_client addon
const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs');
const { startEditor } = require('./reminder_editor');

// --- Timestamped logging ---
const _origLog = console.log;
const _origErr = console.error;
const _ts = () => new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });
console.log = (...args) => _origLog(`[${_ts()}]`, ...args);
console.error = (...args) => _origErr(`[${_ts()}]`, ...args);

// --- CONFIGURATION ---
console.log('Initializing WhatsApp Calendar Bot...');

let options;
try {
    options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
    console.log('Loaded options.json successfully. Keys:', Object.keys(options));
} catch (err) {
    console.error('FATAL: Could not read /data/options.json:', err.message);
    process.exit(1);
}

const EXTRACT_TASKS = options.EXTRACT_TASKS !== undefined ? options.EXTRACT_TASKS : true;
const SEND_REMINDERS = options.SEND_REMINDERS !== undefined ? options.SEND_REMINDERS : true;
const TEST_GEMINI = options.TEST_GEMINI !== undefined ? options.TEST_GEMINI : false;
const RESET_LAST_PROCESSED = options.RESET_LAST_PROCESSED !== undefined ? options.RESET_LAST_PROCESSED : false;
const SAFE_MODE = options.SAFE_MODE !== undefined ? options.SAFE_MODE : false;
const SEND_SUMMARY_OLD_MESSAGES = options.SEND_SUMMARY_OLD_MESSAGES !== undefined ? options.SEND_SUMMARY_OLD_MESSAGES : false;
const ADD_FRUITS_REMINDER_FLAMENGO = options.ADD_FRUITS_REMINDER_FLAMENGO !== undefined ? options.ADD_FRUITS_REMINDER_FLAMENGO : true;
const REMINDER_MORNING_TIME = options.REMINDER_MORNING_TIME || '08:00';
const REMINDER_EVENING_TIME = options.REMINDER_EVENING_TIME || '20:00';

function parseTimeConfig(value, fallback) {
    const keywords = { morning: [8, 0], evening: [20, 0] };
    if (keywords[value?.toLowerCase()]) return keywords[value.toLowerCase()];
    const parts = (value || fallback).split(':').map(Number);
    return parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]) ? parts : fallback.split(':').map(Number);
}
const MORNING_HM = parseTimeConfig(REMINDER_MORNING_TIME, '08:00');
const EVENING_HM = parseTimeConfig(REMINDER_EVENING_TIME, '20:00');

// Build group pairs: incoming -> outgoing
const groupPairs = [];

if (options.INCOMING_GROUP_ID && options.OUTGOING_GROUP_ID) {
    groupPairs.push({
        label: options.GROUP_NAME_1 || 'Group 1',
        incomingId: options.INCOMING_GROUP_ID,
        outgoingId: options.OUTGOING_GROUP_ID,
        calendarId: options.CALENDAR_ID_1 || null
    });
}

if (options.INCOMING_GROUP_ID_2 && options.OUTGOING_GROUP_ID_2) {
    groupPairs.push({
        label: options.GROUP_NAME_2 || 'Group 2',
        incomingId: options.INCOMING_GROUP_ID_2,
        outgoingId: options.OUTGOING_GROUP_ID_2,
        calendarId: options.CALENDAR_ID_2 || null
    });
}

// Build group name lookups
const GROUP_NAMES = {};  // outgoing group ID -> display name
const INCOMING_GROUP_NAMES = {};  // incoming group ID -> display name
groupPairs.forEach(gp => {
    GROUP_NAMES[gp.outgoingId] = gp.label;
    INCOMING_GROUP_NAMES[gp.incomingId] = gp.label;
});

if (groupPairs.length === 0) {
    console.error('FATAL: No group pairs configured. Set at least INCOMING_GROUP_ID + OUTGOING_GROUP_ID.');
    process.exit(1);
}


if (!process.env.SUPERVISOR_TOKEN) {
    console.error('WARNING: SUPERVISOR_TOKEN not available — Gemini calls via HA will not work.');
}

// Log configuration
console.log('--- Group Pairs ---');
groupPairs.forEach(gp => {
    console.log(`  ${gp.label}: ${gp.incomingId} -> ${gp.outgoingId}`);
});
console.log(`Gemini: via HA google_generative_ai_conversation integration`);
console.log(`EXTRACT_TASKS = ${EXTRACT_TASKS}`);
console.log(`SEND_REMINDERS = ${SEND_REMINDERS}`);
console.log(`TEST_GEMINI = ${TEST_GEMINI}`);

if (SAFE_MODE) {
    console.log('*** SAFE_MODE: Only the web UI will start — everything else is disabled ***');
}

// Build incoming ID -> group pair lookup
const incomingMap = {};
groupPairs.forEach(gp => { incomingMap[gp.incomingId] = gp; });

// ────────────────────────────────────────────────────────────
// HA EVENT HELPERS
// ────────────────────────────────────────────────────────────
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const WS_RECONNECT_DELAY_MS = 5000;

async function fireHAEvent(eventType, eventData) {
    if (!SUPERVISOR_TOKEN) return;
    try {
        await axios.post(
            `http://supervisor/core/api/events/${eventType}`,
            eventData,
            {
                headers: {
                    'Authorization': `Bearer ${SUPERVISOR_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );
    } catch (err) {
        console.error(`[HA] Failed to fire event ${eventType}: ${err.message}`);
    }
}

async function sendWhatsAppMessage(chatId, text, timeoutMs = 30000) {
    const requestId = `send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[Send] Firing whatsapp_command_send to ${chatId} (${text.substring(0, 60)}...)`);

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingFetchRequests.delete(requestId);
            reject(new Error(`Send timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        pendingFetchRequests.set(requestId, { resolve, reject, timer });

        fireHAEvent('whatsapp_command_send', {
            app_id: 'bot',
            request_id: requestId,
            target_id: chatId,
            message: text
        }).catch(err => {
            pendingFetchRequests.delete(requestId);
            clearTimeout(timer);
            reject(err);
        });
    });
}

// Pending fetch requests (for correlating whatsapp_response events)
const pendingFetchRequests = new Map(); // requestId -> { resolve, reject, timer }

async function fetchMessagesViaHA(groupId, limit = 50, timeoutMs = 30000) {
    const requestId = `fetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingFetchRequests.delete(requestId);
            reject(new Error(`Fetch timeout after ${timeoutMs}ms for ${groupId}`));
        }, timeoutMs);

        pendingFetchRequests.set(requestId, { resolve, reject, timer });

        fireHAEvent('whatsapp_command_fetch', {
            app_id: 'bot',
            request_id: requestId,
            group_id: groupId,
            limit: limit
        }).catch(err => {
            pendingFetchRequests.delete(requestId);
            clearTimeout(timer);
            reject(err);
        });
    });
}

function handleFetchResponse(eventData) {
    const { request_id, data, success, error } = eventData;
    const pending = pendingFetchRequests.get(request_id);
    if (!pending) return;

    pendingFetchRequests.delete(request_id);
    clearTimeout(pending.timer);

    if (success) {
        pending.resolve({ data: data || [] });
    } else {
        pending.reject(new Error(error || 'Fetch failed'));
    }
}


// --- Helpers ---
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function retry(fn, label, maxRetries = 3, delayMs = 15000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[${label}] Attempt ${attempt}/${maxRetries}...`);
            return await fn();
        } catch (err) {
            console.error(`[${label}] Attempt ${attempt} failed: ${err.message}`);
            if (attempt === maxRetries) throw err;
            console.log(`[${label}] Waiting ${delayMs / 1000}s before retry...`);
            await delay(delayMs);
        }
    }
}

function israelNow() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
}

// --- MESSAGE BATCHING ---
const LIVE_BATCH_DELAY_MS = 2 * 60 * 1000; // 2 minutes
const OLD_MSG_GROUP_GAP_S = 30 * 60;       // 30 minutes (in seconds)
const messageBatchBuffers = new Map();      // groupId -> { messages: [], timer, type }
const groupsBeingProcessed = new Set();     // groupIds currently mid-processing (prevents catch-up races)

function addToBatch(groupId, msgData, type, groupPairOrNull) {
    // msgData: { body, timestamp, sender, msgObj? (for notes reactions), id? (for edit matching) }
    let buffer = messageBatchBuffers.get(groupId);
    const isFirst = !buffer;
    if (!buffer) {
        buffer = { messages: [], timer: null, type, groupPair: groupPairOrNull };
        messageBatchBuffers.set(groupId, buffer);
    }

    buffer.messages.push(msgData);
    console.log(`[Batch][${type}] Buffered message in ${groupId} (${buffer.messages.length} total). Timer reset to 2 min.`);

    // Log a 'received' entry only for the first message in a new batch
    if (isFirst) {
        const groupLabel = groupPairOrNull ? groupPairOrNull.label : groupId;
        addActivityLogEntry({
            timestamp: msgData.timestamp,
            group: groupId,
            groupLabel: groupLabel,
            type: type,
            messageCount: 1,
            messagePreview: msgData.body.substring(0, 200),
            senders: msgData.sender ? [msgData.sender] : ['\u05d0\u05e0\u05d9'], // אני
            outcome: ['received'],
            outcomeDetails: ['\u23f3 \u05d4\u05d5\u05d3\u05e2\u05d4 \u05d4\u05ea\u05e7\u05d1\u05dc\u05d4, \u05de\u05de\u05ea\u05d9\u05df 2 \u05d3\u05e7\u05d5\u05ea...'], // ⏳ הודעה התקבלה, ממתין 2 דקות...
            status: 'waiting'
        });
    }

    // Reset the 2-minute timer
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => flushBatch(groupId), LIVE_BATCH_DELAY_MS);
}

function handleMessageEditInBatch(groupId, editedMsgId, newBody) {
    const buffer = messageBatchBuffers.get(groupId);
    if (!buffer || buffer.messages.length === 0) return;

    // Update the edited message content in the buffer
    const existing = buffer.messages.find(m => m.id === editedMsgId);
    if (existing) {
        if (!newBody || newBody.trim() === '') {
            console.log(`[Batch] Edit for ${editedMsgId} has empty body — ignoring (likely link preview update).`);
            return;
        }
        console.log(`[Batch] Message ${editedMsgId} was edited in ${groupId}. Updating content & resetting timer.`);
        existing.body = newBody;
    } else {
        console.log(`[Batch] Edit detected for ${editedMsgId} in ${groupId} but not found in buffer. Resetting timer anyway.`);
    }

    // Reset the timer so we wait another 2 minutes
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => flushBatch(groupId), LIVE_BATCH_DELAY_MS);
}

async function flushBatch(groupId) {
    const buffer = messageBatchBuffers.get(groupId);
    if (!buffer || buffer.messages.length === 0) return;

    const messages = buffer.messages.slice(); // copy
    const type = buffer.type;
    const groupPair = buffer.groupPair;
    messageBatchBuffers.delete(groupId);

    console.log(`[Batch] Flushing ${messages.length} ${type} message(s) from ${groupId}`);

    groupsBeingProcessed.add(groupId);
    try {
        if (type === 'kindergarten' && groupPair) {
            await processMessageBatch(groupPair, messages);
        }
    } catch (err) {
        console.error(`[Batch] Error flushing ${type} batch for ${groupId}:`, err.message);
    } finally {
        groupsBeingProcessed.delete(groupId);
    }
}

function groupMessagesByTimeGap(messages, gapSeconds) {
    if (messages.length === 0) return [];
    // messages should already be sorted by timestamp
    const groups = [[messages[0]]];
    for (let i = 1; i < messages.length; i++) {
        const prev = messages[i - 1];
        const curr = messages[i];
        if (curr.timestamp - prev.timestamp <= gapSeconds) {
            groups[groups.length - 1].push(curr);
        } else {
            groups.push([curr]);
        }
    }
    return groups;
}

// --- GEMINI via HA: call ai_task.generate_data ---
async function callGeminiViaHA(prompt) {
    if (!SUPERVISOR_TOKEN) throw new Error('SUPERVISOR_TOKEN not available — cannot call Gemini via HA');

    let response;
    try {
        response = await axios.post(
            'http://supervisor/core/api/services/ai_task/generate_data?return_response',
            {
                task_name: 'whatsapp_bot_extract',
                entity_id: 'ai_task.google_ai_task',
                instructions: prompt
            },
            {
                headers: {
                    'Authorization': `Bearer ${SUPERVISOR_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                timeout: 120000
            }
        );
    } catch (err) {
        if (err.response) {
            console.error(`ai_task.generate_data returned HTTP ${err.response.status}. Response body:`, JSON.stringify(err.response.data, null, 2));
            console.error(`Prompt length: ${prompt.length} chars`);
        }
        throw err;
    }

    // ai_task.generate_data returns { service_response: { data: "...", conversation_id: "..." } }
    const serviceResponse = response.data?.service_response;
    const text = serviceResponse?.data;
    if (!text) {
        console.error('AI task response missing data. Full response:', JSON.stringify(response.data, null, 2));
        throw new Error('No data in AI task response');
    }

    return text;
}

// --- GEMINI: Extract tasks with dates ---
async function extractTasksWithGemini(messagesText, messageTimestamp, existingEventsText) {
    // Use the message's sent date for relative date calculations (e.g. "tomorrow", "next Sunday")
    const messageDate = messageTimestamp
        ? new Date(messageTimestamp * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' })
        : israelNow().toISOString().split('T')[0];



    const prompt = `אתה עוזר להורים לגן ילדים. התאריך של ההודעה הוא ${messageDate}.
להלן הודעות מקבוצת ואטסאפ של גן ילדים, כל הודעה מסומנת באינדקס (מ-0).
המשימה שלך: חלץ רק משימות/פעולות שההורים צריכים לבצע.

כללים:
- לא כל הודעה מכילה משימה להורים. התעלם מהודעות שהן רק שיחה, ברכות, תודות, או עדכונים כלליים ללא פעולה נדרשת.
- הודעה אחת יכולה להכיל כמה משימות. חלץ כל אחת בנפרד.
- אחד משימות שקשורות לאותו אירוע לפריט אחד. למשל: אם יש זום בשעה 9 וצריך להביא כלי הקשה לזום - זו משימה אחת (\"להצטרף לזום בשעה 9:00 ולהביא כלי הקשה\"), לא שתי משימות נפרדות.
- פצל רק אם יש פעולות שונות בשעות שונות (למשל אחת ב-9:00 ואחת ב-13:30).
- כתוב את הסיכום בעברית.
- רוב המשימות הן להביא/לשלוח משהו עם הילדים ביום מסוים. כתוב "ביום X" ולא "עד יום X".
  דוגמה נכונה: "לשלוח אביזרי ליצן עם הילדים ביום שני 23.2"
  דוגמה לא נכונה: "לשלוח אביזרי ליצן עם הילדים עד יום שני 23.2"
- אם כתוב "אם יש" או "מי שרוצה" - ציין זאת בתיאור המשימה (למשל: "אופציונלי").
- אם משימה שחולצה כבר מכוסה על ידי אירוע קיים (אותו אירוע/פעולה באותו תאריך ואותם פרטים), סמן אותה עם "duplicate": true.
- אם משימה שחולצה דומה לאירוע קיים אבל יש שינוי (למשל שעה שונה, תאריך שונה, פרטים מעודכנים) - זהו תיקון. סמן "duplicate": false ושים ב-"replaces" את האינדקס (מספר) או מערך של אינדקסים של האירועים הקיימים שהמשימה מחליפה.
- אם תיקון אחד מחליף כמה אירועים קיימים (למשל: "מפגש מאוחד" מחליף שני מפגשים נפרדים לקבוצה א' וקבוצה ב'), שים את כל האינדקסים של האירועים המוחלפים במערך ב-"replaces". לדוגמה: "replaces": [3, 4].

${existingEventsText ? `אירועים קיימים שכבר נרשמו לקבוצה זו:\n${existingEventsText}\n\n` : ''}החזר את התשובה בפורמט JSON בלבד, בלי שום טקסט נוסף, בלי markdown, בלי backticks.
הפורמט:
{
  "has_tasks": true/false,
  "tasks": [
    {
      "description": "תיאור המשימה",
      "due_date": "YYYY-MM-DD או null אם אין תאריך ברור",
      "event_time": "HH:MM או null אם אין שעה ספציפית מצוינת",
      "event_duration_minutes": "מספר דקות או null אם לא ברור. למשל אם כתוב 'בין 10 ל-12' אז 120",
      "source_index": "האינדקס (0-based) של ההודעה המקורית שממנה חולצה המשימה",
      "duplicate": "true אם המשימה זהה לחלוטין לאירוע קיים, אחרת false",
      "replaces": "אינדקס אחד (מספר) או מערך של אינדקסים של אירועים קיימים שהמשימה מחליפה (תיקון), או null אם אין תיקון. דוגמה: 3 או [3, 4]"
    }
  ],
  "summary_text": "סיכום טקסטואלי של המשימות כרשימה ממוספרת, או 'אין משימות חדשות להורים.'"
}

שים לב:
- אם כתוב "מחר" חשב לפי התאריך של ההודעה (${messageDate})
- אם כתוב "יום ראשון/שני/שלישי" וכו', חשב את התאריך הקרוב ביותר ביחס לתאריך ההודעה
- אם אין תאריך מפורש או משתמע, שים null ב-due_date

הודעה:
${messagesText}`;

    const text = await callGeminiViaHA(prompt);
    try {
        const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        return JSON.parse(cleaned);
    } catch (e) {
        console.error('Failed to parse Gemini JSON response:', text);
        return { has_tasks: true, tasks: [], summary_text: text };
    }
}



// --- PERSISTENCE: last processed timestamp (per group) ---
const LAST_PROCESSED_FILE = '/data/last_processed.json';
let lastProcessedMap = {};

function loadLastProcessed() {
    const oneYearAgoTs = Math.floor((Date.now() - 365 * 24 * 60 * 60 * 1000) / 1000);

    // Reset if flag is set
    if (RESET_LAST_PROCESSED) {
        console.log('*** RESET_LAST_PROCESSED is ON - deleting last_processed.json ***');
        try { fs.unlinkSync(LAST_PROCESSED_FILE); } catch { }
        lastProcessedMap = {};
        console.log('*** Remember to set RESET_LAST_PROCESSED back to false! ***');
    } else {
        try {
            const raw = fs.readFileSync(LAST_PROCESSED_FILE, 'utf8');
            console.log('last_processed.json contents:', raw);
            const data = JSON.parse(raw);
            if (typeof data.timestamp === 'number' && !data.groups) {
                groupPairs.forEach(gp => { lastProcessedMap[gp.incomingId] = data.timestamp; });
            } else if (data.groups) {
                lastProcessedMap = data.groups;
            }
        } catch {
            console.log('No previous last_processed.json found.');
        }
    }

    // Initialize missing groups with timestamp from 1 year ago and save to verify file access
    let needsSave = false;
    const allGroupIds = groupPairs.map(gp => gp.incomingId);
    allGroupIds.forEach(id => {
        if (!lastProcessedMap[id]) {
            lastProcessedMap[id] = oneYearAgoTs;
            needsSave = true;
            console.log(`[${id}] No last_processed found, defaulting to 1 year ago (${new Date(oneYearAgoTs * 1000).toISOString()})`);
        }
    });
    if (needsSave) {
        fs.writeFileSync(LAST_PROCESSED_FILE, JSON.stringify({ groups: lastProcessedMap }, null, 2), 'utf8');
        console.log(`Saved default last_processed.json to ${LAST_PROCESSED_FILE}`);
    }
    console.log('Last processed timestamps:', lastProcessedMap);
}

function saveLastProcessed(incomingId, timestamp) {
    lastProcessedMap[incomingId] = timestamp;
    fs.writeFileSync(LAST_PROCESSED_FILE, JSON.stringify({ groups: lastProcessedMap }, null, 2), 'utf8');
    console.log(`Last processed saved for ${incomingId}: ${timestamp} (${new Date(timestamp * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })})`);
}

function getLastProcessed(incomingId) {
    return lastProcessedMap[incomingId] || 0;
}

if (!SAFE_MODE) {
    loadLastProcessed();
} else {
    console.log('[SAFE_MODE] Skipping last_processed loading.');
}

// --- PERSISTENCE: scheduled reminders ---
const REMINDERS_FILE = '/data/reminders.json';
let scheduledReminders = [];

function loadReminders() {
    try {
        scheduledReminders = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
        const now = Date.now();
        const TWO_HOURS = 2 * 60 * 60 * 1000;
        const before = scheduledReminders.length;
        scheduledReminders = scheduledReminders.filter(r => {
            if (r.send_at > now) return true; // future reminder, keep
            if (now - r.send_at <= TWO_HOURS) return true; // past but within 2h, keep for retry
            return false; // expired (2h+ past due), remove
        });
        const expired = before - scheduledReminders.length;
        if (expired > 0) console.log(`Removed ${expired} expired reminders (2h+ past due).`);
        saveReminders();
        console.log(`Loaded ${scheduledReminders.length} pending reminders:`);
        scheduledReminders.forEach((r, i) => {
            const sendAt = new Date(r.send_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
            console.log(`  ${i + 1}. [${r.type}] "${r.task}" -> ${sendAt}`);
        });
    } catch {
        scheduledReminders = [];
        console.log('No previous reminders.json found.');
    }
    if (global.rescheduleNextReminder) global.rescheduleNextReminder();
}

function saveReminders() {
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify(scheduledReminders, null, 2), 'utf8');
}

function addReminder(taskDescription, sendAt, type, originalTs, outgoingId, eventId) {
    scheduledReminders.push({
        task: taskDescription,
        send_at: sendAt,
        type: type,
        original_message_ts: originalTs || 0,
        outgoing_group_id: outgoingId,
        event_id: eventId || null,
        sent: false
    });
    saveReminders();
    if (global.rescheduleNextReminder) global.rescheduleNextReminder();
}

function scheduleTaskReminders(taskDescription, dueDateStr, originalTs, outgoingId, eventTime, eventId) {
    if (!dueDateStr || !SEND_REMINDERS) return;

    try {
        const [year, month, day] = dueDateStr.split('-').map(Number);

        // Evening reminder: the evening BEFORE the due date
        const eveningDate = new Date(year, month - 1, day);
        eveningDate.setDate(eveningDate.getDate() - 1);
        const eveningMs = getIsraelTimestampMs(eveningDate.getFullYear(), eveningDate.getMonth(), eveningDate.getDate(), EVENING_HM[0], EVENING_HM[1]);

        // Morning reminder: the morning OF the due date
        const morningMs = getIsraelTimestampMs(year, month - 1, day, MORNING_HM[0], MORNING_HM[1]);
        const now = Date.now();
        const MIN_GAP_MS = 5 * 60 * 60 * 1000; // 5 hours minimum gap

        for (const [label, ms, type] of [['Evening', eveningMs, 'evening'], ['Morning', morningMs, 'morning']]) {
            if (ms <= now) continue;
            if (ms - now < MIN_GAP_MS) {
                console.log(`  ${label} reminder skipped (only ${Math.round((ms - now) / 3600000)}h gap, need 5h)`);
            } else {
                addReminder(taskDescription, ms, type, originalTs, outgoingId, eventId);
                console.log(`  ${label} reminder -> ${new Date(ms).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);
            }
        }

        // Zoom tasks: add a 1-hour-before reminder
        const isZoom = /zoom|זום/i.test(taskDescription);
        if (isZoom && eventTime) {
            const [h, m] = eventTime.split(':').map(Number);
            const oneHourBefore = h * 60 + m - 60; // minutes since midnight, minus 1 hour
            if (oneHourBefore >= 0) {
                const beforeH = Math.floor(oneHourBefore / 60);
                const beforeM = oneHourBefore % 60;
                const beforeMs = getIsraelTimestampMs(year, month - 1, day, beforeH, beforeM);
                if (beforeMs > now) {
                    addReminder(`📹 תזכורת: ${taskDescription} - עוד שעה!`, beforeMs, 'zoom_soon', originalTs, outgoingId, eventId);
                    console.log(`  Zoom 1h-before reminder -> ${new Date(beforeMs).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);
                }
            }
        }
    } catch (err) {
        console.error(`Failed to schedule reminders for "${taskDescription}":`, err.message);
    }
}

// --- PERSISTENCE: events registry ---
const EVENTS_FILE = '/data/events.json';
let registeredEvents = [];

function loadEvents() {
    try {
        registeredEvents = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
        // Prune past events (due_date < today)
        const today = israelNow().toISOString().split('T')[0];
        const before = registeredEvents.length;
        registeredEvents = registeredEvents.filter(e => !e.due_date || e.due_date >= today);
        const pruned = before - registeredEvents.length;
        if (pruned > 0) {
            console.log(`[Events] Pruned ${pruned} past event(s).`);
            saveEvents();
        }
        console.log(`[Events] Loaded ${registeredEvents.length} active event(s).`);
    } catch {
        registeredEvents = [];
        console.log('[Events] No previous events.json found.');
    }
}

function saveEvents() {
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(registeredEvents, null, 2), 'utf8');
}

function addEvent(description, dueDate, eventTime, groupId) {
    const id = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const event = {
        id,
        description,
        due_date: dueDate,
        event_time: eventTime || null,
        group_id: groupId,
        calendar_uid: null,
        calendar_entity_id: null,
        created_at: Math.floor(Date.now() / 1000)
    };
    registeredEvents.push(event);
    saveEvents();
    console.log(`  [Events] Created event ${id}: "${description}" on ${dueDate}${eventTime ? ' ' + eventTime : ''}`);
    return id;
}

function updateEventCalendarInfo(eventId, calendarUid, calendarEntityId) {
    const event = registeredEvents.find(e => e.id === eventId);
    if (event) {
        event.calendar_uid = calendarUid;
        event.calendar_entity_id = calendarEntityId;
        saveEvents();
        console.log(`  [Events] Stored calendar UID ${calendarUid} for event ${eventId}`);
    }
}

async function removeEventAndReminders(eventId, groupId) {
    // Find event to get calendar info before removing
    const event = registeredEvents.find(e => e.id === eventId);
    let eventDesc = eventId;

    // Delete calendar event if we have the UID
    if (event && event.calendar_uid && event.calendar_entity_id) {
        try {
            await deleteCalendarEvent(event.calendar_entity_id, event.calendar_uid);
            console.log(`  [Events] Deleted calendar event UID ${event.calendar_uid}`);
        } catch (calErr) {
            console.error(`  [Events] Failed to delete calendar event: ${calErr.message}`);
        }
    }

    // Remove event from registry
    const eventIdx = registeredEvents.findIndex(e => e.id === eventId);
    if (eventIdx >= 0) {
        eventDesc = registeredEvents[eventIdx].description;
        registeredEvents.splice(eventIdx, 1);
        saveEvents();
        console.log(`  [Events] Removed event ${eventId}: "${eventDesc}"`);
    }
    // Remove all linked reminders
    const before = scheduledReminders.length;
    scheduledReminders = scheduledReminders.filter(r => r.event_id !== eventId);
    const removed = before - scheduledReminders.length;
    if (removed > 0) {
        console.log(`  [Events] Removed ${removed} reminder(s) linked to event ${eventId}`);
        saveReminders();
        if (global.rescheduleNextReminder) global.rescheduleNextReminder();
    }
    return removed;
}

function getExistingEventsContext(groupId) {
    const today = israelNow().toISOString().split('T')[0];
    const relevant = registeredEvents.filter(e =>
        e.group_id === groupId && (!e.due_date || e.due_date >= today)
    );
    if (relevant.length === 0) return { text: '', events: [] };
    const text = relevant.map((e, i) => {
        const time = e.event_time ? ` ${e.event_time}` : '';
        return `[${i}] ${e.due_date || '?'}${time} - ${e.description}`;
    }).join('\n');
    return { text, events: relevant };
}

function getIsraelTimestampMs(year, month, day, hours, minutes) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
    const testDate = new Date(`${dateStr}Z`);
    const israelHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }).format(testDate));
    const offset = israelHour - testDate.getUTCHours();
    const utcDate = new Date(`${dateStr}Z`);
    utcDate.setUTCHours(utcDate.getUTCHours() - offset);
    return utcDate.getTime();
}

if (!SAFE_MODE) {
    loadReminders();
    loadEvents();
} else {
    console.log('[SAFE_MODE] Skipping reminders/events loading.');
}

// --- PERSISTENCE: activity log ---
const ACTIVITY_LOG_FILE = '/data/activity_log.json';
const MAX_ACTIVITY_LOG = 100;
let activityLog = [];

function loadActivityLog() {
    try {
        activityLog = JSON.parse(fs.readFileSync(ACTIVITY_LOG_FILE, 'utf8'));
        console.log(`Loaded ${activityLog.length} activity log entries.`);
    } catch {
        activityLog = [];
    }
}

function saveActivityLog() {
    // Keep only last MAX_ACTIVITY_LOG entries
    if (activityLog.length > MAX_ACTIVITY_LOG) {
        activityLog = activityLog.slice(-MAX_ACTIVITY_LOG);
    }
    fs.writeFileSync(ACTIVITY_LOG_FILE, JSON.stringify(activityLog, null, 2), 'utf8');
}

function addActivityLogEntry(entry) {
    // entry: { timestamp, group, groupLabel, type, messageCount, messagePreview, outcome, outcomeDetails }
    activityLog.push({
        ...entry,
        logged_at: Date.now()
    });
    saveActivityLog();
}

function getActivityLog() {
    return activityLog;
}

loadActivityLog();

// Periodic safety save every 2 hours
setInterval(() => {
    saveActivityLog();
}, 2 * 60 * 60 * 1000);

// --- PERSISTENCE: fruits schedule tracking ---
const FRUITS_SCHEDULE_FILE = '/data/fruits_schedule.json';
let fruitsSchedule = { last_scheduled_date: null };

function loadFruitsSchedule() {
    try {
        fruitsSchedule = JSON.parse(fs.readFileSync(FRUITS_SCHEDULE_FILE, 'utf8'));
        console.log('Loaded fruits schedule:', JSON.stringify(fruitsSchedule));
    } catch {
        fruitsSchedule = { last_scheduled_date: null };
        console.log('No previous fruits_schedule.json found.');
    }
}

function saveFruitsSchedule() {
    fs.writeFileSync(FRUITS_SCHEDULE_FILE, JSON.stringify(fruitsSchedule, null, 2), 'utf8');
}

// --- AUTOMATIC FRUIT REMINDERS ---
const FLAMENGO_OUTGOING_ID = '120363424238663971@g.us';

async function generateFruitReminders() {
    if (!ADD_FRUITS_REMINDER_FLAMENGO) {
        console.log('[Fruits] ADD_FRUITS_REMINDER_FLAMENGO is OFF, skipping.');
        return;
    }

    console.log('');
    console.log('=== FRUIT REMINDERS: Generating for next 2 weeks ===');
    const now = israelNow();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const twoWeeksOut = new Date(today);
    twoWeeksOut.setDate(twoWeeksOut.getDate() + 14);
    console.log(`[Fruits] Today: ${today.toISOString().split('T')[0]} | Window: until ${twoWeeksOut.toISOString().split('T')[0]}`);
    console.log(`[Fruits] Last scheduled date: ${fruitsSchedule.last_scheduled_date || 'none (first run)'}`);

    // Determine which dates are already covered
    const lastScheduled = fruitsSchedule.last_scheduled_date
        ? new Date(fruitsSchedule.last_scheduled_date)
        : null;

    let maxScheduledDate = lastScheduled ? new Date(lastScheduled) : null;
    let addedCount = 0;

    // Iterate through the next 14 days
    for (let d = new Date(today); d <= twoWeeksOut; d.setDate(d.getDate() + 1)) {
        const dayOfWeek = d.getDay(); // 0=Sunday, 2=Tuesday
        if (dayOfWeek !== 0 && dayOfWeek !== 2) continue;

        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const dateForCompare = new Date(d);

        // Skip dates already covered
        if (lastScheduled && dateForCompare <= lastScheduled) {
            console.log(`[Fruits] ${dateStr} (${dayOfWeek === 0 ? 'Sunday' : 'Tuesday'}) - already covered, skipping.`);
            continue;
        }

        const dayNameHeb = dayOfWeek === 0 ? 'ראשון' : 'שלישי';
        const nowMs = Date.now();
        const fruitDesc = `להביא פירות לגן (יום ${dayNameHeb})`;

        // Create event in registry
        const eventId = addEvent(fruitDesc, dateStr, null, FLAMENGO_OUTGOING_ID);

        // Evening reminder: Saturday evening (for Sunday) or Monday evening (for Tuesday)
        const eveningDate = new Date(d);
        eveningDate.setDate(eveningDate.getDate() - 1); // day before
        const eveningMs = getIsraelTimestampMs(eveningDate.getFullYear(), eveningDate.getMonth(), eveningDate.getDate(), 20, 0);

        if (eveningMs > nowMs) {
            addReminder(
                `🍎 תזכורת: להביא פירות לגן מחר (יום ${dayNameHeb})`,
                eveningMs,
                'evening',
                0,
                FLAMENGO_OUTGOING_ID,
                eventId
            );
            addedCount++;
            const eveningStr = new Date(eveningMs).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
            console.log(`[Fruits] Added evening reminder for ${dateStr} -> ${eveningStr}`);
        }

        // Morning reminder: Sunday morning or Tuesday morning
        const morningMs = getIsraelTimestampMs(d.getFullYear(), d.getMonth(), d.getDate(), 6, 45);

        if (morningMs > nowMs) {
            addReminder(
                `🍎 תזכורת: להביא פירות לגן היום (יום ${dayNameHeb})`,
                morningMs,
                'morning',
                0,
                FLAMENGO_OUTGOING_ID,
                eventId
            );
            addedCount++;
            const morningStr = new Date(morningMs).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
            console.log(`[Fruits] Added morning reminder for ${dateStr} -> ${morningStr}`);
        }

        // Create calendar event for this fruit day
        const flamengoGroup = groupPairs.find(gp => gp.outgoingId === FLAMENGO_OUTGOING_ID);
        if (flamengoGroup && flamengoGroup.calendarId) {
            try {
                // All-day event: HA requires end_date to be the NEXT day (exclusive)
                const nextDay = new Date(d);
                nextDay.setDate(nextDay.getDate() + 1);
                const endDateStr = `${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, '0')}-${String(nextDay.getDate()).padStart(2, '0')}`;
                const calSummary = `${flamengoGroup.label}: 🍎 ${fruitDesc}`;
                await createCalendarEvent({
                    summary: calSummary,
                    start_date: dateStr,
                    end_date: endDateStr,
                    entity_id: flamengoGroup.calendarId
                });
                console.log(`[Fruits] 📅 Calendar event created for ${dateStr}`);

                // Look up UID and store it
                try {
                    const calEvents = await getCalendarEvents(flamengoGroup.calendarId, dateStr, dateStr);
                    const match = calEvents.find(ce => ce.summary === calSummary);
                    if (match && match.uid) {
                        updateEventCalendarInfo(eventId, match.uid, flamengoGroup.calendarId);
                    }
                } catch (lookupErr) {
                    console.error(`[Fruits] UID lookup failed: ${lookupErr.message}`);
                }
            } catch (calErr) {
                console.error(`[Fruits] ❌ Calendar event failed for ${dateStr}: ${calErr.message}`);
            }
        }

        // Track the latest date we've covered
        if (!maxScheduledDate || dateForCompare > maxScheduledDate) {
            maxScheduledDate = new Date(dateForCompare);
        }
    }

    // Update persistence
    if (maxScheduledDate) {
        fruitsSchedule.last_scheduled_date = `${maxScheduledDate.getFullYear()}-${String(maxScheduledDate.getMonth() + 1).padStart(2, '0')}-${String(maxScheduledDate.getDate()).padStart(2, '0')}`;
        saveFruitsSchedule();
    }

    console.log(`[Fruits] Done. Added ${addedCount} new fruit reminders. Last scheduled date: ${fruitsSchedule.last_scheduled_date}`);
    console.log('=== FRUIT REMINDERS COMPLETE ===');
    console.log('');
}

if (!SAFE_MODE) {
    loadFruitsSchedule();

    // --- Precise reminder scheduling (setTimeout-based) ---
    let nextReminderTimer = null;

    function rescheduleNextReminder() {
        if (nextReminderTimer) { clearTimeout(nextReminderTimer); nextReminderTimer = null; }
        const now = Date.now();
        const TWO_HOURS = 2 * 60 * 60 * 1000;
        const pending = scheduledReminders.filter(r => !r.sent && r.send_at > now - TWO_HOURS);
        if (pending.length === 0) return;

        const nextMs = Math.min(...pending.map(r => r.send_at));
        const delay = Math.max(0, nextMs - now);
        console.log(`[Reminders] Next reminder in ${Math.round(delay / 60000)} min (${new Date(nextMs).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })})`);

        nextReminderTimer = setTimeout(async () => {
            const now = Date.now();
            const TWO_HOURS = 2 * 60 * 60 * 1000;
            const due = scheduledReminders.filter(r => !r.sent && r.send_at <= now);
            let changed = false;

            // Group due reminders by target group + type
            const groups = new Map();
            for (const reminder of due) {
                if (now - reminder.send_at > TWO_HOURS) {
                    console.log(`Reminder EXPIRED (2h past due), removing: "${reminder.task.substring(0, 50)}..."`);
                    reminder.sent = true;
                    changed = true;
                    continue;
                }
                const key = `${reminder.outgoing_group_id || groupPairs[0].outgoingId}|${reminder.type}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(reminder);
            }

            for (const [key, reminders] of groups) {
                const [targetGroupId, type] = key.split('|');
                const emoji = type === 'evening' ? '🌙' : type === 'morning' ? '☀️' : '🕐';
                const typeText = type === 'evening' ? 'תזכורת ערב' : type === 'morning' ? 'תזכורת בוקר' : 'תזכורת';

                // Check if all reminders came from the same original message
                const uniqueTs = new Set(reminders.map(r => r.original_message_ts).filter(Boolean));
                const sameSource = uniqueTs.size === 1;

                // Build task list
                const taskLines = reminders.map((r, i) => {
                    const perTaskDate = (!sameSource && r.original_message_ts)
                        ? `\n   _מהודעה שנשלחה ב ${new Date(r.original_message_ts * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}_`
                        : '';
                    return `${i + 1}. ${r.task}${perTaskDate}`;
                }).join('\n');

                // Single footer if all from same message
                const footer = sameSource && uniqueTs.size === 1
                    ? `\n\n_תזכורת מהודעה שנשלחה ב ${new Date([...uniqueTs][0] * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}_`
                    : '';

                const message = `${emoji} *${typeText}*\n\n${taskLines}${footer}`;

                try {
                    await sendWhatsAppMessage(targetGroupId, message);
                    console.log(`Reminder sent to ${targetGroupId} (${type}): ${reminders.length} task(s)`);
                    reminders.forEach(r => { r.sent = true; });
                    changed = true;

                    // When a morning/evening reminder fires, skip any zoom_soon reminders
                    // for the same group that are within ±2 hours of this reminder's send time
                    if (type === 'morning' || type === 'evening') {
                        const TWO_HOURS_SKIP = 2 * 60 * 60 * 1000;
                        const refTime = reminders[0].send_at; // the morning/evening send time
                        const zoomToSkip = scheduledReminders.filter(r =>
                            !r.sent &&
                            r.type === 'zoom_soon' &&
                            (r.outgoing_group_id || groupPairs[0].outgoingId) === targetGroupId &&
                            Math.abs(r.send_at - refTime) <= TWO_HOURS_SKIP
                        );
                        if (zoomToSkip.length > 0) {
                            zoomToSkip.forEach(r => {
                                console.log(`  Zoom reminder skipped (within ±2h of ${type} reminder): "${r.task.substring(0, 50)}..."`);
                                r.sent = true;
                            });
                            changed = true;
                        }
                    }

                    const groupLabel = GROUP_NAMES[targetGroupId] || INCOMING_GROUP_NAMES[targetGroupId] || targetGroupId;
                    addActivityLogEntry({
                        timestamp: Math.floor(Date.now() / 1000),
                        group: targetGroupId,
                        groupLabel: groupLabel,
                        type: 'reminder_sent',
                        messageCount: reminders.length,
                        messagePreview: taskLines.substring(0, 200),
                        senders: ['🤖 בוט'],
                        outcome: ['reminder_sent'],
                        outcomeDetails: [`${emoji} ${typeText}: ${reminders.length} משימות`],
                        reminderType: type
                    });
                } catch (err) {
                    console.error(`Failed to send ${reminders.length} reminder(s) (will retry in 1 min): ${err.message}`);
                    setTimeout(() => rescheduleNextReminder(), 60 * 1000);
                    return;
                }
            }

            if (changed) {
                scheduledReminders = scheduledReminders.filter(r => !r.sent);
                saveReminders();
            }
            rescheduleNextReminder();
        }, delay);
    }

    // Expose rescheduleNextReminder globally so addReminder and UI callbacks can call it
    global.rescheduleNextReminder = rescheduleNextReminder;

    // Kick off: schedule (or immediately send) the next pending reminder
    rescheduleNextReminder();

    // Generate fruit reminders every 6 hours
    setInterval(async () => {
        console.log('[Fruits] Periodic check (every 6 hours)...');
        await generateFruitReminders();
    }, 6 * 60 * 60 * 1000);

    // Heartbeat: log status every 2 minutes
    let heartbeatCount = 0;
    setInterval(() => {
        heartbeatCount++;
        const totalMin = heartbeatCount * 2;
        const days = Math.floor(totalMin / 1440);
        const hours = Math.floor((totalMin % 1440) / 60);
        const mins = totalMin % 60;
        const uptime = days > 0 ? `${days}d ${hours}h ${mins}m` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
        const nowStr = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        console.log(`[Heartbeat] ${nowStr} | Uptime: ${uptime} | Reminders pending: ${scheduledReminders.length}`);
    }, 2 * 60 * 1000);
} // end !SAFE_MODE

// --- MESSAGE PROCESSING (batched) ---
// Accepts an array of { body, timestamp, sender } entries and processes them as one block.
async function processMessageBatch(groupPair, messages, { skipSend = false } = {}) {
    // Build combined text
    const messagesText = messages.map((m, i) => {
        const dateStr = new Date(m.timestamp * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        return `[${i}] [${dateStr}] ${m.sender}: ${m.body}`;
    }).join('\n');

    const latestTimestamp = Math.max(...messages.map(m => m.timestamp));
    const combinedBody = messages.map(m => m.body).join('\n');
    const senders = [...new Set(messages.map(m => m.sender))];

    console.log(`[${groupPair.label}] Processing batch of ${messages.length} message(s)...`);

    try {
        if (!EXTRACT_TASKS) {
            console.log(`[${groupPair.label}] EXTRACT_TASKS is disabled. Skipping Gemini.`);
            return;
        }

        const { text: existingEventsText, events: existingEvents } = getExistingEventsContext(groupPair.outgoingId);
        if (existingEventsText) {
            console.log(`[${groupPair.label}] Including ${existingEvents.length} existing events as context for duplicate detection.`);
        }
        console.log(`[${groupPair.label}] Calling Gemini to extract parent tasks (batch of ${messages.length})...`);
        const result = await extractTasksWithGemini(messagesText, latestTimestamp, existingEventsText);
        console.log(`[${groupPair.label}] Gemini response:`, JSON.stringify(result, null, 2));

        // Build activity log details
        const outcomes = [];
        const outcomeDetails = [];

        if (result.has_tasks && result.summary_text && !result.summary_text.includes('אין משימות חדשות להורים')) {
            outcomes.push('tasks');
            if (skipSend) {
                console.log(`[${groupPair.label}] Tasks found but skipping send (old message).`);
                outcomeDetails.push('סיכום לא נשלח (הודעה ישנה)');
            } else {
                // Determine header based on task types
                const tasks = result.tasks || [];
                // Normalize replaces to always be an array (or null)
                for (const t of tasks) {
                    if (t.replaces != null && !Array.isArray(t.replaces)) {
                        t.replaces = [t.replaces];
                    }
                }
                const hasCorrections = tasks.some(t => Array.isArray(t.replaces) && t.replaces.length > 0);
                const hasNew = tasks.some(t => !t.duplicate && (!Array.isArray(t.replaces) || t.replaces.length === 0));
                const allDuplicates = tasks.length > 0 && tasks.every(t => t.duplicate);
                let header;
                if (allDuplicates) {
                    header = '📋 *תזכורת - משימות להורים מהגן:*\n\n';
                } else if (hasCorrections && !hasNew) {
                    header = '📋 *עדכון/תיקון - משימות להורים מהגן:*\n\n';
                } else if (hasCorrections && hasNew) {
                    header = '📋 *משימות חדשות + עדכון מהגן:*\n\n';
                } else {
                    header = '📋 *משימות חדשות להורים מהגן:*\n\n';
                }
                const tsStr = new Date(latestTimestamp * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
                const suffix = `\n\n---\n_סיכום אוטומטי של ${messages.length > 1 ? messages.length + ' הודעות' : 'הודעה'} (${tsStr})_`;
                await sendWhatsAppMessage(groupPair.outgoingId, header + result.summary_text + suffix);
                console.log(`[${groupPair.label}] Tasks sent to outgoing group.`);
                outcomeDetails.push('📋 סיכום נשלח לקבוצה');
            }

            if (SEND_REMINDERS && result.tasks && result.tasks.length > 0) {
                console.log(`[${groupPair.label}] Scheduling reminders...`);
                let reminderCount = 0;
                for (const task of result.tasks) {
                    if (task.due_date) {
                        if (task.duplicate) {
                            console.log(`  Task: "${task.description}" due: ${task.due_date} — DUPLICATE, skipping`);
                            continue;
                        }
                        if (Array.isArray(task.replaces) && task.replaces.length > 0) {
                            for (const idx of task.replaces) {
                                if (existingEvents[idx]) {
                                    const oldEvent = existingEvents[idx];
                                    console.log(`  Task: "${task.description}" due: ${task.due_date} — CORRECTION, replacing event [${idx}]: "${oldEvent.description}"`);
                                    await removeEventAndReminders(oldEvent.id, groupPair.outgoingId);
                                }
                            }
                        } else {
                            console.log(`  Task: "${task.description}" due: ${task.due_date}`);
                        }
                        const eventId = addEvent(task.description, task.due_date, task.event_time, groupPair.outgoingId);
                        task._eventId = eventId; // Store for calendar UID lookup below
                        scheduleTaskReminders(task.description, task.due_date, latestTimestamp, groupPair.outgoingId, task.event_time, eventId);
                        reminderCount++;
                    }
                }
                if (reminderCount > 0) {
                    outcomes.push('reminders');
                    outcomeDetails.push(`⏰ ${reminderCount} תזכורות נוצרו`);
                }
            }

            // --- Create Google Calendar events ---
            if (groupPair.calendarId && result.tasks && result.tasks.length > 0) {
                console.log(`[${groupPair.label}] Creating calendar events...`);
                const originalMsgDate = new Date(latestTimestamp * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
                let calCount = 0;

                for (const task of result.tasks) {
                    if (!task.due_date) continue;
                    if (task.duplicate) {
                        console.log(`  [Calendar] Skipping duplicate: "${task.description}"`);
                        continue;
                    }
                    const summary = `${groupPair.label}: ${task.description}`;
                    const sourceMsg = (typeof task.source_index === 'number' && messages[task.source_index]) ? messages[task.source_index].body : task.description;
                    const eventDescription = `${sourceMsg}\n\n---\nמקור: ${senders.join(', ')} בתאריך ${originalMsgDate}`;
                    try {
                        if (task.event_time) {
                            const [h, m] = task.event_time.split(':').map(Number);
                            const duration = task.event_duration_minutes || 30;
                            const startH = String(h).padStart(2, '0');
                            const startM = String(m).padStart(2, '0');
                            const endTotal = h * 60 + m + duration;
                            const endH = String(Math.floor(endTotal / 60)).padStart(2, '0');
                            const endM = String(endTotal % 60).padStart(2, '0');
                            await createCalendarEvent({
                                summary,
                                description: eventDescription,
                                start_date_time: `${task.due_date} ${startH}:${startM}:00`,
                                end_date_time: `${task.due_date} ${endH}:${endM}:00`,
                                entity_id: groupPair.calendarId
                            });
                        } else {
                            // All-day event: HA requires end_date to be the NEXT day (exclusive)
                            const endDate = new Date(task.due_date);
                            endDate.setDate(endDate.getDate() + 1);
                            const endDateStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
                            await createCalendarEvent({
                                summary,
                                description: eventDescription,
                                start_date: task.due_date,
                                end_date: endDateStr,
                                entity_id: groupPair.calendarId
                            });
                        }
                        console.log(`  [Calendar] ✅ "${summary}" on ${task.due_date}`);
                        calCount++;

                        // Look up the UID of the just-created calendar event and store it
                        if (task._eventId) {
                            try {
                                const calEvents = await getCalendarEvents(groupPair.calendarId, task.due_date, task.due_date);
                                const match = calEvents.find(ce => ce.summary === summary);
                                if (match && match.uid) {
                                    updateEventCalendarInfo(task._eventId, match.uid, groupPair.calendarId);
                                }
                            } catch (lookupErr) {
                                console.error(`  [Calendar] UID lookup failed: ${lookupErr.message}`);
                            }
                        }
                    } catch (calErr) {
                        console.error(`  [Calendar] ❌ Failed for "${task.description}": ${calErr.message}`);
                    }
                }
                if (calCount > 0) {
                    outcomes.push('calendar');
                    outcomeDetails.push(`📅 ${calCount} אירועי יומן נוצרו`);
                }
            }
        } else {
            console.log(`[${groupPair.label}] No parent tasks found.`);
            outcomes.push('no_tasks');
            outcomeDetails.push('אין משימות חדשות');
        }

        // Log to activity log
        addActivityLogEntry({
            timestamp: latestTimestamp,
            group: groupPair.incomingId,
            groupLabel: groupPair.label,
            type: 'kindergarten',
            messageCount: messages.length,
            messagePreview: combinedBody.substring(0, 200),
            senders: senders,
            outcome: outcomes,
            outcomeDetails: outcomeDetails,
            summaryText: result.summary_text || null,
            tasks: result.tasks || []
        });

        saveLastProcessed(groupPair.incomingId, latestTimestamp);
    } catch (error) {
        console.error(`[${groupPair.label}] Error processing message batch:`, error.message);
        addActivityLogEntry({
            timestamp: latestTimestamp,
            group: groupPair.incomingId,
            groupLabel: groupPair.label,
            type: 'kindergarten',
            messageCount: messages.length,
            messagePreview: combinedBody.substring(0, 200),
            senders: senders,
            outcome: ['error'],
            outcomeDetails: [`\u274c \u05e9\u05d2\u05d9\u05d0\u05d4: ${error.message}`], // ❌ שגיאה: ...
            status: 'error'
        });
    }
}

// Legacy single-message wrapper (used by startup old-message flow)
async function processMessage(groupPair, messageBody, messageTimestamp, sender, opts = {}) {
    return processMessageBatch(groupPair, [{ body: messageBody, timestamp: messageTimestamp, sender }], opts);
}

// ────────────────────────────────────────────────────────────
// HA WEBSOCKET: subscribe to whatsapp_message events
// ────────────────────────────────────────────────────────────
let haWs = null;
let wsSeqId = 1;
const recentMessages = [];

function handleIncomingMessage(eventData) {
    const { group_id, body, timestamp, message_id, sender, from_me, has_media } = eventData;

    // Only process group messages
    if (!group_id || !group_id.endsWith('@g.us')) return;

    // Find the matching group pair
    const groupPair = incomingMap[group_id];
    if (!groupPair) return;

    // Skip media
    if (has_media) {
        console.log(`[${groupPair.label}][SKIP] Media message`);
        return;
    }

    if (!body || body.trim() === '') return;
    if (timestamp <= getLastProcessed(groupPair.incomingId)) return;

    const senderName = sender || (from_me ? 'אני' : 'Unknown');

    console.log(`[${groupPair.label}][INCOMING] ${senderName}: ${body}`);

    // Track the last 3 incoming messages
    recentMessages.unshift({ group: groupPair.label, sender: senderName, body: body, timestamp: timestamp });
    if (recentMessages.length > 3) recentMessages.pop();

    // Add to batch buffer (2-min debounce)
    const msgId = message_id || `${timestamp}-${senderName}`;
    addToBatch(groupPair.incomingId, { body, timestamp, sender: senderName, id: msgId }, 'kindergarten', groupPair);
}

function handleMessageEdit(eventData) {
    const { group_id, message_id, new_body } = eventData;
    if (!group_id || !message_id) return;

    if (messageBatchBuffers.has(group_id)) {
        console.log(`[Edit] Message edited in ${group_id}: "${(new_body || '').substring(0, 80)}"`);
        handleMessageEditInBatch(group_id, message_id, new_body);
    }
}

function connectHAWebSocket() {
    if (!SUPERVISOR_TOKEN) {
        console.error('[WS] No SUPERVISOR_TOKEN — cannot connect to HA.');
        return;
    }

    haWs = new WebSocket('ws://supervisor/core/websocket');
    wsSeqId = 1;

    haWs.on('open', () => {
        console.log('[WS] Connected to Home Assistant WebSocket');
    });

    haWs.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);

            // Step 1: auth_required → send auth
            if (msg.type === 'auth_required') {
                haWs.send(JSON.stringify({ type: 'auth', access_token: SUPERVISOR_TOKEN }));
                return;
            }

            // Step 2: auth_ok → subscribe to events
            if (msg.type === 'auth_ok') {
                console.log('[WS] Authenticated with Home Assistant');
                // Subscribe to whatsapp_message events
                haWs.send(JSON.stringify({ id: wsSeqId++, type: 'subscribe_events', event_type: 'whatsapp_message' }));
                // Subscribe to whatsapp_message_edit events
                haWs.send(JSON.stringify({ id: wsSeqId++, type: 'subscribe_events', event_type: 'whatsapp_message_edit' }));
                // Subscribe to whatsapp_response events (for fetch results)
                haWs.send(JSON.stringify({ id: wsSeqId++, type: 'subscribe_events', event_type: 'whatsapp_response' }));
                // Subscribe to whatsapp_status events (for reconnect catch-up)
                haWs.send(JSON.stringify({ id: wsSeqId++, type: 'subscribe_events', event_type: 'whatsapp_status' }));
                console.log('[WS] Subscribed to whatsapp_message, whatsapp_message_edit, whatsapp_response, and whatsapp_status events');
                return;
            }

            if (msg.type === 'result' && msg.success) {
                return;
            }

            if (msg.type === 'event' && msg.event) {
                const eventData = msg.event.data || {};
                if (msg.event.event_type === 'whatsapp_message') {
                    handleIncomingMessage(eventData);
                } else if (msg.event.event_type === 'whatsapp_message_edit') {
                    handleMessageEdit(eventData);
                } else if (msg.event.event_type === 'whatsapp_response') {
                    handleFetchResponse(eventData);
                } else if (msg.event.event_type === 'whatsapp_status' && eventData.status === 'connected') {
                    // Only catch up on actual reconnections, not periodic heartbeats
                    if (eventData.heartbeat) {
                        // Periodic heartbeat — no need to catch up
                        return;
                    }
                    console.log('[WS] WhatsApp client reconnected — catching up on missed messages...');
                    catchUpMissedMessages().catch(err => console.error('[Catchup] Failed:', err.message));
                }
                return;
            }

            if (msg.type === 'auth_invalid') {
                console.error('[WS] Auth failed:', msg.message);
            }
        } catch (err) {
            console.error('[WS] Error processing message:', err.message);
        }
    });

    haWs.on('close', () => {
        console.log('[WS] WebSocket disconnected — reconnecting in 5s...');
        setTimeout(connectHAWebSocket, WS_RECONNECT_DELAY_MS);
    });

    haWs.on('error', (err) => {
        console.error('[WS] WebSocket error:', err.message);
    });
}


// --- GOOGLE CALENDAR: Create event via HA Supervisor API ---
async function createCalendarEvent({ summary, description, start_date, end_date, start_date_time, end_date_time, entity_id }) {
    if (!entity_id) {
        console.log('[Calendar] No calendar entity_id configured for this group. Skipping.');
        return;
    }
    console.log(`[Calendar] Creating event: "${summary}" on entity ${entity_id}`);

    const serviceData = { entity_id, summary };
    if (description) serviceData.description = description;
    if (start_date) serviceData.start_date = start_date;
    if (end_date) serviceData.end_date = end_date;
    if (start_date_time) serviceData.start_date_time = start_date_time;
    if (end_date_time) serviceData.end_date_time = end_date_time;

    const response = await axios.post(
        'http://supervisor/core/api/services/calendar/create_event',
        serviceData,
        {
            headers: {
                'Authorization': `Bearer ${SUPERVISOR_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        }
    );

    console.log(`[Calendar] ✅ Event created successfully. Status: ${response.status}`);
    return response.data;
}

// --- GOOGLE CALENDAR: Get events for a date range ---
async function getCalendarEvents(entityId, startDate, endDate) {
    if (!SUPERVISOR_TOKEN || !entityId) return [];
    try {
        const response = await axios.get(
            `http://supervisor/core/api/calendars/${entityId}?start=${startDate}T00:00:00&end=${endDate}T23:59:59`,
            {
                headers: { 'Authorization': `Bearer ${SUPERVISOR_TOKEN}` },
                timeout: 10000
            }
        );
        return response.data || [];
    } catch (err) {
        console.error(`[Calendar] Failed to get events: ${err.message}`);
        return [];
    }
}

// --- GOOGLE CALENDAR: Delete event by UID ---
async function deleteCalendarEvent(entityId, uid) {
    if (!SUPERVISOR_TOKEN || !entityId || !uid) return;
    console.log(`[Calendar] Deleting event UID ${uid} from ${entityId}`);
    await axios.post(
        'http://supervisor/core/api/services/calendar/delete_event',
        { entity_id: entityId, uid: uid },
        {
            headers: {
                'Authorization': `Bearer ${SUPERVISOR_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        }
    );
    console.log(`[Calendar] ✅ Event deleted successfully.`);
}

// --- GOOGLE TASKS: Create todo item via HA Supervisor API ---
async function createTodoItem({ item, description, due_date, entity_id }) {
    if (!entity_id) {
        console.log('[Tasks] No todo entity_id configured. Skipping.');
        return;
    }
    console.log(`[Tasks] Creating todo: "${item}" on entity ${entity_id}`);

    const serviceData = {
        entity_id,
        item
    };
    if (description) serviceData.description = description;
    if (due_date) serviceData.due_date = due_date;

    const response = await axios.post(
        'http://supervisor/core/api/services/todo/add_item',
        serviceData,
        {
            headers: {
                'Authorization': `Bearer ${SUPERVISOR_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        }
    );

    console.log(`[Tasks] ✅ Todo item created successfully. Status: ${response.status}`);
    return response.data;
}

// --- TEST_GEMINI: runs before WhatsApp init (only needs Gemini API) ---
async function runTestGemini() {
    console.log('');
    console.log('=== TEST GEMINI: Sending test request ===');
    try {
        const testMessages = `[21.2.2026, 20:30] גננת: הורים יקרים,
לרגל חג הפורים הקרב, אני רוצה לשתף אתכם בתכנון של גן פלמינגו לימים הקרובים. התכנון מתקיים בשיתוף עם אירועי החטיבה שיתקיימו במועדים מקבילים:
*יום שני 23.2 – יום ליצנים*
משפחות שיש להן אביזרי ליצן מוזמנות לשלוח עם הילדים בשמחה 🤡
*יום חמישי 26.2 – יום כובעים*
הילדים מוזמנים להגיע לגן עם כובעים מסוגים שונים ומגוונים.
בנוסף, באותו היום נקיים סדנה להכנת כובעים בגן ונקרא סיפור בליווי כובעים שונים 🎩
*יום שישי 27.2 – יום חיות*
ביום זה נקיים בגן יום חיות. הילדים מוזמנים להגיע עם בגד/אביזר/איפור בנושא חיות 🐱🐶🐼
*יום ראשון 1.3 – יום המסיבה והתחפושות*
הילדים יגיעו בבוקר מחופשים בתחפושות נוחות וללא אביזרי מלחמה (חרבות, סכינים, אקדחים וכדומה) 👸🦸🏻♀️🧝♀️
אנא שלחו עם הילדים בגדי החלפה.
*יום שני 2.3 – יום פיג'מות*
(יום לאחר יום התחפושות)
נחגוג בגן יום פיג'מות. הילדים מוזמנים להגיע בפיג'מה ולהביא כרית קטנה.
יש לשלוח עם הילדים בגדי החלפה בעת הצורך.
מחכים לחגוג יחד בשמחה רבה! 🎭
בנוסף בימים הקרובים נתחיל להמחיז בשיתוף הילדים את סיפור "מגילת אסתר" בגן.`;
        console.log('Test messages:');
        console.log(testMessages);
        console.log('');
        console.log('Calling Gemini...');
        const result = await extractTasksWithGemini(testMessages);
        console.log('');
        console.log('Gemini response:');
        console.log(JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('TEST GEMINI FAILED:', err.message);
        if (err.response) {
            console.error('Response status:', err.response.status);
            console.error('Response data:', JSON.stringify(err.response.data, null, 2));
        }
    }
    console.log('=== TEST GEMINI COMPLETE ===');
    console.log('');
}

// ────────────────────────────────────────────────────────────
// CATCH UP ON MISSED MESSAGES
// ────────────────────────────────────────────────────────────
let lastCatchUpTime = 0;
let catchUpInProgress = false;
const CATCHUP_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

async function catchUpMissedMessages(force = false) {
    const now = Date.now();
    if (!force && lastCatchUpTime && (now - lastCatchUpTime < CATCHUP_COOLDOWN_MS)) {
        console.log(`[Catchup] Skipping — last catch-up was ${Math.round((now - lastCatchUpTime) / 1000)}s ago (cooldown: ${CATCHUP_COOLDOWN_MS / 1000}s).`);
        return;
    }
    if (catchUpInProgress) {
        console.log(`[Catchup] Skipping — another catch-up is already in progress.`);
        return;
    }
    lastCatchUpTime = now;
    catchUpInProgress = true;

    try {

        console.log('');
        console.log('=== CATCH-UP FETCH: Checking for missed messages ===');

        // Clear any pending batch timers to avoid duplicate processing
        for (const [groupId, buffer] of messageBatchBuffers) {
            if (buffer.timer) {
                clearTimeout(buffer.timer);
                buffer.timer = null;
            }
            if (buffer.messages.length > 0) {
                console.log(`[Catchup] Cleared ${buffer.messages.length} buffered message(s) from ${groupId} (will be re-fetched).`);
                buffer.messages = [];
            }
        }
        for (const gp of groupPairs) {
            try {
                // Skip if this group is currently mid-processing (flushBatch → processMessageBatch is running)
                if (groupsBeingProcessed.has(gp.incomingId)) {
                    console.log(`[${gp.label}] Skipping catch-up — group is currently being processed by live batch.`);
                    continue;
                }

                // Skip if there's an active batch buffer for this group (messages waiting to flush)
                const activeBuffer = messageBatchBuffers.get(gp.incomingId);
                if (activeBuffer && activeBuffer.messages.length > 0) {
                    console.log(`[${gp.label}] Skipping catch-up — active batch buffer with ${activeBuffer.messages.length} message(s) still pending.`);
                    continue;
                }

                console.log(`[${gp.label}] Requesting messages from whatsapp_client...`);
                const fetchResult = await fetchMessagesViaHA(gp.incomingId, 50);
                if (!fetchResult || !fetchResult.data) {
                    console.log(`[${gp.label}] No response from fetch command.`);
                    continue;
                }

                const allMessages = fetchResult.data;
                const lastTs = getLastProcessed(gp.incomingId);
                console.log(`[${gp.label}] Fetched ${allMessages.length} messages. Last processed: ${new Date(lastTs * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);

                const newMessages = allMessages.filter(m => {
                    if (!m.body || m.body.trim() === '') return false;
                    if (m.timestamp <= lastTs) return false;
                    return true;
                }).map(m => ({
                    body: m.body,
                    timestamp: m.timestamp,
                    sender: m.sender || (m.from_me ? 'אני' : 'Unknown'),
                    id: m.message_id || `${m.timestamp}-${m.sender}`
                }));

                if (newMessages.length === 0) {
                    console.log(`[${gp.label}] No new messages to process.`);
                    continue;
                }

                // Skip if the newest message is less than 2 minutes old — it's likely still
                // being handled by the real-time listener / batch flush. Retry next cycle.
                const newestTimestamp = Math.max(...newMessages.map(m => m.timestamp));
                const ageSeconds = Math.floor(Date.now() / 1000) - newestTimestamp;
                if (ageSeconds < 120) {
                    console.log(`[${gp.label}] Skipping catch-up — newest message is only ${ageSeconds}s old (need 120s). Will retry next cycle.`);
                    continue;
                }

                newMessages.sort((a, b) => a.timestamp - b.timestamp);
                const groups = groupMessagesByTimeGap(newMessages, OLD_MSG_GROUP_GAP_S);
                console.log(`[${gp.label}] ${newMessages.length} new messages grouped into ${groups.length} batch(es).`);

                groupsBeingProcessed.add(gp.incomingId);
                try {
                    for (const batch of groups) {
                        const firstDate = new Date(batch[0].timestamp * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
                        const lastDate = new Date(batch[batch.length - 1].timestamp * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
                        console.log(`[${gp.label}] Processing batch of ${batch.length} message(s): ${firstDate} — ${lastDate}`);
                        if (EXTRACT_TASKS) {
                            await processMessageBatch(gp, batch, { skipSend: !SEND_SUMMARY_OLD_MESSAGES });
                        }
                    }
                } finally {
                    groupsBeingProcessed.delete(gp.incomingId);
                }
            } catch (err) {
                console.error(`[${gp.label}] Catch-up fetch failed:`, err.message);
                groupsBeingProcessed.delete(gp.incomingId);
            }
        }
        console.log('=== CATCH-UP FETCH COMPLETE ===');

    } finally {
        catchUpInProgress = false;
    }
}

async function main() {
    // Always start the reminder editor web UI with sync callbacks
    startEditor(3000, GROUP_NAMES, INCOMING_GROUP_NAMES, {
        reminderTimes: {
            morning: `${String(MORNING_HM[0]).padStart(2, '0')}:${String(MORNING_HM[1]).padStart(2, '0')}`,
            evening: `${String(EVENING_HM[0]).padStart(2, '0')}:${String(EVENING_HM[1]).padStart(2, '0')}`
        },
        onRemindersChanged: () => {
            try {
                scheduledReminders = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8')).filter(r => !r.sent);
                console.log(`[Sync] Reminders reloaded from UI: ${scheduledReminders.length} pending`);
                if (global.rescheduleNextReminder) global.rescheduleNextReminder();
            } catch (e) { console.error('[Sync] Failed to reload reminders:', e.message); }
        },
        onLastProcessedChanged: () => {
            try {
                const data = JSON.parse(fs.readFileSync(LAST_PROCESSED_FILE, 'utf8'));
                lastProcessedMap = data.groups || {};
                console.log('[Sync] Last processed reloaded from UI');
            } catch (e) { console.error('[Sync] Failed to reload last processed:', e.message); }
        },
        onFruitsScheduleChanged: () => {
            try {
                fruitsSchedule = JSON.parse(fs.readFileSync(FRUITS_SCHEDULE_FILE, 'utf8'));
                console.log('[Sync] Fruits schedule reloaded from UI');
            } catch (e) { console.error('[Sync] Failed to reload fruits schedule:', e.message); }
        },
        onEventsChanged: () => {
            try {
                registeredEvents = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
                console.log(`[Sync] Events reloaded from UI: ${registeredEvents.length} events`);
            } catch (e) { console.error('[Sync] Failed to reload events:', e.message); }
        },
        getActivityLog: () => getActivityLog(),
        getRecentMessages: () => recentMessages
    });
    console.log('Reminder editor UI started on port 3000');

    if (SAFE_MODE) {
        console.log('');
        console.log('============================================');
        console.log('  🛡️  SAFE MODE: Only the web UI is running');
        console.log('  No WhatsApp, no reminders, no fruits.');
        console.log('============================================');
        console.log('');
        return;
    }

    if (TEST_GEMINI) {
        await runTestGemini();
        console.log('TEST_GEMINI complete. Stopping further startup.');
        return;
    }

    await generateFruitReminders();

    // Connect to HA WebSocket to receive WhatsApp events
    connectHAWebSocket();

    await catchUpMissedMessages(true);
    console.log('');

    console.log('Kindergarten Task Extractor is running! (event-driven)');
    groupPairs.forEach(gp => {
        console.log(`  ${gp.label}: IN=${gp.incomingId} -> OUT=${gp.outgoingId}`);
    });
    console.log(`  Extract tasks: ${EXTRACT_TASKS}`);
    console.log(`  Send reminders: ${SEND_REMINDERS}`);
    console.log(`  Fruits reminders (Flamengo): ${ADD_FRUITS_REMINDER_FLAMENGO}`);
    console.log(`  Pending reminders: ${scheduledReminders.length}`);
    console.log('  Listening for whatsapp_message events via HA WebSocket...');

    // Restart the app every 5 hours to clear connectivity issues
    setTimeout(() => {
        console.log('Restarting app after 5 hours to prevent connectivity issues...');
        process.exit(0);
    }, 5 * 60 * 60 * 1000);
}

main();
