import db from '../db.js';
import logger from '../utils/logger.js';
import * as resilience from './resilience.js';

// An older release had warn_tempbans as (guild_id, user_id, unban_at,
// warn_id) with no autoincrement id. CREATE TABLE IF NOT EXISTS won't fix
// an already-existing table, so detect the old-only `unban_at` column and
// rebuild. No historical data has been lost in practice by the time this
// runs (this table only ever holds currently-active tempbans, which
// resolve and get deleted quickly), but the rebuild carries over whatever
// rows do exist rather than assuming there are none.
{
  let cols = [];
  try { cols = db.prepare(`PRAGMA table_info(warn_tempbans)`).all(); } catch { /* no table yet */ }
  if (cols.length && cols.some(c => c.name === 'unban_at') && !cols.some(c => c.name === 'expires_at')) {
    const rows = db.prepare('SELECT * FROM warn_tempbans').all();
    db.exec(`
      CREATE TABLE warn_tempbans_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT    NOT NULL,
        user_id     TEXT    NOT NULL,
        expires_at  INTEGER NOT NULL,
        reason      TEXT,
        banned_at   INTEGER NOT NULL DEFAULT (unixepoch()),
        unbanned    INTEGER NOT NULL DEFAULT 0
      );
    `);
    const insert = db.prepare(`
      INSERT INTO warn_tempbans_new (guild_id, user_id, expires_at, reason, banned_at, unbanned)
      VALUES (?, ?, ?, ?, ?, 0)
    `);
    for (const r of rows) insert.run(r.guild_id, r.user_id, r.unban_at, `migrated from warn ${r.warn_id ?? 'unknown'}`, Math.floor(Date.now() / 1000));
    db.exec('DROP TABLE warn_tempbans');
    db.exec('ALTER TABLE warn_tempbans_new RENAME TO warn_tempbans');
  }
}

// An older release had warn_thresholds as (guild_id, warn_count, punishment,
// duration_ms) instead of the current (guild_id, count, action,
// duration_seconds). Every query below and in dashboard/routes/moderation.js
// assumes the current names, against an unmigrated table they all fail with
// "no such column: count", which silently killed !warn, !tempban, !history,
// and !lookup entirely. 1:1 rename, punishment's values (mute/tempban/ban/
// kick) already satisfy the new action CHECK constraint, so no data
// decisions are needed the way the global-economy migration required.
{
  let cols = [];
  try { cols = db.prepare(`PRAGMA table_info(warn_thresholds)`).all(); } catch { /* no table yet */ }
  if (cols.length && cols.some(c => c.name === 'warn_count') && !cols.some(c => c.name === 'count')) {
    const rows = db.prepare('SELECT * FROM warn_thresholds').all();
    db.exec(`
      CREATE TABLE warn_thresholds_new (
        guild_id         TEXT    NOT NULL,
        count            INTEGER NOT NULL,
        action           TEXT    NOT NULL CHECK (action IN ('mute','kick','tempban','ban')),
        duration_seconds INTEGER,
        PRIMARY KEY (guild_id, count)
      );
    `);
    const insert = db.prepare(`
      INSERT INTO warn_thresholds_new (guild_id, count, action, duration_seconds)
      VALUES (?, ?, ?, ?)
    `);
    for (const r of rows) {
      insert.run(r.guild_id, r.warn_count, r.punishment, r.duration_ms != null ? Math.floor(r.duration_ms / 1000) : null);
    }
    db.exec('DROP TABLE warn_thresholds');
    db.exec('ALTER TABLE warn_thresholds_new RENAME TO warn_thresholds');
    logger.warn(`[WARN] Migrated ${rows.length} warn_thresholds row(s) from the legacy warn_count/punishment/duration_ms shape.`);
  }
}

