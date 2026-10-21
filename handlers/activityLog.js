import { getMsgLogConfig, describeUser, userTag, who } from './messageLogger.js';
import { getModlogConfig } from './modLog.js';
import { getTrackedMember } from './memberTracking.js';
import logger from '../utils/logger.js';

// Joins, leaves, role changes and name changes. Their switches live on
// modlog_config, but they post to the message log channel in its style
// ('detailed' or 'minimal', see messageLogger.js formatEntry). Every entry
// names the person as username#0000 (id) so they can be found after a rename.

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ts(unixSeconds, format = 'F') {
  return `<t:${unixSeconds}:${format}>`;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// `content` is a function of the log style, or a plain string.
async function sendLog(client, guildId, content) {
  const cfg = getMsgLogConfig(guildId);
  if (!cfg?.enabled || !cfg.channel_id) return;
  try {
    // Raw REST, not client.channels.fetch() + channel.send(): confirmed in
    // production that pattern fails with "channel.send is not a function"
    // for at least one channel type on v2.0.1's SDK.
    await client.rest.post(`/channels/${cfg.channel_id}/messages`, {
      body: {
        content: typeof content === 'function' ? content(cfg.log_style ?? 'detailed') : content,
        allowed_mentions: { parse: [] },
      },
    });
  } catch (err) {
    logger.warn(`[ACTLOG] Failed to send log in ${guildId}:`, err.message);
  }
}

// ─── logMemberJoin ────────────────────────────────────────────────────────────
export async function logMemberJoin(client, member) {
  const guildId = member.guild?.id ?? member.guildId;
  const cfg     = getModlogConfig(guildId);
  if (!cfg?.log_joins) return;

  const userId = member.user?.id ?? member.id;
  const user   = { id: userId, tag: userTag(member.user) ?? 'Unknown user' };
  const now    = nowSec();

  // Fluxer exposes createdAt as raw created_at string from the API
  const createdRaw = member.user?.createdAt ?? null;
  const createdMs  = createdRaw ? new Date(createdRaw).getTime() : null;
  const createdSec = createdMs && !isNaN(createdMs) ? Math.floor(createdMs / 1000) : null;

  await sendLog(client, guildId, style => style === 'minimal'
    ? `📥 ${who(user, 'minimal')} joined${createdSec ? `, account made ${ts(createdSec, 'R')}` : ''}`
    : [
        `📥 **Member joined**, ${ts(now, 'F')}`,
        `**User:** ${who(user)}`,
        ...(createdSec ? [`Account created ${ts(createdSec, 'F')}, ${ts(createdSec, 'R')}`] : []),
      ].join('\n'));
}

// ─── logMemberLeave ───────────────────────────────────────────────────────────
export async function logMemberLeave(client, member) {
  const guildId = member.guild?.id ?? member.guildId;
  const cfg     = getModlogConfig(guildId);
  if (!cfg?.log_leaves) return;

  const userId = member.user?.id ?? member.id;
  const user   = { id: userId, tag: userTag(member.user) ?? 'Unknown user' };
  const now    = nowSec();

  // Fluxer exposes joinedAt as a Date object. v3: GuildMemberRemove's member
  // is a PartialGuildMember and never carries joinedAt at all, even for
  // long-standing members, fall back to the live-synced tracking table.
  const joinedAtValue = member.joinedAt ?? getTrackedMember(guildId, userId)?.joinedAt ?? null;
  const joinedMs = joinedAtValue instanceof Date
    ? joinedAtValue.getTime()
    : (joinedAtValue ? new Date(joinedAtValue).getTime() : null);

  let timeInServer = 'Unknown';
  if (joinedMs && !isNaN(joinedMs)) {
    const secs  = Math.floor((Date.now() - joinedMs) / 1000);
    const days  = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    const mins  = Math.floor((secs % 3600)  / 60);
    timeInServer = days  > 0 ? `${days}d ${hours}h ${mins}m`
                 : hours > 0 ? `${hours}h ${mins}m`
                 : `${mins}m`;
  }

  await sendLog(client, guildId, style => style === 'minimal'
    ? `📤 ${who(user, 'minimal')} left after ${timeInServer}`
    : [`📤 **Member left**, ${ts(now, 'F')}`, `**User:** ${who(user)}`, `Time in server: ${timeInServer}`].join('\n'));
}

// ─── logRoleChange ────────────────────────────────────────────────────────────
export async function logRoleChange(client, guildId, userId, gained, lost) {
  if (!gained.length && !lost.length) return;
  const cfg = getModlogConfig(guildId);
  if (!cfg?.log_role_changes) return;

  const now  = nowSec();
  const user = await describeUser(client, guildId, userId);

  // Fetch guild roles to resolve names
  let rolesMap = new Map();
  try {
    const roles = await client.rest.get(`/guilds/${guildId}/roles`).catch(() => []);
    if (Array.isArray(roles)) {
      for (const r of roles) rolesMap.set(r.id, r.name);
    }
  } catch { /* best effort */ }

  const name = id => rolesMap.get(id) ?? 'Unknown Role';
  const fmt  = id => `${name(id)} (\`${id}\`)`;

  const parts = [];
  if (gained.length) parts.push(`Added (now has): ${gained.map(fmt).join(', ')}`);
  if (lost.length)   parts.push(`Removed (previously had): ${lost.map(fmt).join(', ')}`);

  await sendLog(client, guildId, style => style === 'minimal'
    ? `🎭 ${who(user, 'minimal')}: ${[...gained.map(id => `+${name(id)}`), ...lost.map(id => `-${name(id)}`)].join(', ')}`
    : [`🎭 **Role update**, ${ts(now, 'F')}`, `**User:** ${who(user)}`, ...parts].join('\n'));
}

// ─── logNickChange ────────────────────────────────────────────────────────────
// Server nickname changes. `user` is the member's user data from the event,
// so the entry shows their account name rather than the nickname that just
// changed.
export async function logNickChange(client, guildId, userId, oldNick, newNick, user = null) {
  const cfg = getModlogConfig(guildId);
  if (!cfg?.log_nick_changes) return;

  const now = nowSec();
  const u   = await describeUser(client, guildId, userId, user);
  await sendLog(client, guildId, style => style === 'minimal'
    ? `🏷️ ${who(u, 'minimal')} changed nickname: ${oldNick ?? 'none'} → ${newNick ?? 'none'}`
    : [`🏷️ **Nickname changed**, ${ts(now, 'F')}`, `**User:** ${who(u)}`, `Before: ${oldNick ?? 'None'}`, `After: ${newNick ?? 'None'}`].join('\n'));
}

// ─── logUsernameChange ────────────────────────────────────────────────────────
// Account username (or tag) changes, seen when the member updates in a server
// with name-change logging on. Lets staff follow someone across renames: the
// ID stays the same. Shares the nickname-change switch.
export async function logUsernameChange(client, guildId, userId, oldUser, newUser) {
  const cfg = getModlogConfig(guildId);
  if (!cfg?.log_nick_changes) return;

  const now    = nowSec();
  const oldTag = userTag(oldUser) ?? 'unknown';
  const u      = { id: userId, tag: userTag(newUser) ?? 'Unknown user' };
  await sendLog(client, guildId, style => style === 'minimal'
    ? `🪪 ${who({ id: userId, tag: oldTag }, 'minimal')} is now ${u.tag}`
    : [`🪪 **Username changed**, ${ts(now, 'F')}`, `**User:** ${who(u)}`, `Before: ${oldTag}`, `After: ${u.tag}`].join('\n'));
}
