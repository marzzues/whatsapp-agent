require('dotenv').config();
// agent.js — Claude-powered assistant with WhatsApp tools + general chat
const Anthropic = require('@anthropic-ai/sdk');
const {
  sendToAllGroups,
  sendToGroups,
  getGroupList,
} = require('./whatsapp-helpers');
const {
  addSchedule,
  removeSchedule,
  getSchedules,
} = require('./scheduler');
const {
  getTodayAttendance,
  formatDailyReport,
  getAttendanceByDate,
  getProjects,
  addProject,
  removeProject,
} = require('./clockin');
const {
  getRecentEmails,
  sendEmail,
  replyToEmail,
  searchEmails,
  listFiles,
  searchFiles,
  createFile,
  readFile,
} = require('./microsoft');

const client_ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Conversation memory (within a running session) ─────────────────────────
// Remembers the last 20 messages so Claude can refer back to earlier context
const MAX_HISTORY = 20;
const conversationHistory = [];

function addToHistory(role, content) {
  conversationHistory.push({ role, content });
  if (conversationHistory.length > MAX_HISTORY) {
    conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY);
  }
}

// ── Tool definitions ───────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'send_to_all_groups',
    description: 'Send a message to ALL WhatsApp groups the user is in. Supports {{groupName}} personalization.',
    input_schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to send. Can include {{groupName}} for personalization.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'send_to_specific_groups',
    description: 'Send a message to specific WhatsApp groups by name (partial match supported).',
    input_schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to send. Can include {{groupName}} for personalization.',
        },
        group_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of group names to target (partial/fuzzy match).',
        },
      },
      required: ['message', 'group_names'],
    },
  },
  {
    name: 'list_groups',
    description: 'List all WhatsApp groups the user is currently in.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_message',
    description: 'Schedule a recurring or one-time message to groups.',
    input_schema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Short human-readable label (e.g. "Weekly Monday Greeting")',
        },
        message: {
          type: 'string',
          description: 'The message to send. Can include {{groupName}} for personalization.',
        },
        cron: {
          type: 'string',
          description: 'Cron expression (e.g. "0 9 * * 1" for every Monday at 9am)',
        },
        target: {
          type: 'string',
          enum: ['all_groups', 'specific_groups'],
          description: 'Who to send to',
        },
        group_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Required when target is specific_groups',
        },
      },
      required: ['label', 'message', 'cron', 'target'],
    },
  },
  {
    name: 'list_schedules',
    description: 'List all currently active scheduled messages.',
    input_schema: { type: 'object', properties: {} },
  },

  // ── Microsoft 365 Tools ───────────────────────────────────────────────
  {
    name: 'get_recent_emails',
    description: 'Get the most recent emails from the Outlook inbox.',
    input_schema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of emails to fetch (default 5, max 20)' },
      },
    },
  },
  {
    name: 'send_email',
    description: 'Send an email via Outlook.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'reply_to_email',
    description: 'Reply to an email. Use the email ID from get_recent_emails.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The email message ID to reply to' },
        reply_text: { type: 'string', description: 'The reply body text' },
      },
      required: ['message_id', 'reply_text'],
    },
  },
  {
    name: 'search_emails',
    description: 'Search emails by keyword, sender name, or subject.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword or phrase' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and folders in OneDrive or SharePoint.',
    input_schema: {
      type: 'object',
      properties: {
        folder_path: { type: 'string', description: 'Folder path e.g. "Documents" or "Documents/Reports". Leave empty for root.' },
      },
    },
  },
  {
    name: 'search_files',
    description: 'Search for files by name or keyword in OneDrive/SharePoint.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'File name or keyword to search for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_file',
    description: 'Create a new text file in OneDrive.',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'File name e.g. "Meeting Notes March 8.txt"' },
        content: { type: 'string', description: 'Text content to write to the file' },
        folder_path: { type: 'string', description: 'Folder to save in e.g. "Documents". Leave empty for root.' },
      },
      required: ['file_name', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a text file from OneDrive.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Full path to file e.g. "Documents/notes.txt"' },
      },
      required: ['file_path'],
    },
  },

  {
    name: 'get_attendance_report',
    description: 'Get the attendance/clock-in report for today or a specific date.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format. Leave empty for today.' },
      },
    },
  },
  {
    name: 'get_clockin_link',
    description: 'Get the clock-in link to share with staff.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'remove_schedule',
    description: 'Remove/cancel a scheduled message by its label.',
    input_schema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'The label of the schedule to remove.',
        },
      },
      required: ['label'],
    },
  },
];

