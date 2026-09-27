// ─── Warn escalation ──────────────────────────────────────────────────────────
// What happens when a warning pushes someone over a warn threshold (mute,
// kick, temp ban, ban). Shared by `b!warn` and the dashboard's Warn button so
// both escalate the same way: same approval gate, same ban notice, same
// automatic unban. `client` only needs `rest` (the dashboard passes a shim).
// Its own file because banSystem.js already imports warnSystem.js.
import { isBotOwner, isRealOwner } from './staffSystem.js';
import { logAction } from './modLog.js';
import { banNeedsApproval, createApprovalRequest, postApprovalRequest, performBanAction } from './banSystem.js';
import logger from '../utils/logger.js';

// Returns { ok, text } for the moderator, or null when there's nothing to say.
export async function applyThreshold(client, guildId, targetId, targetTag, threshold, executorId, executorTag) {
  const reason = `Warn threshold reached (${threshold.count} warnings)`;
  const who = `<@${targetId}>`;
  try {
    if (threshold.action === 'mute') {
      // 28 days is the platform's cap on a single timeout.
      const dur   = Math.min(threshold.duration_seconds ?? 600, 28 * 86400);
      const until = new Date(Date.now() + dur * 1000).toISOString();
      await client.rest.patch(`/guilds/${guildId}/members/${targetId}`, {
        body: { communication_disabled_until: until },
      });
      await logAction({ client, guildId, action: 'mute', targetId, targetTag, executorId, executorTag, reason });
      return { ok: true, text: `${who} reached ${threshold.count} warnings and was muted until <t:${Math.floor(Date.now() / 1000) + dur}:f>.` };
    } else if (threshold.action === 'kick') {
      await client.rest.delete(`/guilds/${guildId}/members/${targetId}?reason=${encodeURIComponent(reason)}`);
      await logAction({ client, guildId, action: 'kick', targetId, targetTag, executorId, executorTag, reason });
      return { ok: true, text: `${who} reached ${threshold.count} warnings and was kicked.` };
    } else if (threshold.action === 'tempban') {
      // Same path as !tempban: ban notice, approval gate, automatic unban.
      const dur = threshold.duration_seconds ?? 86400;
      const executorIsOwner = isBotOwner(executorId) || await isRealOwner(guildId, executorId);
      if (await banNeedsApproval(client.rest, guildId, executorId, executorIsOwner)) {
        const approvalId = createApprovalRequest({ guildId, targetId, targetTag, executorId, executorTag, reason, deleteDays: 0, actionType: 'temp', durationS: dur });
        await postApprovalRequest(client.rest, guildId, approvalId, { targetId, targetTag, executorTag, reason });
        return { ok: true, text: `${who} reached ${threshold.count} warnings. A temp ban is waiting for approval (#${approvalId}).` };
      }
      await performBanAction(client.rest, guildId, targetId, reason, 'temp', 0, dur);
      await logAction({ client, guildId, action: 'tempban', targetId, targetTag, executorId, executorTag, reason });
      return { ok: true, text: `${who} reached ${threshold.count} warnings and was banned until <t:${Math.floor(Date.now() / 1000) + dur}:f>.` };
    } else if (threshold.action === 'ban') {
      // Same controls as !ban: a guild with require_approval on gets an
      // approval request, not an immediate ban via the warn side door.
      const executorIsOwner = isBotOwner(executorId) || await isRealOwner(guildId, executorId);
      if (await banNeedsApproval(client.rest, guildId, executorId, executorIsOwner)) {
        const approvalId = createApprovalRequest({ guildId, targetId, targetTag, executorId, executorTag, reason, actionType: 'ban', deleteDays: 1 });
        await postApprovalRequest(client.rest, guildId, approvalId, { targetId, targetTag, executorTag, reason });
        return { ok: true, text: `${who} reached ${threshold.count} warnings. A ban is waiting for approval (#${approvalId}).` };
      }
      await performBanAction(client.rest, guildId, targetId, reason, 'ban', 1);
      await logAction({ client, guildId, action: 'ban', targetId, targetTag, executorId, executorTag, reason });
      return { ok: true, text: `${who} reached ${threshold.count} warnings and was banned.` };
    }
    return null;
  } catch (err) {
    logger.warn(`[WARN] Threshold ${threshold.action} failed for ${targetId} in ${guildId}:`, err.message);
    return { ok: false, text: `${who} reached ${threshold.count} warnings, but the automatic ${threshold.action} failed: ${err.message}. Check Bloo's role position and permissions.` };
  }
}
