# 🤖 WhatsApp Broadcast & Automation Agent

An AI-powered agent that lives on your **WhatsApp Business number**. You control it by messaging it from your **personal number** — in plain English, no special commands needed.

---

## How it works

```
Your Personal Phone  →  messages  →  Your Business Number (the agent)
                                            ↓
                                   Claude understands you
                                            ↓
                               Sends to your WhatsApp groups
```

---

## ✨ Features

- **Natural language control** — just talk to it, no trigger words needed
- **Broadcast to all groups** — send one message to every group instantly
- **Target specific groups** — send to selected groups by name
- **Scheduled broadcasts** — auto-send messages at set times
- **Personalization** — use `{{groupName}}` to personalize per group
- **Config file support** — edit `schedules.json` directly for bulk schedules

---

## 🚀 Setup

### 1. Prerequisites
- Node.js 18+
- A personal WhatsApp number (to send commands)
- A WhatsApp Business number (the agent)
- An [Anthropic API key](https://console.anthropic.com)

### 2. Install dependencies
```bash
npm install
```

### 3. Configure your `.env` file
```bash
cp .env.example .env
```
Edit `.env`:
```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
PERSONAL_NUMBER=447700123456    ← your personal number, digits only, no +
```

### 4. Run the agent
```bash
npm start
```

A **QR code** will appear. Open your **WhatsApp Business app**:
- Android: Tap ⋮ → **Linked Devices** → **Link a Device**
- iPhone: Tap **Settings** → **Linked Devices** → **Link a Device**

Scan the QR code. You'll see `🤖 WhatsApp Agent is ready!` once connected.

---

## 💬 Talking to the agent

Open WhatsApp on your **personal phone**, message your **business number**, and just talk naturally:

```
Send a good morning message to all my groups

Send "Project deadline is Friday" to the Dev Team group only

Schedule a message every Monday at 9am saying "Good morning {{groupName}}! Have a great week 🚀"

List my schedules

Cancel the Monday morning schedule

Show me all my groups
```

No need for any trigger words — just write naturally and Claude understands.

---

## 📅 Editing schedules.json directly

You can manually edit `schedules.json` to add or change schedules. **Restart the agent** after editing.

**Send to ALL groups:**
```json
[
  {
    "label": "Monday Morning",
    "message": "Good morning {{groupName}}! 🌟 Great week ahead!",
    "cron": "0 9 * * 1",
    "target": "all_groups",
    "group_names": []
  }
]
```

**Send to SPECIFIC groups:**
```json
[
  {
    "label": "Weekly Client Update",
    "message": "Hi {{groupName}}, here's your weekly update 📊",
    "cron": "0 9 * * 5",
    "target": "specific_groups",
    "group_names": ["VIP Clients", "Project Alpha"]
  }
]
```

### Cron expression cheat sheet

| Schedule                 | Cron expression  |
|--------------------------|------------------|
| Every day at 8am         | `0 8 * * *`      |
| Every Monday at 9am      | `0 9 * * 1`      |
| Every weekday at 10am    | `0 10 * * 1-5`   |
| Every Friday at 5pm      | `0 17 * * 5`     |
| 1st of every month, 9am  | `0 9 1 * *`      |

---

## 🎨 Personalization

Use `{{groupName}}` in any message — replaced automatically with each group's name.

**Example:**
```
"Hey {{groupName}} team! Big update this week 🎉"
```
Becomes for "Sales Group":
```
"Hey Sales Group team! Big update this week 🎉"
```

---

## 📁 File Structure

```
whatsapp-agent/
├── index.js              # WhatsApp client — runs as your business number
├── agent.js              # Claude AI — understands your messages
├── scheduler.js          # Cron job manager
├── whatsapp-helpers.js   # Group fetching + message sending
├── schedules.json        # Edit this to manage schedules ← 
├── .env                  # Your secrets
├── .env.example          # Template
└── package.json
```

---

## ⚠️ Notes

- **Only your personal number** can control the agent — everyone else is ignored
- Customers can still message your business number normally — the agent ignores them
- whatsapp-web.js is unofficial (not affiliated with Meta). Use responsibly.
- There's a 1.5s delay between group sends to avoid WhatsApp rate limits
- Session is saved in `.wwebjs_auth/` — don't delete this or you'll need to rescan

---

## 🛠 Troubleshooting

| Problem | Fix |
|---|---|
| QR code not appearing | Try `node index.js` directly |
| Agent not responding | Check `PERSONAL_NUMBER` matches exactly — digits only, no + |
| "Group not found" | Say "show me all my groups" to see exact names |
| Schedule not firing | Validate your cron at [crontab.guru](https://crontab.guru) |
| Puppeteer error on Linux | Run `apt-get install chromium` |
