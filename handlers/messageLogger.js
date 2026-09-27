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
]) { try { db.exec(col); } catch { /* already exists */ } }

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
  const author  = await resolveAuthor(client, guildId, userId);
  const content = message.content?.slice(0, 1800) || '*(no text content)*';

  queueLog(config.channel_id, async () => {
    try {
      // Raw REST, not client.channels.fetch() + channel.send(): confirmed
      // in production that pattern fails with "channel.send is not a
      // function" for at least one channel type on v2.0.1's SDK.
      await client.rest.post(`/channels/${config.channel_id}/messages`, {
        body: {
          content: `📨 **Message sent** in <#${channelId}> by **${author}**, <t:${Math.floor(Date.now() / 1000)}:F>\n${content}`,
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
  const author  = await resolveAuthor(client, guildId, userId);
  const content = message.content?.slice(0, 1800) ?? '*(no content)*';

  queueLog(config.channel_id, async () => {
    try {
      await client.rest.post(`/channels/${config.channel_id}/messages`, {
        body: {
          content: `🗑️ **Message deleted** in <#${channelId}> by **${author}**, <t:${Math.floor(Date.now() / 1000)}:F>\n${content}`,
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
  const author  = await resolveAuthor(client, guildId, userId);
  const before  = oldMessage?.content?.slice(0, 900) ?? '*(uncached)*';
  const after   = newMessage.content?.slice(0, 900) ?? '*(empty)*';

  if (before === after) return;

  queueLog(config.channel_id, async () => {
    try {
      await client.rest.post(`/channels/${config.channel_id}/messages`, {
        body: {
          content: `✏️ **Message edited** in <#${channelId}> by **${author}**, <t:${Math.floor(Date.now() / 1000)}:F>\n**Before:** ${before}\n**After:** ${after}`,
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
