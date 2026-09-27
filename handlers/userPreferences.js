// ── Per-user dashboard/bot preferences ──────────────────────────────────
// Global (not per-guild), the opposite scope from almost everything else
// in this codebase: a user's own account-level choices, applying the same
// way in every guild. Lives in handlers/ (not dashboard/lib/) because the
// bot process itself needs to read it live, not just the dashboard, e.g.
// the level-up ping opt-out is consulted at announce time in this same
// file. The dashboard's Account page reads/writes it through
// dashboard/routes/userPreferences.js, same db.js connection, same
// pattern config/dashAccess.js already established for bot+dashboard
// shared logic.
import db from '../db.js';

// Created eagerly at import time, not lazily, matching this codebase's own
// convention (see the top of this file's siblings, e.g. xpSystem.js's own
// CREATE TABLE runs at module load). xpSystem.js's leaderboard/rank
// queries JOIN against this table via a raw NOT IN subquery in a
// module-level db.prepare() call, so the table must already exist the
// moment that file is imported, not on first lazy access.
export function ensureUserPreferencesTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id              TEXT PRIMARY KEY,
      levelup_ping_optout  INTEGER NOT NULL DEFAULT 0,
      stats_private        INTEGER NOT NULL DEFAULT 0,
      updated_at           INTEGER
    );
  `);
}
ensureUserPreferencesTable();

const DEFAULTS = { levelup_ping_optout: 0, stats_private: 0 };

export function getUserPreferences(userId) {
  const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId);
  return row ? { ...DEFAULTS, ...row } : { user_id: userId, ...DEFAULTS };
}

export function setUserPreferences(userId, patch) {
  const current = getUserPreferences(userId);
  const levelup_ping_optout = patch.levelup_ping_optout !== undefined ? (patch.levelup_ping_optout ? 1 : 0) : (current.levelup_ping_optout ? 1 : 0);
  const stats_private       = patch.stats_private !== undefined       ? (patch.stats_private ? 1 : 0)       : (current.stats_private ? 1 : 0);
  db.prepare(`
    INSERT INTO user_preferences (user_id, levelup_ping_optout, stats_private, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET levelup_ping_optout = excluded.levelup_ping_optout, stats_private = excluded.stats_private, updated_at = excluded.updated_at
  `).run(userId, levelup_ping_optout, stats_private, Date.now());
}

// Convenience reads for call sites that only care about one flag.
export function wantsLevelupPing(userId) { return !getUserPreferences(userId).levelup_ping_optout; }
export function isStatsPrivate(userId)   { return !!getUserPreferences(userId).stats_private; }

// NOT used by the account-deletion flow (dashboard/routes/myData.js):
// that route deletes this table directly via its own botDb connection
// instead of calling this, since calling it from inside myData.js's
// delete transaction crossed two separate better-sqlite3 connections to
// the same file mid-write and hit "database is locked" (confirmed live
// while building that feature). Kept here as a general-purpose helper
// for any bot-side caller (e.g. a future !forgetme command) that isn't
// already inside someone else's transaction.
export function deleteUserPreferences(userId) {
  ensureUserPreferencesTable();
  db.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(userId);
}
