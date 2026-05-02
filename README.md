# בוט גן ילדים — Kindergarten Bot for Home Assistant

An AI-powered Home Assistant add-on that monitors WhatsApp kindergarten parent groups, extracts actionable tasks using **Gemini 2.5 Flash**, and automatically creates calendar events, sends summaries, and schedules reminders.

## Architecture

```
┌─────────────────┐    HA Events    ┌─────────────────────────────────────┐
│ WhatsApp Client │ ──messages────► │         Kindergarten Bot             │
│   (separate     │ ◄──commands──── │                                     │
│    add-on)      │                 │  ┌──────────┐  ┌────────────────┐   │
└─────────────────┘                 │  │ Message   │  │ Gemini 2.5     │   │
                                    │  │ Batcher   │──│ Flash AI       │   │
       ┌──────────┐                 │  └──────────┘  └────────────────┘   │
       │ Google   │ ◄── HA API ──── │  ┌──────────┐  ┌────────────────┐   │
       │ Calendar │                 │  │ Reminder  │  │ Events         │   │
       └──────────┘                 │  │ Scheduler │  │ Registry       │   │
                                    │  └──────────┘  └────────────────┘   │
       ┌──────────┐                 │  ┌──────────────────────────────┐   │
       │ WhatsApp │ ◄── summaries── │  │ Express :3000 — Ingress UI   │   │
       │ Groups   │                 │  └──────────────────────────────┘   │
       └──────────┘                 └─────────────────────────────────────┘
```

**The bot does NOT run WhatsApp Web itself.** It communicates with the separate `whatsapp_client` add-on entirely via Home Assistant's event bus.

## How It Works

1. **Monitor** — listens for incoming WhatsApp messages from kindergarten parent groups via HA events
2. **Batch** — buffers messages with a 2-minute debounce timer; processes them as a group
3. **Extract** — sends batched messages to Gemini AI to identify parent tasks (bring items, payments, events, etc.)
4. **Deduplicate** — compares extracted tasks against an events registry to detect duplicates and corrections
5. **Act** — for each new task:
   - Sends a formatted summary to the family's outgoing WhatsApp group
   - Creates a Google Calendar event via HA services
   - Schedules morning and evening WhatsApp reminders

## Installation

1. Install the **WhatsApp Client** add-on first (required dependency)
2. Add this repository and install the **Kindergarten Bot** add-on
3. Configure the required options (see below)
4. Start the add-on

## Configuration

The bot no longer requires a hardcoded `GEMINI_API_KEY`. It uses the **Google Generative AI Conversation** integration configured in your Home Assistant instance.

### Required Options

| Option | Type | Description |
|--------|------|-------------|
| `INCOMING_GROUP_ID` | string | Source kindergarten group (WhatsApp JID) |
| `OUTGOING_GROUP_ID` | string | Family group to send summaries to |

### Group Pairs (up to 2)

The bot supports monitoring **2 kindergarten groups** simultaneously:

| Option | Group 1 | Group 2 |
|--------|---------|---------|
| Incoming ID | `INCOMING_GROUP_ID` | `INCOMING_GROUP_ID_2` |
| Outgoing ID | `OUTGOING_GROUP_ID` | `OUTGOING_GROUP_ID_2` |
| Display Name | `GROUP_NAME_1` | `GROUP_NAME_2` |
| Calendar Entity | `CALENDAR_ID_1` | `CALENDAR_ID_2` |

### Feature Flags

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `EXTRACT_TASKS` | bool | `true` | Enable Gemini task extraction |
| `SEND_REMINDERS` | bool | `true` | Enable reminder scheduling |
| `SEND_SUMMARY_OLD_MESSAGES` | bool | `true` | Send summaries for catch-up messages |
| `ADD_FRUITS_REMINDER_FLAMENGO` | bool | `true` | Auto-generate fruit day reminders |
| `SAFE_MODE` | bool | `false` | Only start web UI, disable processing |
| `TEST_GEMINI` | bool | `false` | Run test extraction on startup |
| `RESET_LAST_PROCESSED` | bool | `false` | Clear last-processed timestamps on startup |

