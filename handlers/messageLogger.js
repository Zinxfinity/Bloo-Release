import db from '../db.js';
import logger from '../utils/logger.js';
import { handle as guardHandle, clear as guardClear } from './permissionGuard.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS message_log_config (
    guild_id    TEXT PRIMARY KEY,
    channel_id  TEXT,
    enabled     INTEGER NOT NULL DEFAULT 0,
    log_edits   INTEGER NOT NULL DEFAULT 0,
    log_deletes INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS message_log_ignored (
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );
`);

for (const col of [
  `ALTER TABLE message_log_config ADD COLUMN log_sent    INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE message_log_config ADD COLUMN log_bot     INTEGER NOT NULL DEFAULT 0`,
  // 'detailed' (default) or 'minimal'; see formatEntry() below.
  `ALTER TABLE message_log_config ADD COLUMN log_style   TEXT NOT NULL DEFAULT 'detailed'`,
]) { try { db.exec(col); } catch { /* already exists */ } }

export const LOG_STYLES = ['detailed', 'minimal'];

const stmts = {
  get:    db.prepare(`SELECT * FROM message_log_config WHERE guild_id = ?`),
  ensure: db.prepare(`INSERT OR IGNORE INTO message_log_config (guild_id) VALUES (?)`),
  set:    db.prepare(`
    UPDATE message_log_config SET channel_id=?, enabled=?, updated_at=unixepoch()
    WHERE guild_id = ?
  `),
  isIgnored: db.prepare(`
    SELECT 1 FROM message_log_ignored WHERE guild_id = ? AND channel_id = ?
  `),
};

// Simple in-memory send queue per channel to avoid rate limits
const queues = new Map();
function queueLog(channelId, fn) {
  const prev = queues.get(channelId) ?? Promise.resolve();
  const next  = prev.then(fn).catch(() => {});
  queues.set(channelId, next);
  next.finally(() => { if (queues.get(channelId) === next) queues.delete(channelId); });
}

function getConfig(guildId) {
  stmts.ensure.run(guildId);
  return stmts.get.get(guildId);
}

function isIgnored(guildId, channelId) {
  return !!stmts.isIgnored.get(guildId, channelId);
}

export async function resolveAuthor(client, guildId, userId) {
  // Uncached PartialMessage entries (e.g. from a bulk delete) carry no
  // author at all, guard here rather than fetching /members/undefined and
  // ultimately returning the literal string "undefined" once interpolated.
  if (!userId) return 'Unknown user';
  try {
    const member = await client.rest.get(`/guilds/${guildId}/members/${userId}`).catch(() => null);
    if (member) {
      return member.nick ?? member.user?.global_name ?? member.user?.username ?? userId;
    }
  } catch { /* best effort */ }
  return userId;
}

// ─── Who did it ───────────────────────────────────────────────────────────────
// Every log entry names the person as username#0000 (id): the ID survives
// renames, so staff can still find, ban or kick someone who deleted their
// messages and changed their name. `known` is user data already in hand (from
// the event), which saves a lookup and keeps the name they had at the time.
export const userTag = u => u?.username
  ? (u.discriminator && u.discriminator !== '0' ? `${u.username}#${u.discriminator}` : u.username)
  : null;

export async function describeUser(client, guildId, userId, known = null) {
  if (!userId) return { id: null, tag: 'Unknown user' };
  let user = known?.username ? known : null;
  if (!user) {
    const member = await client.rest.get(`/guilds/${guildId}/members/${userId}`).catch(() => null);
    user = member?.user ?? await client.rest.get(`/users/${userId}`).catch(() => null);
  }
  return { id: userId, tag: userTag(user) ?? 'Unknown user' };
}

// Detailed adds a mention (no ping: every log post sends allowed_mentions
// none), which shows their current name and opens their profile in one click.
export const who = (u, style = 'detailed') => !u.id
  ? u.tag
  : `${style === 'minimal' ? '' : `<@${u.id}> `}${u.tag} (\`${u.id}\`)`;

const oneLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const quote = s => String(s).split('\n').map(l => `> ${l}`).join('\n');

