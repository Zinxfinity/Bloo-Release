// ============================================================
//  events/guild/banApproval.js
//
//  Handles ✅ / ❌ reactions on ban approval embeds.
//  Wired into reactionAdd.js via dynamic import.
// ============================================================

import { Embed }  from '../config/embeds.js';
import { isRealOwner, isBotOwner, getMemberPermissionBitsLive } from './staffSystem.js';
import { Permissions } from '../config/guildPermissions.js';
import {
  getBanConfig, getApprovalByMessage, resolveApproval,
  recordBan, performBanAction,
} from './banSystem.js';
import { logAction } from './modLog.js';

// Called from reactionAdd.js when the emoji is ✅ or ❌ and the message might be an approval embed.
// Returns true if this was an approval reaction and was handled.
export async function handleBanApprovalReaction(client, reaction, userId, guildId, channelId, messageId, emoji) {
  if (!guildId || !messageId || !emoji) return false;

  const emojiName = emoji.name;
  if (emojiName !== '✅' && emojiName !== '❌') return false;

  const approval = getApprovalByMessage(guildId, messageId);
  if (!approval) return false;
  if (approval.status !== 'pending') return false;

  // Remove the reactor's reaction so the embed stays clean
  try {
    const emojiPath = encodeURIComponent(emojiName);
    await client.rest.delete(`/channels/${channelId}/messages/${messageId}/reactions/${emojiPath}/${userId}`).catch(() => {});
  } catch {}

  // Skip bot reactions
  if (userId === client.user?.id) return true;

  // Permission check
  const cfg           = getBanConfig(guildId);
  const requiredFlag  = BigInt(cfg.approval_min_permission ?? '4'); // BAN_MEMBERS default
  const isOwner       = isBotOwner(userId) || await isRealOwner(guildId, userId);
  const bits          = isOwner ? 0n : await getMemberPermissionBitsLive(client, guildId, userId);
  const hasPermission = isOwner || (bits & Permissions.ADMINISTRATOR) !== 0n || (bits & requiredFlag) !== 0n;

  if (!hasPermission) {
    // DM them, they don't have permission
    try {
      const dm = await client.rest.post('/users/@me/channels', { body: { recipient_id: userId } }).catch(() => null);
      if (dm?.id) {
        await client.rest.post(`/channels/${dm.id}/messages`, {
          body: { content: `\u274C You don't have the Fluxer permissions required to approve/deny bans in that server.` },
        }).catch(() => {});
      }
    } catch {}
    return true;
  }

  if (approval.executor_id === userId) {
    // Can't self-approve
    try {
      const dm = await client.rest.post('/users/@me/channels', { body: { recipient_id: userId } }).catch(() => null);
      if (dm?.id) {
        await client.rest.post(`/channels/${dm.id}/messages`, {
          body: { content: '\u274C You cannot approve your own ban request.' },
        }).catch(() => {});
      }
    } catch {}
    return true;
  }

  const action  = emojiName === '✅' ? 'approved' : 'denied';
  resolveApproval(approval.id, action, userId);

  if (action === 'approved') {
    try {
      // The REST client has no handling anywhere for a top-level `reason`
      // option (confirmed against @fluxerjs/rest's source, only body/
      // headers/files/auth/signal are ever read), it was silently
      // discarded on every approved ban. The real audit-log reason
      // mechanism this API expects is a query-string param, matching the
      // working pattern in ban.js/tempban.js.
      // Runs the action that was actually queued (softban/hardban/ban),
      // same helper as !ban approve and the dashboard.
      const { action: logLabel, countsTowardLimit } = await performBanAction(
        client.rest, guildId, approval.target_id,
        `Approved by <@${userId}>: ${approval.reason}`,
        approval.action_type ?? 'ban', approval.delete_days ?? 1, approval.duration_s,
      );
      await logAction({
        client, guildId, action: logLabel, targetId: approval.target_id,
        executorId: userId, reason: `Approved: ${approval.reason}`,
      }).catch(() => {});
      if (countsTowardLimit) recordBan(guildId, approval.executor_id);

      // Update the embed in the approval channel
      await client.rest.patch(`/channels/${channelId}/messages/${messageId}`, {
        body: {
          embeds: [{
            color: 0x4ade80,
            title: '\u2705  Ban Approved',
            description: `**${approval.target_tag}** has been ${logLabel === 'Softban' ? 'softbanned' : 'banned'}.\n` +
              `Approved by <@${userId}> | Requested by <@${approval.executor_id}>`,
            footer: { text: `Approval #${approval.id}` },
            timestamp: new Date().toISOString(),
          }],
        },
      }).catch(() => {});
    } catch {
      await client.rest.patch(`/channels/${channelId}/messages/${messageId}`, {
        body: { embeds: [{ color: 0xf87171, title: '\u274C  Approval Recorded but Ban Failed', description: 'The approval was logged but the REST call failed.' }] },
      }).catch(() => {});
    }
  } else {
    await client.rest.patch(`/channels/${channelId}/messages/${messageId}`, {
      body: {
        embeds: [{
          color: 0xf87171,
          title: '\u274C  Ban Denied',
          description: `**${approval.target_tag}** was NOT banned.\nDenied by <@${userId}>`,
          footer: { text: `Approval #${approval.id}` },
          timestamp: new Date().toISOString(),
        }],
      },
    }).catch(() => {});
  }

  return true;
}

// Deliberately no default export. This file's logic is called directly from
// reactionAdd.js (which checks the emoji and calls handleBanApprovalReaction),
// not dispatched through the event system. handlers/eventHandler.js's
// loadCategory() scans every .js file in this directory with no exclusion
// list, a stray {name: Events.MessageReactionAdd, execute: () => {}} export
// here used to get picked up as a second, independent messageReactionAdd
// listener alongside reactionAdd.js's real one, firing a true no-op on every
// single reaction anywhere in the bot. Harmless today, but a trap for
// anyone who later adds real logic to that "dead" execute() expecting it to
// be unreachable.