### Timing Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `REMINDER_MORNING_TIME` | string | `"08:00"` | Morning reminder time (HH:MM) |
| `REMINDER_EVENING_TIME` | string | `"20:00"` | Evening reminder time (HH:MM) |

## Message Processing Pipeline

### Live Messages (Real-Time)

```
Message arrives → Buffer (per group) → 2-min silence → Flush → Gemini → Actions
                    ↑                      ↑
              edit updates            timer resets
              buffer content          on each message
```

- Each group has its own buffer in memory
- Message edits update the buffered content (empty edits from link previews are ignored)
- A mutex (`groupsBeingProcessed`) prevents race conditions between live and catch-up processing

### Catch-Up Messages (Missed)

Triggered on:
- **Startup** (always)
- **WhatsApp client reconnection** (non-heartbeat `connected` status)
- **5-minute cooldown** between catch-ups

Process:
1. Fetch last 50 messages per group via `whatsapp_command_fetch`
2. Filter to messages newer than last processed timestamp
3. Split into batches using 30-minute gaps
4. Process each batch through Gemini

## AI Task Extraction

### What Gemini Extracts

For each batch of messages, Gemini returns:

```json
{
  "has_tasks": true,
  "tasks": [
    {
      "description": "להביא פירות ליום שלישי",
      "due_date": "2026-04-10",
      "event_time": null,
      "event_duration_minutes": null,
      "duplicate": false,
      "replaces": null
    }
  ],
  "summary_text": "1. להביא פירות ליום שלישי"
}
```

### Deduplication & Correction Detection

Existing events from the registry are included in the Gemini prompt. The AI:
- Marks **exact duplicates** as `"duplicate": true` → skipped
- Marks **corrections** with `"replaces": [indices]` → old events and their reminders are deleted, new ones created
- Distinguishes between truly new tasks and repeated information

### Summary Message Format

| Scenario | Header |
|----------|--------|
| All duplicates | 📋 *תזכורת - משימות להורים מהגן:* |
| Corrections only | 📋 *עדכון/תיקון - משימות להורים מהגן:* |
| New + corrections | 📋 *משימות חדשות + עדכון מהגן:* |
| New tasks | 📋 *משימות חדשות להורים מהגן:* |

## Reminder System

### Automatic Scheduling

For each task with a due date, the bot schedules:

| Type | Emoji | When | Description |
|------|-------|------|-------------|
| Evening | 🌙 | Night before, 20:00 | Reminder for the next day |
| Morning | ☀️ | Day of, 08:00 | Same-day reminder |
| Zoom | 📹 | 1 hour before | Only for Zoom-related tasks |

