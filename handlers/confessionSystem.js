// ============================================================
//  handlers/confessionSystem.js
//
//  Per-guild anonymous confession system.
//  Members DM the bot: confess <guildId> <text>
//  Staff configure via !confess command.
//
//  Tables:
//    confession_config    , per-guild settings
//    confessions          , individual confession records
//    confession_blacklist , blocked users per guild
// ============================================================

import db from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS confession_config (
    guild_id      TEXT    PRIMARY KEY,
    enabled       INTEGER NOT NULL DEFAULT 0,
    channel_id    TEXT,
    mod_channel_id TEXT,
    moderation    INTEGER NOT NULL DEFAULT 0,
    allow_replies INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS confessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     TEXT    NOT NULL,
    author_id    TEXT    NOT NULL,
    content      TEXT    NOT NULL,
    reply_to     INTEGER,
    status       TEXT    NOT NULL DEFAULT 'pending',
    message_id   TEXT,
    submitted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS confession_blacklist (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_confessions_guild  ON confessions (guild_id, status);
`);

// ─── getConfessionConfig ──────────────────────────────────────
export function getConfessionConfig(guildId) {
  return db.prepare('SELECT * FROM confession_config WHERE guild_id = ?').get(guildId)
    ?? { guild_id: guildId, enabled: 0, channel_id: null, mod_channel_id: null, moderation: 0, allow_replies: 1 };
}

// ─── setConfessionConfig ──────────────────────────────────────
export function setConfessionConfig(guildId, fields = {}) {
  db.prepare(`
    INSERT INTO confession_config (guild_id) VALUES (?)
    ON CONFLICT(guild_id) DO NOTHING
  `).run(guildId);

  const VALID = ['enabled', 'channel_id', 'mod_channel_id', 'moderation', 'allow_replies'];
  for (const [k, v] of Object.entries(fields)) {
    if (!VALID.includes(k)) continue;
    db.prepare(`UPDATE confession_config SET ${k} = ? WHERE guild_id = ?`).run(v, guildId);
  }
}

// ─── isBlacklisted ────────────────────────────────────────────
export function isBlacklisted(guildId, userId) {
  return !!db.prepare('SELECT 1 FROM confession_blacklist WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
}

// ─── blacklistConfessionUser ──────────────────────────────────
export function blacklistConfessionUser(guildId, userId) {
  db.prepare('INSERT OR IGNORE INTO confession_blacklist (guild_id, user_id) VALUES (?, ?)').run(guildId, userId);
}

// ─── unblacklistConfessionUser ────────────────────────────────
export function unblacklistConfessionUser(guildId, userId) {
  db.prepare('DELETE FROM confession_blacklist WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
}

// ─── createConfession ─────────────────────────────────────────
// Returns new confession ID.
export function createConfession({ guildId, authorId, content, replyTo = null }) {
  const result = db.prepare(`
    INSERT INTO confessions (guild_id, author_id, content, reply_to, status, submitted_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(guildId, authorId, content, replyTo ?? null, Date.now());
  return result.lastInsertRowid;
}

// ─── getConfession ────────────────────────────────────────────
export function getConfession(confessionId) {
  return db.prepare('SELECT * FROM confessions WHERE id = ?').get(confessionId) ?? null;
}

// ─── getPendingConfessions ────────────────────────────────────
export function getPendingConfessions(guildId) {
  return db.prepare(`
    SELECT * FROM confessions
    WHERE guild_id = ? AND status = 'pending'
    ORDER BY submitted_at ASC
  `).all(guildId);
}

// ─── setConfessionStatus ──────────────────────────────────────
export function setConfessionStatus(confessionId, status, messageId = null) {
  db.prepare(`
    UPDATE confessions SET status = ?, message_id = ? WHERE id = ?
  `).run(status, messageId, confessionId);
}

// ─── revealConfessionAuthor ───────────────────────────────────
// Returns the author_id for audit, never called publicly, only Server Owner.
export function revealConfessionAuthor(confessionId) {
  return db.prepare('SELECT author_id FROM confessions WHERE id = ?').get(confessionId)?.author_id ?? null;
}

// ─── Shared with b!confess and the dashboard ──────────────────
export class ConfessionError extends Error {}
export const CONFESSION_COLOR = 0xa78bfa; // purple

// The public embed for a confession or an anonymous reply.
export function confessionEmbed(id, content, replyTo = null) {
  return {
    title: replyTo ? `💜  Anonymous Reply to Confession #${replyTo}` : `💜  Anonymous Confession #${id}`,
    description: content,
    color: CONFESSION_COLOR,
    footer: { text: `Confession #${id} • Submitted anonymously` },
    timestamp: new Date().toISOString(),
  };
}

function pendingIn(guildId, confessionId) {
  const c = getConfession(confessionId);
  if (!c || c.guild_id !== guildId || c.status !== 'pending') throw new ConfessionError('No pending confession with that ID.');
  return c;
}

// Posts a pending confession to the confession channel.
export async function approveConfession(client, guildId, confessionId) {
  const c = pendingIn(guildId, confessionId);
  const { channel_id } = getConfessionConfig(guildId);
  if (!channel_id) throw new ConfessionError('No confession channel is set.');
  const msg = await client.rest.post(`/channels/${channel_id}/messages`, { body: { embeds: [confessionEmbed(c.id, c.content, c.reply_to)] } }).catch(() => null);
  if (!msg?.id) throw new ConfessionError('Couldn\'t post to the confession channel. Check Bloo can send messages and embeds there.');
  setConfessionStatus(c.id, 'posted', msg.id);
  return { id: c.id, messageId: msg.id };
}

// Drops a pending confession without posting it. The author isn't told.
export function denyConfession(guildId, confessionId) {
  const c = pendingIn(guildId, confessionId);
  setConfessionStatus(c.id, 'denied', null);
  return { id: c.id };
}

export function listConfessionBlacklist(guildId) {
  return db.prepare('SELECT user_id FROM confession_blacklist WHERE guild_id = ?').all(guildId).map(r => r.user_id);
}

// Recent confessions for staff, without who wrote them.
export function listRecentConfessions(guildId, limit = 25) {
  return db.prepare(`
    SELECT id, content, reply_to, status, submitted_at FROM confessions
    WHERE guild_id = ? ORDER BY id DESC LIMIT ?
  `).all(guildId, limit);
}
