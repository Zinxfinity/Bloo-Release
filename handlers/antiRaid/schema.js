// ─── Anti-raid schema ───────────────────────────────────────────────────────────

import db from '../../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS antiraid_config (
    guild_id          TEXT PRIMARY KEY,
    enabled           INTEGER NOT NULL DEFAULT 0,
    mode              TEXT    NOT NULL DEFAULT 'dm' CHECK (mode IN ('dm','web')),
    verified_role_id  TEXT,
    log_channel_id    TEXT,
    captcha_enabled   INTEGER NOT NULL DEFAULT 0,
    min_account_age   INTEGER NOT NULL DEFAULT 7,
    action            TEXT    NOT NULL DEFAULT 'kick',
    role_id           TEXT,
    verify_channel_id TEXT,
    captcha_mode      TEXT,
    verify_panel_msg_id TEXT,
    updated_at        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS verify_tokens (
    token      TEXT    PRIMARY KEY,
    guild_id   TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS dm_captcha_sessions (
    user_id    TEXT    NOT NULL,
    guild_id   TEXT    NOT NULL,
    code       TEXT    NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, guild_id)
  );
`);

// Schema migrations, safe on existing installs
for (const col of [
  `ALTER TABLE antiraid_config ADD COLUMN captcha_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE antiraid_config ADD COLUMN min_account_age INTEGER NOT NULL DEFAULT 7`,
  `ALTER TABLE antiraid_config ADD COLUMN action TEXT NOT NULL DEFAULT 'kick'`,
  `ALTER TABLE antiraid_config ADD COLUMN role_id TEXT`,
  `ALTER TABLE antiraid_config ADD COLUMN verify_channel_id TEXT`,
  `ALTER TABLE antiraid_config ADD COLUMN captcha_mode TEXT`,
  `ALTER TABLE antiraid_config ADD COLUMN verify_panel_msg_id TEXT`,
  `ALTER TABLE antiraid_config ADD COLUMN verify_mode TEXT NOT NULL DEFAULT 'web'`,
  // The live table predates this column (it has the older `alert_channel`
  // instead), and CREATE TABLE IF NOT EXISTS above is a no-op against an
  // already-existing table, so dashboard/routes/antiraid.js's PATCH
  // handler was throwing "no such column: log_channel_id" on every save
  // of the Raid Mode card, silently (see that file's own note).
  `ALTER TABLE antiraid_config ADD COLUMN log_channel_id TEXT`,
]) {
  try { db.exec(col); } catch { /* column already exists */ }
}

// One-time: Raid Mode (enabled / min_account_age / action) was saved but never
// enforced, and `!antiraid on` switched it on as a side effect of enabling
// captcha while the dashboard labelled it "not enforced yet". Now that joins
// are actually checked, every existing server starts with it off and has to
// opt in explicitly, so nobody gets surprise auto-kicks. Guarded by a marker
// row so it only ever runs once.
db.exec(`CREATE TABLE IF NOT EXISTS antiraid_migration_state (key TEXT PRIMARY KEY, done_at INTEGER NOT NULL)`);
if (!db.prepare(`SELECT 1 FROM antiraid_migration_state WHERE key = 'raid_mode_opt_in'`).get()) {
  db.transaction(() => {
    db.prepare(`UPDATE antiraid_config SET enabled = 0 WHERE enabled != 0`).run();
    db.prepare(`INSERT INTO antiraid_migration_state (key, done_at) VALUES ('raid_mode_opt_in', unixepoch())`).run();
  })();
}

export const stmts = {
  getConfig:    db.prepare(`SELECT * FROM antiraid_config WHERE guild_id = ?`),
  ensureConfig: db.prepare(`INSERT OR IGNORE INTO antiraid_config (guild_id) VALUES (?)`),
  setField:     (field) => db.prepare(
    `UPDATE antiraid_config SET ${field} = ?, updated_at = unixepoch() WHERE guild_id = ?`
  ),
  // created_at is passed explicitly rather than relying on the column's
  // DEFAULT (unixepoch()) declared above: the live table predates that
  // default (CREATE TABLE IF NOT EXISTS is a no-op against it), so
  // created_at has notnull=1 with no default on disk, and every insert
  // was throwing "NOT NULL constraint failed: verify_tokens.created_at"
  // before ever reaching a DM/channel send. This is the send path for
  // 'web' mode, the default verify_mode, so this broke web-mode
  // verification outright rather than just failing DMs within it.
  insertToken: db.prepare(`
    INSERT OR REPLACE INTO verify_tokens (token, guild_id, user_id, created_at, expires_at)
    VALUES (?, ?, ?, unixepoch(), unixepoch() + 600)
  `),
  getToken: db.prepare(`
    SELECT * FROM verify_tokens
    WHERE token = ? AND used = 0 AND expires_at > unixepoch()
  `),
  markTokenUsed: db.prepare(`UPDATE verify_tokens SET used = 1 WHERE token = ?`),
  getSession:    db.prepare(`SELECT * FROM dm_captcha_sessions WHERE user_id = ? AND guild_id = ?`),
  upsertSession: db.prepare(`
    INSERT OR REPLACE INTO dm_captcha_sessions (user_id, guild_id, code, attempts, expires_at)
    VALUES (?, ?, ?, 0, unixepoch() + 600)
  `),
  incrementAttempts: db.prepare(`
    UPDATE dm_captcha_sessions SET attempts = attempts + 1
    WHERE user_id = ? AND guild_id = ?
  `),
  deleteSession: db.prepare(`
    DELETE FROM dm_captcha_sessions WHERE user_id = ? AND guild_id = ?
  `),
  listPanels: db.prepare(`
    SELECT guild_id, verify_channel_id, verify_panel_msg_id FROM antiraid_config
    WHERE captcha_enabled = 1 AND verify_channel_id IS NOT NULL AND verify_panel_msg_id IS NOT NULL
  `),
};