// Same drift, warn_config: an older release named the two log-channel
// columns warnlog_channel/warnings_channel; every current reader (this
// file's setWarnChannel below, dashboard/routes/core.js's settings save,
// dashboard/routes/moderation.js's warn-post-to-channel logic) uses
// warnlog_channel_id/warn_channel_id. Plain column rename, no value
// reshaping needed, so a real per-guild channel_id already configured
// under the old names isn't silently orphaned.
{
  let cols = [];
  try { cols = db.prepare(`PRAGMA table_info(warn_config)`).all(); } catch { /* no table yet */ }
  const names = cols.map(c => c.name);
  if (names.includes('warnlog_channel') && !names.includes('warnlog_channel_id')) {
    try { db.exec('ALTER TABLE warn_config RENAME COLUMN warnlog_channel TO warnlog_channel_id'); } catch { /* already renamed */ }
  }
  if (names.includes('warnings_channel') && !names.includes('warn_channel_id')) {
    try { db.exec('ALTER TABLE warn_config RENAME COLUMN warnings_channel TO warn_channel_id'); } catch { /* already renamed */ }
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS warnings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    user_id     TEXT    NOT NULL,
    executor_id TEXT    NOT NULL,
    reason      TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at  INTEGER,
    removed_by  TEXT,
    removed_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS warn_thresholds (
    guild_id         TEXT    NOT NULL,
    count            INTEGER NOT NULL,
    action           TEXT    NOT NULL CHECK (action IN ('mute','kick','tempban','ban')),
    duration_seconds INTEGER,
    PRIMARY KEY (guild_id, count)
  );

  CREATE TABLE IF NOT EXISTS warn_config (
    guild_id         TEXT PRIMARY KEY,
    mute_role_id     TEXT,
    warn_channel_id  TEXT,
    warnlog_channel_id TEXT
  );

  CREATE TABLE IF NOT EXISTS warn_tempbans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    user_id     TEXT    NOT NULL,
    expires_at  INTEGER NOT NULL,
    reason      TEXT,
    banned_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    unbanned    INTEGER NOT NULL DEFAULT 0
  );
`);

// Schema migrations, run before ANY db.prepare() call
for (const col of [
  `ALTER TABLE warnings ADD COLUMN executor_id TEXT NOT NULL DEFAULT 'unknown'`,
  `ALTER TABLE warnings ADD COLUMN active INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE warnings ADD COLUMN removed_by TEXT`,
  `ALTER TABLE warnings ADD COLUMN removed_at INTEGER`,
  `ALTER TABLE warnings ADD COLUMN expires_at INTEGER`,
  // warn_config extras used by dashboard
  `ALTER TABLE warn_config ADD COLUMN max_warns INTEGER NOT NULL DEFAULT 3`,
  `ALTER TABLE warn_config ADD COLUMN punishment TEXT NOT NULL DEFAULT 'kick'`,
  `ALTER TABLE warn_config ADD COLUMN tempban_dur_ms INTEGER NOT NULL DEFAULT 86400000`,
  `ALTER TABLE warn_config ADD COLUMN decay_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE warn_config ADD COLUMN decay_ms INTEGER NOT NULL DEFAULT 604800000`,
]) {
  try { db.exec(col); } catch { /* column already exists */ }
}
// The dashboard used to write removed_at in milliseconds (the bot writes
// seconds). Idempotent: only values too large to be seconds are touched.
try { db.exec(`UPDATE warnings SET removed_at = removed_at / 1000 WHERE removed_at > 100000000000`); } catch { /* table shape predates removed_at */ }

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  addWarn: db.prepare(`
    INSERT INTO warnings (guild_id, user_id, executor_id, reason)
    VALUES (?, ?, ?, ?)
  `),
  // expires_at is unix seconds; expired warnings no longer count toward
  // thresholds (they used to count forever).
  getActiveCount: db.prepare(`
    SELECT COUNT(*) AS n FROM warnings
    WHERE guild_id = ? AND user_id = ? AND active = 1
      AND (expires_at IS NULL OR expires_at > unixepoch())
  `),
  listWarnings: db.prepare(`
    SELECT * FROM warnings WHERE guild_id = ? AND user_id = ?
    ORDER BY created_at DESC
  `),
  getWarning: db.prepare(`SELECT * FROM warnings WHERE id = ? AND guild_id = ?`),
  removeWarn: db.prepare(`
    UPDATE warnings SET active = 0, removed_by = ?, removed_at = unixepoch()
    WHERE id = ? AND guild_id = ?
  `),
  getThresholds: db.prepare(`
    SELECT * FROM warn_thresholds WHERE guild_id = ? ORDER BY count ASC
  `),
  getThreshold: db.prepare(`
    SELECT * FROM warn_thresholds WHERE guild_id = ? AND count = ?
  `),
  setThreshold: db.prepare(`
    INSERT OR REPLACE INTO warn_thresholds (guild_id, count, action, duration_seconds)
    VALUES (?, ?, ?, ?)
  `),
  removeThreshold: db.prepare(`
    DELETE FROM warn_thresholds WHERE guild_id = ? AND count = ?
  `),
  getConfig: db.prepare(`SELECT * FROM warn_config WHERE guild_id = ?`),
  ensureConfig: db.prepare(`INSERT OR IGNORE INTO warn_config (guild_id) VALUES (?)`),
  setWarnChannel: db.prepare(`
    UPDATE warn_config SET warn_channel_id = ? WHERE guild_id = ?
  `),
  addTempban: db.prepare(`
    INSERT INTO warn_tempbans (guild_id, user_id, expires_at, reason) VALUES (?, ?, ?, ?)
  `),
  clearPendingTempbans: db.prepare(`
    UPDATE warn_tempbans SET unbanned = 1 WHERE guild_id = ? AND user_id = ? AND unbanned = 0
  `),
  getExpiredTempbans: db.prepare(`
    SELECT * FROM warn_tempbans
    WHERE unbanned = 0 AND expires_at <= unixepoch()
  `),
  markUnbanned: db.prepare(`
    UPDATE warn_tempbans SET unbanned = 1 WHERE id = ?
  `),
};

// ─── addWarning ───────────────────────────────────────────────────────────────
// With warning decay on, the warning gets an expiry (unix seconds) and stops
// counting after it, the same as warnings given on the dashboard. Warnings
// from b!warn used to be stored without one, so they never decayed.
export function addWarning(guildId, userId, executorId, reason) {
  const cfg = getWarnConfig(guildId);
  const expiresAt = cfg?.decay_enabled && cfg.decay_ms > 0 ? Math.floor((Date.now() + cfg.decay_ms) / 1000) : null;
  const result = db.prepare(`INSERT INTO warnings (guild_id, user_id, executor_id, reason, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .run(guildId, userId, executorId, reason ?? null, expiresAt);
  return { id: result.lastInsertRowid, expiresAt };
}

// Warning decay: days until a warning stops counting, or null for never.
export function setWarnDecay(guildId, days) {
  stmts.ensureConfig.run(guildId);
  db.prepare('UPDATE warn_config SET decay_enabled = ?, decay_ms = COALESCE(?, decay_ms) WHERE guild_id = ?')
    .run(days ? 1 : 0, days ? Math.round(days * 86_400_000) : null, guildId);
}

// The staff warning log (moderator, count, case ID), separate from the
// public notice channel set by setWarnChannel.
export function setWarnLogChannel(guildId, channelId) {
  stmts.ensureConfig.run(guildId);
  db.prepare('UPDATE warn_config SET warnlog_channel_id = ? WHERE guild_id = ?').run(channelId, guildId);
}

// Posts a warning to the server's warning channels, as dashboard warnings do:
// the staff log gets the moderator and case details, the notice channel a
// short public notice. Best effort; a missing channel never stops the warn.
export async function postWarnChannels(client, guildId, { userId, modId, reason, count, warnId, expiresAt }) {
  const cfg = getWarnConfig(guildId);
  const max = cfg?.max_warns ?? 3;
  const post = (ch, embed) => client.rest.post(`/channels/${ch}/messages`, { body: { embeds: [embed], allowed_mentions: { parse: [] } } }).catch(() => {});
  if (cfg?.warnlog_channel_id) {
    await post(cfg.warnlog_channel_id, {
      title: '🟡 Warning Issued', color: 0xFEE75C, timestamp: new Date().toISOString(),
      fields: [
        { name: '🎯 User', value: `<@${userId}> \`${userId}\``, inline: true },
        { name: '👮 Moderator', value: `<@${modId}>`, inline: true },
        { name: '📋 Reason', value: reason, inline: false },
        { name: '📊 Count', value: `${count} / ${max}`, inline: true },
        { name: '🆔 Case ID', value: `\`${warnId}\``, inline: true },
        ...(expiresAt ? [{ name: '⏳ Expires', value: `<t:${expiresAt}:R>`, inline: true }] : []),
      ],
    });
  }
  if (cfg?.warn_channel_id) {
    await post(cfg.warn_channel_id, {
      title: '⚠️ Warning', color: 0xFEE75C, timestamp: new Date().toISOString(),
      fields: [
        { name: '🎯 User', value: `<@${userId}>`, inline: true },
        { name: '📋 Reason', value: reason, inline: false },
        { name: '📊 Total', value: `${count} / ${max}`, inline: true },
        { name: '🆔 Case ID', value: `\`${warnId}\``, inline: true },
      ],
    });
  }
}

// ─── getActiveWarnCount ───────────────────────────────────────────────────────
export function getActiveWarnCount(guildId, userId) {
  return stmts.getActiveCount.get(guildId, userId)?.n ?? 0;
}

// ─── getWarnings ──────────────────────────────────────────────────────────────
export function getWarnings(guildId, userId) {
  return stmts.listWarnings.all(guildId, userId);
}

// ─── removeWarning ────────────────────────────────────────────────────────────
export function removeWarning(guildId, warnId, removedBy) {
  const warn = stmts.getWarning.get(warnId, guildId);
  if (!warn) return null;
  stmts.removeWarn.run(removedBy, warnId, guildId);
  return warn;
}

// ─── getThresholdForCount ─────────────────────────────────────────────────────
export function getThresholdForCount(guildId, warnCount) {
  return stmts.getThreshold.get(guildId, warnCount) ?? null;
}

// ─── getThresholds ────────────────────────────────────────────────────────────
export function getThresholds(guildId) {
  return stmts.getThresholds.all(guildId);
}

// ─── setThreshold ─────────────────────────────────────────────────────────────
export function setThreshold(guildId, count, action, durationSeconds = null) {
  stmts.setThreshold.run(guildId, count, action, durationSeconds);
}

// ─── removeThreshold ──────────────────────────────────────────────────────────
export function removeThreshold(guildId, count) {
  stmts.removeThreshold.run(guildId, count);
}

// ─── getWarnConfig ────────────────────────────────────────────────────────────
export function getWarnConfig(guildId) {
  stmts.ensureConfig.run(guildId);
  return stmts.getConfig.get(guildId);
}

// ─── setWarnChannel ───────────────────────────────────────────────────────────
export function setWarnChannel(guildId, channelId) {
  stmts.ensureConfig.run(guildId);
  stmts.setWarnChannel.run(channelId, guildId);
}

// ─── addTempban ───────────────────────────────────────────────────────────────
export function addTempban(guildId, userId, durationSeconds, reason) {
  const expiresAt = Math.floor(Date.now() / 1000) + durationSeconds;
  // A new tempban replaces any pending one; otherwise the older, shorter
  // expiry would lift the newer ban early.
  stmts.clearPendingTempbans.run(guildId, userId);
  stmts.addTempban.run(guildId, userId, expiresAt, reason ?? null);
}

// Call on unban and on permanent ban. A pending tempban row left behind would
// otherwise auto-unban the user when it expires, even after a later
// permanent ban.
export function clearPendingTempbans(guildId, userId) {
  stmts.clearPendingTempbans.run(guildId, userId);
}

// ─── startUnbanChecker ────────────────────────────────────────────────────────
let _unbanTimer = null;

export function startUnbanChecker(client) {
  if (_unbanTimer) return;

  const POLL_MS = 60_000; // check every minute

  const check = async () => {
    const expired = stmts.getExpiredTempbans.all();
    for (const row of expired) {
      try {
        await client.rest.delete(`/guilds/${row.guild_id}/bans/${row.user_id}`);
        stmts.markUnbanned.run(row.id);
        logger.info(`[UNBAN] Auto-unbanned ${row.user_id} in ${row.guild_id}`);
      } catch (err) {
        // 404 = already unbanned, mark done anyway
        if (err.statusCode === 404 || err.status === 404) {
          stmts.markUnbanned.run(row.id);
        } else {
          logger.warn(`[UNBAN] Failed to unban ${row.user_id} in ${row.guild_id}:`, err.message);
        }
      }
    }
  };

  resilience.runLight('warnSystem.unbanCheck', check); // immediate first check
  _unbanTimer = setInterval(() => resilience.runLight('warnSystem.unbanCheck', check), POLL_MS);
  _unbanTimer.unref?.();
  logger.info('[UNBAN] Checker started.');
}

// ─── getActiveWarnings ────────────────────────────────────────────────────────
// Returns all active (non-expired, non-removed) warnings for a user.
export function getActiveWarnings(guildId, userId) {
  return db.prepare(`
    SELECT * FROM warnings
    WHERE guild_id = ? AND user_id = ? AND active = 1
      AND (expires_at IS NULL OR expires_at > unixepoch())
    ORDER BY created_at DESC
  `).all(guildId, userId);
}

// ─── getAllWarnings ───────────────────────────────────────────────────────────
// Returns all warnings ever issued to a user (including expired/removed).
export function getAllWarnings(guildId, userId) {
  return db.prepare(`
    SELECT * FROM warnings
    WHERE guild_id = ? AND user_id = ?
    ORDER BY created_at DESC
  `).all(guildId, userId);
}
