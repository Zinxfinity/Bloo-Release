import db from '../db.js';

// ─── Shadow bans ────────────────────────────────────────────────────────────────
// A shadow-banned user's commands are silently ignored, not denied, see
// commandHandler.js's check right after prefix/command parsing: their trigger
// message just gets deleted with no reply, exactly what already happens for
// any normal command that runs successfully, so there's nothing to tip them
// off that anything's different from their side.
db.exec(`
  CREATE TABLE IF NOT EXISTS shadow_bans (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    reason   TEXT,
    added_by TEXT,
    added_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (guild_id, user_id)
  );
`);

const stmts = {
  isBanned: db.prepare(`SELECT 1 FROM shadow_bans WHERE guild_id = ? AND user_id = ?`),
  add: db.prepare(`
    INSERT INTO shadow_bans (guild_id, user_id, reason, added_by, added_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      reason   = excluded.reason,
      added_by = excluded.added_by,
      added_at = excluded.added_at
  `),
  remove: db.prepare(`DELETE FROM shadow_bans WHERE guild_id = ? AND user_id = ?`),
  list:   db.prepare(`SELECT * FROM shadow_bans WHERE guild_id = ? ORDER BY added_at DESC`),
  get:    db.prepare(`SELECT * FROM shadow_bans WHERE guild_id = ? AND user_id = ?`),
};

export function isShadowBanned(guildId, userId) {
  return !!stmts.isBanned.get(guildId, userId);
}

export function getShadowBan(guildId, userId) {
  return stmts.get.get(guildId, userId) ?? null;
}

export function addShadowBan(guildId, userId, reason, addedBy) {
  stmts.add.run(guildId, userId, reason ?? null, addedBy ?? null);
}

// Returns whether a row actually existed to remove, lets the command
// distinguish "removed" from "wasn't shadow-banned to begin with".
export function removeShadowBan(guildId, userId) {
  return stmts.remove.run(guildId, userId).changes > 0;
}

export function listShadowBans(guildId) {
  return stmts.list.all(guildId);
}
