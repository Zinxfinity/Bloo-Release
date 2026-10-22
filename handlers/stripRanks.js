// ============================================================
//  handlers/stripRanks.js
//
//  Removes every role from a member (minus any kept ones), shared by
//  b!stripranks and the dashboard's Actions page so both run the same
//  checks, write the same mod log case and alert the watchlist.
// ============================================================

import { canActOnLive, botCanActOnLive } from '../config/guildPermissions.js';
import { sendModLog } from './modLog.js';
import { alertWatchlist } from './watchlist.js';

// A refusal with a message fit to show the person who asked.
export class StripRanksError extends Error {}

// client needs rest.get/delete/post and user.id (the bot), for the
// hierarchy check. onStart(count) runs once the removal is about to begin.
export async function stripMemberRoles(client, guildId, { targetId, executorId, executorIsOwner = false, keep = [], reason, onStart } = {}) {
  if (targetId === executorId) throw new StripRanksError('You cannot strip your own roles.');
  const member = await client.rest.get(`/guilds/${guildId}/members/${targetId}`).catch(() => null);
  if (!member) throw new StripRanksError('That user is not in this server.');
  if (!executorIsOwner && !(await canActOnLive(client, guildId, executorId, targetId)))
    throw new StripRanksError(`<@${targetId}> holds a Fluxer role position equal to or above yours.`);
  if (!(await botCanActOnLive(client, guildId, targetId)))
    throw new StripRanksError('That member has a role higher than Bloo\'s in the Fluxer hierarchy.');

  const kept = new Set(keep);
  const roles = (member.roles ?? []).filter(id => id !== guildId && !kept.has(id));
  if (!roles.length) throw new StripRanksError('This member has no removable roles.');
  await onStart?.(roles.length);

  let removed = 0, failed = 0;
  for (const roleId of roles) {
    const ok = await client.rest.delete(`/guilds/${guildId}/members/${targetId}/roles/${roleId}`).then(() => true).catch(() => false);
    if (ok) removed++; else failed++;
  }

  const why = reason || 'No reason provided';
  await sendModLog(client, guildId, { action: 'Roles Stripped', targetId, executorId, reason: why });
  await alertWatchlist(client, guildId, targetId, `Roles Stripped (${removed} removed)`, why);
  return { removed, failed, kept: [...kept], reason: why };
}
