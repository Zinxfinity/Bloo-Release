// Automatic punishments (automod, word filter, link enforcement) are real
// moderation cases: logged to the mod log like a command would be, and a
// warning goes through the same threshold escalation as `b!warn`.
import { logAction } from './modLog.js';
import { addWarning, getActiveWarnCount, getThresholdForCount } from './warnSystem.js';
import { applyThreshold } from './warnEscalation.js';

export async function recordAutoCase(client, guildId, user, action, reason, source, extraFields = []) {
  return logAction({ client, guildId, action, targetId: user.id, targetTag: user.username,
    executorId: client.user.id, executorTag: source, reason, extraFields }).catch(() => null);
}

export async function autoWarn(client, guildId, user, reason, source) {
  addWarning(guildId, user.id, client.user.id, reason);
  const count = getActiveWarnCount(guildId, user.id);
  await recordAutoCase(client, guildId, user, 'warn', reason, source, [{ name: 'Warn #', value: String(count), inline: true }]);
  const threshold = getThresholdForCount(guildId, count);
  if (threshold) await applyThreshold(client, guildId, user.id, user.username ?? user.id, threshold, client.user.id, source);
}
