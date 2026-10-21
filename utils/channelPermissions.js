// ============================================================
//  utils/channelPermissions.js
//
//  What a member (usually Bloo itself) can actually do in one channel.
//  Server-wide role permissions aren't the whole answer: a channel's own
//  overrides can take them away again, which is how announcement channels
//  stop @everyone posting. A role that may "Send Messages" server-wide
//  still can't post there unless the channel allows that role too.
//
//  Order, as Fluxer applies it: @everyone's and the member's server roles,
//  then the channel's @everyone override, then its role overrides (all
//  denies, then all allows), then an override for the member themselves.
//  Administrator skips all of it.
//
//  `get` is a REST GET function (client.rest.get on the bot, fluxerFetch on
//  the dashboard), so both processes share this.
// ============================================================

import { Permissions } from '../config/guildPermissions.js';

const ALL = Object.values(Permissions).reduce((a, b) => a | b, 0n);
const big = v => { try { return BigInt(v ?? 0); } catch { return 0n; } };
const isRole = o => o.type === 0 || o.type === 'role' || o.type === '0';

export async function channelPermissions(get, guildId, channelId, userId) {
  const [member, roles, channel, guild] = await Promise.all([
    get(`/guilds/${guildId}/members/${userId}`).catch(() => null),
    get(`/guilds/${guildId}/roles`).catch(() => null),
    get(`/channels/${channelId}`).catch(() => null),
    get(`/guilds/${guildId}`).catch(() => null),
  ]);
  if (!member || !Array.isArray(roles) || !channel) return null; // couldn't tell
  if (guild?.owner_id && guild.owner_id === userId) return ALL;

  const roleIds = new Set(member.roles ?? []);
  const byId = new Map(roles.map(r => [r.id, r]));
  let perms = big(byId.get(guildId)?.permissions); // @everyone shares the server's ID
  for (const id of roleIds) perms |= big(byId.get(id)?.permissions);
  if (perms & Permissions.ADMINISTRATOR) return ALL;

  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find(o => o.id === guildId);
  if (everyone) perms = (perms & ~big(everyone.deny)) | big(everyone.allow);

  let deny = 0n, allow = 0n;
  for (const o of overwrites) {
    if (o.id !== guildId && isRole(o) && roleIds.has(o.id)) { deny |= big(o.deny); allow |= big(o.allow); }
  }
  perms = (perms & ~deny) | allow;

  const own = overwrites.find(o => !isRole(o) && o.id === userId);
  if (own) perms = (perms & ~big(own.deny)) | big(own.allow);
  return perms;
}

// The permissions a feed needs in its channel, by name, that are missing.
// null means it couldn't be checked (the API didn't answer), not "fine".
export const FEED_PERMISSIONS = { 'View Channel': Permissions.VIEW_CHANNEL, 'Send Messages': Permissions.SEND_MESSAGES, 'Embed Links': Permissions.EMBED_LINKS };

export async function missingPermissions(get, guildId, channelId, userId, needed = FEED_PERMISSIONS) {
  const perms = await channelPermissions(get, guildId, channelId, userId);
  if (perms == null) return null;
  return Object.entries(needed).filter(([, bit]) => !(perms & bit)).map(([name]) => name);
}
