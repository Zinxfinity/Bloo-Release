// ============================================================
//  handlers/appealSystem.js
//
//  Per-guild ban appeal system. Banned users DM the bot with:
//    appeal <guildId> <reason>
//  Staff approve/deny via !appeal command.
//
//  Tables:
//    appeal_config , per-guild settings
//    ban_appeals   , individual appeal records
// ============================================================

import db from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS appeal_config (
    guild_id      TEXT    PRIMARY KEY,
    enabled       INTEGER NOT NULL DEFAULT 0,
    channel_id    TEXT,
    cooldown_days INTEGER NOT NULL DEFAULT 7
  );

  CREATE TABLE IF NOT EXISTS ban_appeals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     TEXT    NOT NULL,
    user_id      TEXT    NOT NULL,
    username     TEXT    NOT NULL,
    reason       TEXT    NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'pending',
    resolved_by  TEXT,
    resolve_reason TEXT,
    message_id   TEXT,
    submitted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    resolved_at  INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_ban_appeals_guild  ON ban_appeals (guild_id, status);
  CREATE INDEX IF NOT EXISTS idx_ban_appeals_user   ON ban_appeals (guild_id, user_id);
`);

// ─── getAppealConfig ──────────────────────────────────────────
export function getAppealConfig(guildId) {
  const row = db.prepare('SELECT * FROM appeal_config WHERE guild_id = ?').get(guildId);
  return row ?? { guild_id: guildId, enabled: 0, channel_id: null, cooldown_days: 7 };
}

// ─── setAppealConfig ──────────────────────────────────────────
export function setAppealConfig(guildId, fields = {}) {
  db.prepare(`
    INSERT INTO appeal_config (guild_id, enabled, channel_id, cooldown_days)
    VALUES (?, 0, NULL, 7)
    ON CONFLICT(guild_id) DO NOTHING
  `).run(guildId);

  const VALID = ['enabled', 'channel_id', 'cooldown_days'];
  for (const [k, v] of Object.entries(fields)) {
    if (!VALID.includes(k)) continue;
    db.prepare(`UPDATE appeal_config SET ${k} = ? WHERE guild_id = ?`).run(v, guildId);
  }
}

// ─── getLastAppeal ────────────────────────────────────────────
// Returns the most recent appeal by this user for this guild.
export function getLastAppeal(guildId, userId) {
  return db.prepare(`
    SELECT * FROM ban_appeals
    WHERE guild_id = ? AND user_id = ?
    ORDER BY submitted_at DESC LIMIT 1
  `).get(guildId, userId) ?? null;
}

// ─── createAppeal ─────────────────────────────────────────────
// Returns the new appeal ID.
export function createAppeal({ guildId, userId, username, reason }) {
  const result = db.prepare(`
    INSERT INTO ban_appeals (guild_id, user_id, username, reason, status, submitted_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(guildId, userId, username, reason, Date.now());
  return result.lastInsertRowid;
}

// ─── setAppealMessageId ───────────────────────────────────────
export function setAppealMessageId(appealId, messageId) {
  db.prepare('UPDATE ban_appeals SET message_id = ? WHERE id = ?').run(messageId, appealId);
}

// ─── getAppeal ────────────────────────────────────────────────
export function getAppeal(appealId) {
  return db.prepare('SELECT * FROM ban_appeals WHERE id = ?').get(appealId) ?? null;
}

// ─── getPendingAppeals ────────────────────────────────────────
export function getPendingAppeals(guildId) {
  return db.prepare(`
    SELECT * FROM ban_appeals
    WHERE guild_id = ? AND status = 'pending'
    ORDER BY submitted_at ASC
  `).all(guildId);
}

// ─── resolveAppeal ────────────────────────────────────────────
export function resolveAppeal(appealId, resolvedBy, status, reason) {
  db.prepare(`
    UPDATE ban_appeals
    SET status = ?, resolved_by = ?, resolve_reason = ?, resolved_at = ?
    WHERE id = ?
  `).run(status, resolvedBy, reason, Date.now(), appealId);
}