// ── Tool executor ──────────────────────────────────────────────────────────
async function executeTool(name, input, whatsappClient) {
  console.log(`🔧 Tool: ${name}`, input);

  switch (name) {
    case 'send_to_all_groups': {
      const results = await sendToAllGroups(whatsappClient, input.message);
      const sent = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;
      return `✅ Sent to ${sent} group(s)${failed ? `, ⚠️ failed for ${failed}` : ''}.`;
    }

    case 'send_to_specific_groups': {
      const results = await sendToGroups(whatsappClient, input.message, input.group_names);
      const sent = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);
      let reply = `✅ Sent to: ${sent.map((r) => r.name).join(', ') || 'none'}`;
      if (failed.length) reply += `\n⚠️ Not found/failed: ${failed.map((r) => r.name).join(', ')}`;
      return reply;
    }

    case 'list_groups': {
      const groups = await getGroupList(whatsappClient);
      if (!groups.length) return '📭 No groups found.';
      return `📋 Your groups (${groups.length}):\n` + groups.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
    }

    case 'schedule_message': {
      const schedule = {
        label: input.label,
        message: input.message,
        cron: input.cron,
        target: input.target,
        group_names: input.group_names || [],
      };
      const result = addSchedule(schedule, whatsappClient);
      if (result.success) {
        return `✅ Schedule "${input.label}" created!\n⏰ ${input.cron}\n💬 "${input.message.slice(0, 60)}${input.message.length > 60 ? '...' : ''}"`;
      }
      return `❌ Failed to create schedule: ${result.error}`;
    }

    case 'list_schedules': {
      const schedules = getSchedules();
      if (!schedules.length) return '📭 No active schedules.';
      return (
        `📅 Active schedules (${schedules.length}):\n\n` +
        schedules
          .map(
            (s, i) =>
              `${i + 1}. *${s.label}*\n   ⏰ ${s.cron}\n   📤 ${s.target === 'all_groups' ? 'All groups' : s.group_names.join(', ')}\n   💬 "${s.message.slice(0, 50)}${s.message.length > 50 ? '...' : ''}"`
          )
          .join('\n\n')
      );
    }

    case 'remove_schedule': {
      const result = removeSchedule(input.label);
      return result.success
        ? `✅ Schedule "${input.label}" removed.`
        : `❌ Schedule "${input.label}" not found.`;
    }


    case 'get_recent_emails': {
      const emails = await getRecentEmails(input.count || 5);
      if (!emails.length) return '📭 No emails found.';
      return '📧 *Recent emails:*

' + emails.map(e =>
        `${e.index}. ${e.isRead ? '' : '🔵 '}*${e.subject}*
   From: ${e.fromName || e.from}
   ${e.received}
   ${e.preview}`
      ).join('

');
    }

    case 'send_email': {
      await sendEmail(input.to, input.subject, input.body);
      return `✅ Email sent to ${input.to}
📧 Subject: "${input.subject}"`;
    }

    case 'reply_to_email': {
      await replyToEmail(input.message_id, input.reply_text);
      return `✅ Reply sent successfully.`;
    }

    case 'search_emails': {
      const emails = await searchEmails(input.query);
      if (!emails.length) return `📭 No emails found for "${input.query}".`;
      return `🔍 *Emails matching "${input.query}":*

` + emails.map(e =>
        `${e.index}. *${e.subject}*
   From: ${e.from}
   ${e.received}
   ${e.preview}`
      ).join('

');
    }

    case 'list_files': {
      const files = await listFiles(input.folder_path || '');
      if (!files.length) return '📭 No files found.';
      const folder = input.folder_path || 'root';
      return `📁 *Files in ${folder}:*

` + files.map(f =>
        `${f.index}. ${f.type === 'folder' ? '📂' : '📄'} ${f.name}${f.size ? ` (${f.size})` : ''}
   Modified: ${f.modified}`
      ).join('
');
    }

    case 'search_files': {
      const files = await searchFiles(input.query);
      if (!files.length) return `📭 No files found for "${input.query}".`;
      return `🔍 *Files matching "${input.query}":*

` + files.map(f =>
        `${f.index}. 📄 ${f.name}
   Modified: ${f.modified}`
      ).join('
');
    }

    case 'create_file': {
      const result = await createFile(input.file_name, input.content, input.folder_path || '');
      return `✅ File created: *${result.name}*`;
    }

    case 'read_file': {
      const text = await readFile(input.file_path);
      return `📄 *${input.file_path}:*

${text}`;
    }



  {
    name: 'manage_projects',
    description: 'List, add or remove projects from the clock-in project dropdown.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'What to do' },
        project_name: { type: 'string', description: 'Project name (required for add/remove)' },
      },
      required: ['action'],
    },
  },


    case 'manage_projects': {
      if (input.action === 'list') {
        const projects = getProjects(false);
        if (!projects.length) return '📋 No projects yet.';
        return '📋 *Projects:*
' + projects.map(p =>
          `${p.active ? '🟢' : '🔴'} ${p.name}`
        ).join('
');
      }
      if (input.action === 'add') {
        const result = addProject(input.project_name);
        return result.success
          ? `✅ Project added: *${result.name}*`
          : `❌ ${result.message}`;
      }
      if (input.action === 'remove') {
        const result = removeProject(input.project_name);
        return result.success
          ? `✅ Project removed: *${input.project_name}*`
          : `❌ ${result.message}`;
      }
      return '❌ Unknown action.';
    }

    case 'get_attendance_report': {
      const records = input.date
        ? getAttendanceByDate(input.date)
        : getTodayAttendance();
      return formatDailyReport(records);
    }

    case 'get_clockin_link': {
      const url = (global.APP_URL || 'your-railway-url') + '/clockin';
      return `📋 Clock-in link:\n${url}\n\nShare this with your staff to clock in and out.`;
    }

    default:
      return `❌ Unknown tool: ${name}`;
  }
}