// One message-log entry in the server's chosen style. Plain text either way,
// so Fluxer's search still finds names, IDs and message content.
//   detailed: a heading line, the person on their own line, the content quoted
//   minimal:  everything on one line, content shortened
export function formatEntry(style, { icon, title, channelId, user, body = null, before = null, after = null }) {
  const now = Math.floor(Date.now() / 1000);
  if (style === 'minimal') {
    const where = channelId ? ` in <#${channelId}>` : '';
    const text = before != null ? `: ${oneLine(before, 150)} → ${oneLine(after, 150)}` : body != null ? `: ${oneLine(body, 300)}` : '';
    return `${icon} ${who(user, 'minimal')}${where}${text}`;
  }
  const lines = [`${icon} **${title}**${channelId ? ` in <#${channelId}>` : ''}, <t:${now}:F>`, `**User:** ${who(user)}`];
  if (before != null) lines.push('**Before:**', quote(before), '**After:**', quote(after));
  else if (body != null) lines.push(quote(body));
  return lines.join('\n');
}

export function setMsgLogStyle(guildId, style) {
  if (!LOG_STYLES.includes(style)) throw new Error(`Log style must be one of: ${LOG_STYLES.join(', ')}.`);
  stmts.ensure.run(guildId);
  db.prepare(`UPDATE message_log_config SET log_style = ?, updated_at = unixepoch() WHERE guild_id = ?`).run(style, guildId);
}

export function setMessageLogConfig(guildId, channelId, enabled) {
  stmts.ensure.run(guildId);
  stmts.set.run(channelId, enabled ? 1 : 0, guildId);
}

export function getMessageLogConfig(guildId) {
  return getConfig(guildId);
}

export async function logMessageSent(client, message) {
  const guildId   = message.guildId;
  const channelId = message.channelId;
  if (!guildId || !channelId) return;

  const config = getConfig(guildId);
  if (!config?.enabled || !config.channel_id || !config.log_sent) return;
  if (!config.log_bot && message.author?.bot) return;
  if (isIgnored(guildId, channelId)) return;

  const userId  = message.author?.id ?? message.authorId;
  const user    = await describeUser(client, guildId, userId, message.author);
  const content = message.content?.slice(0, 1800) || '*(no text content)*';

  queueLog(config.channel_id, async () => {
    try {
      // Raw REST, not client.channels.fetch() + channel.send(): confirmed
      // in production that pattern fails with "channel.send is not a
      // function" for at least one channel type on v2.0.1's SDK.
      await client.rest.post(`/channels/${config.channel_id}/messages`, {
        body: {
          content: formatEntry(config.log_style, { icon: '📨', title: 'Message sent', channelId, user, body: content }),
          allowed_mentions: { parse: [] },
        },
      });
      guardClear('MSGLOG', guildId);
    } catch (err) {
      guardHandle('MSGLOG', guildId, config.channel_id, err, () => setMsgLogChannel(guildId, null));
      logger.warn(`[MSGLOG] Sent log failed in ${guildId}:`, err.message);
    }
  });
}

export async function logMessageDelete(client, message, guildIdOverride) {
  // MESSAGE_DELETE payloads carry no top-level guildId, only via the cached channel.
  // guildIdOverride lets the event handler pass its own already-resolved value
  // (which may include a channel-fetch fallback the event handler performed)
  // instead of this function silently failing if message.channel isn't hydrated.
  const guildId   = guildIdOverride ?? message.guildId ?? message.channel?.guildId ?? null;
  const channelId = message.channelId;
  if (!guildId || !channelId) return;

  const config = getConfig(guildId);
  if (!config?.enabled || !config.channel_id || !config.log_deletes) return;
  if (!config.log_bot && message.author?.bot) return;
  if (isIgnored(guildId, channelId)) return;

  const userId  = message.authorId ?? message.author?.id;
  const user    = await describeUser(client, guildId, userId, message.author);
  const content = message.content?.slice(0, 1800) || '*(no content)*';

  queueLog(config.channel_id, async () => {
    try {
      await client.rest.post(`/channels/${config.channel_id}/messages`, {
        body: {
          content: formatEntry(config.log_style, { icon: '🗑️', title: 'Message deleted', channelId, user, body: content }),
          allowed_mentions: { parse: [] },
        },
      });
      guardClear('MSGLOG', guildId);
    } catch (err) {
      guardHandle('MSGLOG', guildId, config.channel_id, err, () => setMsgLogChannel(guildId, null));
      logger.warn(`[MSGLOG] Delete log failed in ${guildId}:`, err.message);
    }
  });
}

export async function logMessageEdit(client, oldMessage, newMessage, guildIdOverride) {
  const guildId   = guildIdOverride ?? newMessage.guildId;
  const channelId = newMessage.channelId;
  if (!guildId || !channelId) return;

  const config = getConfig(guildId);
  if (!config?.enabled || !config.channel_id || !config.log_edits) return;
  if (!config.log_bot && newMessage.author?.bot) return;
  if (isIgnored(guildId, channelId)) return;

  const userId  = newMessage.author?.id ?? newMessage.authorId;
  const before  = oldMessage?.content?.slice(0, 900) ?? '*(not cached)*';
  const after   = newMessage.content?.slice(0, 900) || '*(empty)*';

  if (before === after) return;
  const user    = await describeUser(client, guildId, userId, newMessage.author);

  queueLog(config.channel_id, async () => {
    try {
      await client.rest.post(`/channels/${config.channel_id}/messages`, {
        body: {
          content: formatEntry(config.log_style, { icon: '✏️', title: 'Message edited', channelId, user, before, after }),
          allowed_mentions: { parse: [] },
        },
      });
      guardClear('MSGLOG', guildId);
    } catch (err) {
      guardHandle('MSGLOG', guildId, config.channel_id, err, () => setMsgLogChannel(guildId, null));
      logger.warn(`[MSGLOG] Edit log failed in ${guildId}:`, err.message);
    }
  });
}

// ─── Aliases for modlog.js command ────────────────────────────────────────────
export function getMsgLogConfig(guildId) {
  return getMessageLogConfig(guildId);
}

export function setMsgLogChannel(guildId, channelId) {
  // Always enable when a channel is set, always disable when cleared
  setMessageLogConfig(guildId, channelId, channelId ? 1 : 0);
}

export function setMsgLogToggle(guildId, type, enabled) {
  const COLUMN_MAP = {
    sent:    'log_sent',
    edited:  'log_edits',
    deleted: 'log_deletes',
    bot:     'log_bot',
  };
  const col = COLUMN_MAP[type];
  if (!col) return;
  stmts.ensure.run(guildId);
  db.prepare(`UPDATE message_log_config SET ${col} = ? WHERE guild_id = ?`).run(enabled ? 1 : 0, guildId);
}

export function addIgnoredChannel(guildId, channelId) {
  try {
    db.prepare('INSERT OR IGNORE INTO message_log_ignored (guild_id, channel_id) VALUES (?, ?)').run(guildId, channelId);
  } catch {}
}

export function removeIgnoredChannel(guildId, channelId) {
  try {
    db.prepare('DELETE FROM message_log_ignored WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId);
  } catch {}
}

export function getIgnoredChannels(guildId) {
  try {
    return db.prepare('SELECT channel_id FROM message_log_ignored WHERE guild_id = ? ORDER BY channel_id').all(guildId).map(r => r.channel_id);
  } catch { return []; }
}
