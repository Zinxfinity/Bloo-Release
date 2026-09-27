// Every error report across the whole bot goes through here, to one webhook
// (ERROR_WEBHOOK_URL), instead of the old per-subsystem channel IDs
// (ERROR_CHANNEL_QUARANTINE, _WEBHOOKS, _MODERATION, _XP, _ECONOMY, _GENERAL),
// most of which nothing ever actually posted to. A plain webhook URL also
// means this works from the dashboard process too, which has no gateway
// client to fetch a channel through.
import logger from '../utils/logger.js';

const WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL;
const COLOR       = 0xef4444;

/**
 * @param {string} category Human-readable label shown in the embed title,
 *   e.g. "Economy", "Moderation", "Dashboard", "Tickets". Not a routing key,
 *   everything goes to the same webhook now, this is purely so you can tell
 *   what broke at a glance.
 * @param {{ title?, guildId?, command?, userId?, extra?, error? }} payload
 */
export async function reportError(category, payload = {}) {
  if (!WEBHOOK_URL) return;

  const { title, guildId, command, userId, extra, error } = payload;

  let description = '';
  if (guildId)  description += `**Guild:** \`${guildId}\`\n`;
  if (command)  description += `**Command:** \`${command}\`\n`;
  if (userId)   description += `**User:** \`${userId}\`\n`;
  if (extra)    description += `**Extra:** ${extra}\n`;
  if (error) {
    const stack = (error.stack ?? String(error)).slice(0, 1000);
    description += `\`\`\`\n${stack}\n\`\`\``;
  }

  try {
    await fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Bloo Errors',
        embeds: [{
          title:       `🔴 ${category} — ${title ?? 'Error'}`,
          description: description || 'No details available.',
          color:       COLOR,
          timestamp:   new Date().toISOString(),
        }],
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (sendErr) {
    logger.error('[REPORTER] Failed to send error report:', sendErr);
  }
}