// ── System prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a smart personal AI assistant living inside WhatsApp Business. You serve two purposes:

1. WHATSAPP TOOLS
Use your tools when the user wants to:
- Send messages to their WhatsApp groups
- Schedule or manage automated broadcasts
- List their groups or active schedules

PERSONALIZATION: Messages can include {{groupName}} — automatically replaced with each group's name before sending.

TIMEZONE: All times are in Perth, Western Australia (AWST, UTC+8). When the user says '9am' they mean 9am Perth time.

CRON EXPRESSIONS:
- Every Monday at 9am     → "0 9 * * 1"
- Every day at 8am        → "0 8 * * *"
- Every weekday at 10am   → "0 10 * * 1-5"
- Every Friday at 5pm     → "0 17 * * 5"
- 1st of every month 9am  → "0 9 1 * *"

2. MICROSOFT 365
Use your Microsoft tools when the user wants to:
- Read, search or send emails via Outlook
- List, search, create or read files on OneDrive/SharePoint
- Save meeting notes or documents

3. PERSONAL AI ASSISTANT
For everything else, be a helpful knowledgeable personal assistant. Help with:
- Writing emails, messages, or content
- Business advice and strategy
- Answering general knowledge questions
- Summarising text or notes
- Brainstorming ideas
- Proofreading or improving writing
- Any other questions or tasks

RESPONSE STYLE:
- Keep responses concise and WhatsApp-friendly
- Use short paragraphs with line breaks between them
- Use *bold* for emphasis where helpful
- Avoid long walls of text
- Be conversational and warm, not robotic
- You have memory of this conversation so refer back to earlier context when relevant`;

// ── Main handler ───────────────────────────────────────────────────────────
async function handleCommand(userMessage, whatsappClient, appUrl) {
  if (appUrl) global.APP_URL = appUrl;
  addToHistory('user', userMessage);

  const messages = [...conversationHistory];

  let response = await client_ai.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });

  // Agentic loop — handle tool use
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];

    for (const block of toolUseBlocks) {
      const result = await executeTool(block.name, block.input, whatsappClient);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });
    }

    addToHistory('assistant', response.content);
    addToHistory('user', toolResults);

    response = await client_ai.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: [...conversationHistory],
    });
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  const reply = textBlock?.text || '✅ Done.';

  addToHistory('assistant', reply);

  return reply;
}

module.exports = { handleCommand };
