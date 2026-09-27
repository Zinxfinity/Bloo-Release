import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Resolve DB path from env, NEVER hardcode ───────────────────────────────
// Relative DB_PATH resolves from the repo root (same as dashboard/db.js), so
// both processes land on the same file whatever directory they start in.
const DB_PATH = process.env.DB_PATH
  ? (isAbsolute(process.env.DB_PATH) ? process.env.DB_PATH : join(__dirname, process.env.DB_PATH))
  : join(__dirname, 'data', 'bot.db');

// Ensure the data directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

// ─── Open connection ─────────────────────────────────────────────────────────
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

console.log(`[DB] Connected → ${DB_PATH}`);

// ─── Global tables ────────────────────────────────────────────────────────────
// Only truly global tables live here.
// Every handler owns and creates its own tables.

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id          TEXT    PRIMARY KEY,
    prefix            TEXT    NOT NULL DEFAULT 'b!',
    modlog_channel_id TEXT,
    updated_at        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS modlog_cases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    case_number INTEGER NOT NULL,
    action      TEXT    NOT NULL,
    target_id   TEXT    NOT NULL,
    executor_id TEXT    NOT NULL,
    reason      TEXT,
    extra       TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (guild_id, case_number)
  );

  CREATE TABLE IF NOT EXISTS reaction_roles (
    guild_id   TEXT NOT NULL,
    message_id TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    role_id    TEXT NOT NULL,
    PRIMARY KEY (guild_id, message_id, emoji)
  );

  -- menu_id included here to match dashboard/routes/reactionroles.js's own
  -- declaration of this same table, previously this file's version omitted
  -- it entirely, two different CREATE TABLE IF NOT EXISTS for the same
  -- table disagreeing on its shape, whichever module ran first on a fresh
  -- install decided what actually got created. Without menu_id, a block/
  -- require rule set on one role menu also silently applied to any other
  -- menu that happened to offer the same role, since checkRoleAccess could
  -- only filter by (guild_id, entry_role_id).
  CREATE TABLE IF NOT EXISTS role_menu_entry_blocks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id         TEXT    NOT NULL,
    menu_id          INTEGER NOT NULL,
    entry_role_id    TEXT    NOT NULL,
    blocking_role_id TEXT    NOT NULL,
    type             TEXT    NOT NULL CHECK (type IN ('block', 'require'))
  );

  CREATE TABLE IF NOT EXISTS message_log_ignored (
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS mute_role_config (
    guild_id TEXT PRIMARY KEY,
    role_id  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_lock_snapshots (
    guild_id    TEXT    NOT NULL,
    channel_id  TEXT    NOT NULL,
    target_id   TEXT    NOT NULL,
    target_type INTEGER NOT NULL DEFAULT 0,
    allow       TEXT    NOT NULL DEFAULT '0',
    deny        TEXT    NOT NULL DEFAULT '0',
    snapshot    TEXT    NOT NULL DEFAULT '{}',
    locked_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (guild_id, channel_id, target_id)
  );

  CREATE TABLE IF NOT EXISTS automod_config (
    guild_id              TEXT PRIMARY KEY,
    enabled               INTEGER NOT NULL DEFAULT 0,
    mention_threshold     INTEGER NOT NULL DEFAULT 5,
    mention_action        TEXT    NOT NULL DEFAULT 'warn',
    spam_threshold        INTEGER NOT NULL DEFAULT 5,
    spam_window_s         INTEGER NOT NULL DEFAULT 5,
    spam_action           TEXT    NOT NULL DEFAULT 'mute',
    emoji_threshold       INTEGER NOT NULL DEFAULT 10,
    emoji_action          TEXT    NOT NULL DEFAULT 'warn',
    caps_threshold        INTEGER NOT NULL DEFAULT 70,
    caps_min_length       INTEGER NOT NULL DEFAULT 10,
    caps_action           TEXT    NOT NULL DEFAULT 'warn',
    invite_action         TEXT    NOT NULL DEFAULT 'delete',
    updated_at            INTEGER NOT NULL DEFAULT 0
  );
`);

// ─── Global schema migrations ─────────────────────────────────────────────────
// These cover every column that was added to shared tables after initial release.
// They MUST run here, before handlers import db and call db.prepare().
// SQLite ALTER TABLE does not support IF NOT EXISTS; silently swallow duplicates.
for (const col of [
  // modlog_cases, case_number and extra added in Bloo2 rebuild
  `ALTER TABLE modlog_cases ADD COLUMN case_number INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE modlog_cases ADD COLUMN extra TEXT`,
  // channel_lock_snapshots, snapshot column renamed from override_ids in Bloo2
  `ALTER TABLE channel_lock_snapshots ADD COLUMN snapshot TEXT NOT NULL DEFAULT '{}'`,
  // channel_lock_snapshots, target_id/target_type/allow/deny added so this
  // matches the real live shape (a per-overwrite-target row, not one blob
  // per channel), lockChannel() always supplies real values for these on
  // a fresh insert, DEFAULT 0/'0' here only matters for a legacy row an
  // old install might already have on disk with the narrower shape.
  `ALTER TABLE channel_lock_snapshots ADD COLUMN target_id TEXT NOT NULL DEFAULT '0'`,
  `ALTER TABLE channel_lock_snapshots ADD COLUMN target_type INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE channel_lock_snapshots ADD COLUMN allow TEXT NOT NULL DEFAULT '0'`,
  `ALTER TABLE channel_lock_snapshots ADD COLUMN deny TEXT NOT NULL DEFAULT '0'`,
  // role_menu_entry_blocks, menu_id added so a block/require rule can't
  // leak across two different menus that happen to share an entry role
  // (see checkRoleAccess in handlers/reactionRoles.js). DEFAULT 0 only
  // matters for a legacy row from before this column existed, it won't
  // match any real menu.id so that row simply stops applying rather than
  // guessing which menu it belonged to.
  `ALTER TABLE role_menu_entry_blocks ADD COLUMN menu_id INTEGER NOT NULL DEFAULT 0`,
  // automod_config, per-feature columns added progressively
  `ALTER TABLE automod_config ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE automod_config ADD COLUMN invite_action TEXT NOT NULL DEFAULT 'delete'`,
  `ALTER TABLE automod_config ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
  // Per-category action/threshold split: an older release had one shared
  // `action` column plus per-category *_enabled toggles that
  // handlers/automod.js no longer reads at all (only the top-level
  // `enabled` gate matters now), and spam_window_ms/caps_percent instead of
  // spam_window_s/caps_threshold. Adds the new columns; the data carry-over
  // below copies old values in and then drops the old columns.
  `ALTER TABLE automod_config ADD COLUMN mention_action TEXT NOT NULL DEFAULT 'warn'`,
  `ALTER TABLE automod_config ADD COLUMN spam_action TEXT NOT NULL DEFAULT 'mute'`,
  `ALTER TABLE automod_config ADD COLUMN caps_action TEXT NOT NULL DEFAULT 'warn'`,
  `ALTER TABLE automod_config ADD COLUMN spam_window_s INTEGER NOT NULL DEFAULT 5`,
  `ALTER TABLE automod_config ADD COLUMN emoji_threshold INTEGER NOT NULL DEFAULT 10`,
  `ALTER TABLE automod_config ADD COLUMN emoji_action TEXT NOT NULL DEFAULT 'warn'`,
  `ALTER TABLE automod_config ADD COLUMN caps_threshold INTEGER NOT NULL DEFAULT 70`,
]) {
  try { db.exec(col); } catch { /* column already exists, safe to ignore */ }
}

