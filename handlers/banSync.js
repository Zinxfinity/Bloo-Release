// ============================================================
//  handlers/banSync.js
//
//  Replicates a ban/unban across every sibling guild in the same
//  server group(s) as the origin guild, honoring each guild's own
//  sync_bans/sync_unbans opt-in toggle. A sync only crosses to a
//  sibling guild if BOTH the origin and the destination have the
//  relevant toggle enabled for that group membership.
//
//  IMPORTANT, loop safety: this module is only ever called from
//  command-level call sites (ban.js, unban.js) right after a
//  *local* ban/unban succeeds. Do NOT call it from a generic
//  gateway "ban added" event listener, that would double-fire
//  (once from the command, once from the gateway event) and can
//  create sync loops across overlapping groups. If a gateway
//  -driven trigger is ever added, it needs its own dedupe key
//  (e.g. `${guildId}:${userId}` with a short TTL) to break loops.
// ============================================================

import { getGroupsForGuild, getGroupMembers } from './serverGroups.js';
import logger from '../utils/logger.js';

// Disabled 2026-09-23: joining a group needed nothing but its ID and Ban
// Members in the joining server, so anyone owning another server could
// join a group and push bans/unbans into it. Existing groups and rows are
// kept untouched; flip this back once joining requires the group's consent.
export const SERVER_GROUPS_ENABLED = false;

// field: 'sync_bans' | 'sync_unbans'
function getSiblingGuilds(originGuildId, field) {
  const groups   = getGroupsForGuild(originGuildId).filter(g => g[field]);
  const siblings = new Map(); // guildId -> true (dedupe across groups)
  for (const group of groups) {
    for (const member of getGroupMembers(group.id)) {
      if (member.guild_id === originGuildId) continue;
      if (!member[field]) continue; // destination must also opt in
      siblings.set(member.guild_id, true);
    }
  }
  return [...siblings.keys()];
}

async function syncAction(originGuildId, targetUserId, field, apply) {
  if (!SERVER_GROUPS_ENABLED) return { synced: [], failed: [] };
  const siblingGuildIds = getSiblingGuilds(originGuildId, field);
  const synced = [];
  const failed = [];

  for (const guildId of siblingGuildIds) {
    try {
      await apply(guildId);
      synced.push(guildId);
    } catch (err) {
      logger.warn(`[BANSYNC] Failed to sync to guild ${guildId} for user ${targetUserId}: ${err.message}`);
      failed.push({ guildId, error: err.message });
    }
  }

  return { synced, failed };
}

export async function syncBanAcrossGroup(client, guildId, targetUserId, reason, originGuildName = guildId) {
  const syncReason = `[Synced from ${originGuildName}] ${reason ?? 'No reason provided'}`.slice(0, 512);
  return syncAction(guildId, targetUserId, 'sync_bans', (siblingGuildId) =>
    client.rest.put(`/guilds/${siblingGuildId}/bans/${targetUserId}?reason=${encodeURIComponent(syncReason)}`, {
      body: { delete_message_seconds: 0 },
    })
  );
}

export async function syncUnbanAcrossGroup(client, guildId, targetUserId) {
  return syncAction(guildId, targetUserId, 'sync_unbans', (siblingGuildId) =>
    client.rest.delete(`/guilds/${siblingGuildId}/bans/${targetUserId}`)
  );
}