- Minimum 5-hour gap required (won't schedule reminders too close to now)
- Reminders are sent as WhatsApp messages to the outgoing group
- Morning/evening reminders auto-skip overlapping Zoom reminders
- Expired reminders (2h+ past due) are automatically cleaned up

### Fruit Day Reminders

A special auto-scheduler for **Sundays and Tuesdays** (fruit days):
- Generates reminders for the next 14 days
- Evening reminder at 20:00 the night before
- Morning reminder at 06:45 the day of
- Creates corresponding Google Calendar events
- Runs on startup and every 6 hours

## Google Calendar Integration

Tasks with due dates are automatically added to Google Calendar via HA services:

- **All-day events** — for tasks without a specific time
- **Timed events** — for tasks with `event_time`, using specified or default 30-minute duration
- **UID tracking** — calendar event UIDs are stored in the events registry for later deletion
- **Cascading deletion** — when a correction replaces an old task, both the calendar event and linked reminders are removed

## Events Registry

Stored at `/data/events.json`. Each event tracks:

```json
{
  "id": "evt_1712600000_abc123",
  "description": "להביא פירות",
  "due_date": "2026-04-10",
  "event_time": null,
  "group_id": "1234@g.us",
  "calendar_uid": "ha-calendar-uid",
  "calendar_entity_id": "calendar.my_calendar",
  "created_at": 1712600000
}
```

Past events are automatically pruned on load.

## HA Events

### Listens To

| Event | Purpose |
|-------|---------|
| `whatsapp_message` | Incoming messages (real-time) |
| `whatsapp_message_edit` | Message edits |
| `whatsapp_response` | Command responses (fetch/send correlation) |
| `whatsapp_status` | Client status (triggers catch-up on reconnection) |

### Fires

| Event | `app_id` | Purpose |
|-------|----------|---------|
| `whatsapp_command_send` | `bot` | Send WhatsApp message |
| `whatsapp_command_fetch` | `bot` | Fetch group message history |

## Ingress Web UI — Reminder Editor

Accessible from the HA sidebar. RTL Hebrew interface with dark theme.

### Features

- **Dashboard stats** — pending, sent, and total reminders
- **Activity log** — last 100 processing results with outcome badges (tasks/calendar/reminders/errors)
- **Recent messages** — last 3 incoming messages from monitored groups
- **Reminder grid** — 2-column layout (one per group), grouped by task, with edit/delete/add controls
- **Settings panel** — edit last-processed timestamps, fruits schedule
- **Import/Export** — full state backup and restore as JSON

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/reminders` | List all reminders |
| `POST` | `/api/reminders` | Add new reminder |
| `PUT` | `/api/reminders/:index` | Edit reminder |
| `DELETE` | `/api/reminders/:index` | Delete reminder |
| `POST` | `/api/reminders/import` | Import (merge or replace) |
| `GET` | `/api/events` | List events registry |
| `PUT` | `/api/events` | Replace events |
| `GET` | `/api/activity-log` | Get activity log |
| `GET` | `/api/recent-messages` | Get last 3 messages |
| `GET` | `/api/last-processed` | Get processing timestamps |
| `PUT` | `/api/last-processed` | Update timestamps |
| `GET` | `/api/fruits-schedule` | Get fruits schedule |
| `PUT` | `/api/fruits-schedule` | Update fruits schedule |
| `GET` | `/api/full-state` | Export full state |

## Persistence

All data is stored in `/data/` (persistent across container restarts):

| File | Purpose |
|------|---------|
| `events.json` | Event registry with calendar UIDs |
| `reminders.json` | Scheduled reminders |
| `last_processed.json` | Per-group last processed timestamps |
| `activity_log.json` | Activity log (max 100 entries) |
| `fruits_schedule.json` | Fruit reminder tracking |

## File Structure

```
whatsapp_bot/
├── config.yaml           # HA add-on manifest
├── Dockerfile            # Container build (Node 18)
├── package.json          # Dependencies (axios, ws)
├── bot.js                # Main bot logic (~1700 lines)
├── reminder_editor.js    # Ingress web UI server (~1200 lines)
└── public/               # (empty — UI is inline in reminder_editor.js)
```

## Auto-Restart

The process exits after **5 hours** to clear accumulated connectivity issues. HA Supervisor automatically restarts the container.

## Changelog

### v0.0.45
- Added `app_id: 'bot'` to all command events for round-robin scheduling in `whatsapp_client` v0.1.0

### v0.0.44
- Heartbeat-aware catch-up (ignores periodic heartbeats from WhatsApp Client)
- Improved filter for orange alert instruction lines in Oref parser

### v0.0.1
- Initial release
- Gemini 2.5 Flash task extraction
- Dual group monitoring
- Google Calendar integration with UID tracking
- Morning/evening/Zoom reminder scheduling
- Fruit day auto-reminders
- Message batching with 2-minute debounce
- Catch-up mechanism with 5-minute cooldown
- Deduplication and correction detection
- Ingress UI with reminder editor and activity log