// One block/require rule per (menu, entry role, blocking role, type):
// the dashboard adds rules with INSERT OR IGNORE, which only dedupes if a
// unique constraint exists, and this table never had one.
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rme_blocks_unique ON role_menu_entry_blocks (menu_id, entry_role_id, blocking_role_id, type)`);
} catch { /* pre-existing duplicate rows, leave as is */ }

// One-time: the dashboard wrote guild_settings.updated_at with Date.now()
// (milliseconds) while the bot writes unix seconds. Normalise the ms rows so
// the column means one thing. Guarded by a marker row.
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (key TEXT PRIMARY KEY, done_at INTEGER NOT NULL)`);
if (!db.prepare(`SELECT 1 FROM schema_migrations WHERE key = 'guild_settings_updated_at_seconds'`).get()) {
  db.transaction(() => {
    db.prepare(`UPDATE guild_settings SET updated_at = updated_at / 1000 WHERE updated_at > 100000000000`).run();
    db.prepare(`INSERT INTO schema_migrations (key, done_at) VALUES ('guild_settings_updated_at_seconds', unixepoch())`).run();
  })();
}

// One-time data carry-over for the automod_config split above: a guild that
// already configured the old shared `action`/spam_window_ms/caps_percent
// columns should keep the same effective behavior under the new per-category
// columns, not silently reset to defaults. Old columns are dropped right
// after copying so this block is a no-op on every boot after the first,
// it must not re-run once an admin has changed a per-category action
// through the real config command, that would silently stomp their change
// back to the old shared value forever.
try {
  const oldCols = db.prepare(`PRAGMA table_info(automod_config)`).all().map(c => c.name);
  if (oldCols.includes('action')) {
    db.exec(`
      UPDATE automod_config SET
        mention_action = action,
        spam_action    = action,
        emoji_action   = action,
        caps_action    = action
      WHERE action IS NOT NULL
    `);
    db.exec(`ALTER TABLE automod_config DROP COLUMN action`);
  }
  if (oldCols.includes('spam_window_ms')) {
    db.exec(`UPDATE automod_config SET spam_window_s = spam_window_ms / 1000 WHERE spam_window_ms IS NOT NULL`);
    db.exec(`ALTER TABLE automod_config DROP COLUMN spam_window_ms`);
  }
  if (oldCols.includes('caps_percent')) {
    db.exec(`UPDATE automod_config SET caps_threshold = caps_percent WHERE caps_percent IS NOT NULL`);
    db.exec(`ALTER TABLE automod_config DROP COLUMN caps_percent`);
  }
} catch { /* automod_config may not exist yet on a fresh install, or SQLite too old for DROP COLUMN */ }

export default db;
