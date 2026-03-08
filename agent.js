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

const client_ai = new Anthropic();

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

CRON EXPRESSIONS:
- Every Monday at 9am     → "0 9 * * 1"
- Every day at 8am        → "0 8 * * *"
- Every weekday at 10am   → "0 10 * * 1-5"
- Every Friday at 5pm     → "0 17 * * 5"
- 1st of every month 9am  → "0 9 1 * *"

2. PERSONAL AI ASSISTANT
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
async function handleCommand(userMessage, whatsappClient) {
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
