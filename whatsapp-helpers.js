// whatsapp-helpers.js — Group fetching, sending, personalization
const SEND_DELAY_MS = 1500; // delay between sends to avoid rate limits

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Personalize message for a specific group ───────────────────────────────
function personalizeMessage(template, group) {
  return template
    .replace(/\{\{groupName\}\}/gi, group.name || 'Group')
    .replace(/\{\{name\}\}/gi, group.name || 'Group');
}

// ── Fetch all groups ───────────────────────────────────────────────────────
async function getGroupList(client) {
  const chats = await client.getChats();
  return chats
    .filter((c) => c.isGroup)
    .map((c) => ({ id: c.id._serialized, name: c.name }));
}

// ── Send to ALL groups ─────────────────────────────────────────────────────
async function sendToAllGroups(client, messageTemplate) {
  const groups = await getGroupList(client);
  const results = [];

  for (const group of groups) {
    try {
      const text = personalizeMessage(messageTemplate, group);
      await client.sendMessage(group.id, text);
      console.log(`  ✅ Sent to: ${group.name}`);
      results.push({ name: group.name, success: true });
    } catch (err) {
      console.error(`  ❌ Failed for ${group.name}:`, err.message);
      results.push({ name: group.name, success: false, error: err.message });
    }
    await sleep(SEND_DELAY_MS);
  }

  return results;
}

// ── Send to SPECIFIC groups (fuzzy name match) ─────────────────────────────
async function sendToGroups(client, messageTemplate, targetNames) {
  const groups = await getGroupList(client);
  const results = [];

  for (const targetName of targetNames) {
    const lowerTarget = targetName.toLowerCase();
    const matched = groups.filter((g) =>
      g.name.toLowerCase().includes(lowerTarget)
    );

    if (!matched.length) {
      results.push({ name: targetName, success: false, error: 'Group not found' });
      continue;
    }

    for (const group of matched) {
      try {
        const text = personalizeMessage(messageTemplate, group);
        await client.sendMessage(group.id, text);
        console.log(`  ✅ Sent to: ${group.name}`);
        results.push({ name: group.name, success: true });
      } catch (err) {
        console.error(`  ❌ Failed for ${group.name}:`, err.message);
        results.push({ name: group.name, success: false, error: err.message });
      }
      await sleep(SEND_DELAY_MS);
    }
  }

  return results;
}

module.exports = { getGroupList, sendToAllGroups, sendToGroups, personalizeMessage };
