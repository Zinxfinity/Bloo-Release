import { getMsgLogConfig, resolveAuthor } from './messageLogger.js';
import { getModlogConfig } from './modLog.js';
import { getTrackedMember } from './memberTracking.js';
import logger from '../utils/logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ts(unixSeconds, format = 'F') {
  return `<t:${unixSeconds}:${format}>`;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

async function sendLog(client, guildId, content) {
  const cfg = getMsgLogConfig(guildId);
  if (!cfg?.enabled || !cfg.channel_id) return;
  try {
    // Raw REST, not client.channels.fetch() + channel.send(): confirmed in
    // production that pattern fails with "channel.send is not a function"
    // for at least one channel type on v2.0.1's SDK.
    await client.rest.post(`/channels/${cfg.channel_id}/messages`, { body: { content } });
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
  const tag    = member.user?.username ?? userId;
  const now    = nowSec();

  // Fluxer exposes createdAt as raw created_at string from the API
  const createdRaw = member.user?.createdAt ?? null;
  const createdMs  = createdRaw ? new Date(createdRaw).getTime() : null;
  const createdSec = createdMs && !isNaN(createdMs) ? Math.floor(createdMs / 1000) : null;

  const lines = [`📥 **Member joined**: ${tag} (\`${userId}\`), ${ts(now, 'F')}`];
  if (createdSec) lines.push(`Account created ${ts(createdSec, 'F')}, ${ts(createdSec, 'R')}`);

  await sendLog(client, guildId, lines.join('\n'));
}

// ─── logMemberLeave ───────────────────────────────────────────────────────────
export async function logMemberLeave(client, member) {
  const guildId = member.guild?.id ?? member.guildId;
  const cfg     = getModlogConfig(guildId);
  if (!cfg?.log_leaves) return;

  const userId = member.user?.id ?? member.id;
  const tag    = member.user?.username ?? userId;
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

  const content = `📤 **Member left**: ${tag} (\`${userId}\`), ${ts(now, 'F')}\nTime in server: ${timeInServer}`;

  await sendLog(client, guildId, content);
}

// ─── logRoleChange ────────────────────────────────────────────────────────────
export async function logRoleChange(client, guildId, userId, gained, lost) {
  if (!gained.length && !lost.length) return;
  const cfg = getModlogConfig(guildId);
  if (!cfg?.log_role_changes) return;

  const now    = nowSec();
  const author = await resolveAuthor(client, guildId, userId);

  // Fetch guild roles to resolve names
  let rolesMap = new Map();
  try {
    const roles = await client.rest.get(`/guilds/${guildId}/roles`).catch(() => []);
    if (Array.isArray(roles)) {
      for (const r of roles) rolesMap.set(r.id, r.name);
    }
  } catch { /* best effort */ }

  const fmt = id => `${rolesMap.get(id) ?? 'Unknown Role'} (\`${id}\`)`;

  const parts = [];
  if (gained.length) parts.push(`Added (now has): ${gained.map(fmt).join(', ')}`);
  if (lost.length)   parts.push(`Removed (previously had): ${lost.map(fmt).join(', ')}`);

  const content = `🎭 **Role update**: ${author}, ${ts(now, 'F')}\n${parts.join('\n')}`;

  await sendLog(client, guildId, content);
}

// ─── logNickChange ────────────────────────────────────────────────────────────
export async function logNickChange(client, guildId, userId, oldNick, newNick) {
  const cfg = getModlogConfig(guildId);
  if (!cfg?.log_nick_changes) return;

  const now    = nowSec();
  const author = await resolveAuthor(client, guildId, userId);
  const content = `✏️ **Nickname changed**: ${author}, ${ts(now, 'F')}\nBefore: ${oldNick ?? 'None'}, After: ${newNick ?? 'None'}`;

  await sendLog(client, guildId, content);
}
