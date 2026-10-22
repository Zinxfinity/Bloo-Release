import db from '../db.js';
import logger from '../utils/logger.js';
import * as resilience from './resilience.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
// This table set is also read (and, for analytics_config, written) by
// dashboard/server.js in its own process against the same DB file. Both
// sides must agree on column names exactly, CREATE TABLE IF NOT EXISTS only
// takes effect for whichever process starts first, so an older install with
// a mismatched shape has to be detected and moved out of the way rather than
// silently left in place for the other process to fail against.
function migrateLegacyShape(tableName, expectedColumn) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name);
    if (cols.length && !cols.includes(expectedColumn)) {
      db.exec(`ALTER TABLE ${tableName} RENAME TO ${tableName}_legacy`);
    }
  } catch { /* table doesn't exist yet, CREATE TABLE below will handle it */ }
}

migrateLegacyShape('analytics_joins', 'ts');
migrateLegacyShape('analytics_leaves', 'ts');
migrateLegacyShape('analytics_activity', 'date');
migrateLegacyShape('analytics_snapshots', 'period_start');

db.exec(`
  CREATE TABLE IF NOT EXISTS analytics_config (
    guild_id     TEXT    PRIMARY KEY,
    enabled      INTEGER NOT NULL DEFAULT 0,
    enabled_by   TEXT,
    enabled_at   INTEGER,
    member_count INTEGER
  );

  CREATE TABLE IF NOT EXISTS analytics_joins (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT    NOT NULL,
    user_id  TEXT    NOT NULL,
    ts       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analytics_leaves (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT    NOT NULL,
    user_id  TEXT    NOT NULL,
    ts       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analytics_activity (
    guild_id  TEXT    NOT NULL,
    user_id   TEXT    NOT NULL,
    date      TEXT    NOT NULL,
    msg_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, date)
  );

  CREATE TABLE IF NOT EXISTS analytics_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT    NOT NULL,
    period_start  INTEGER NOT NULL,
    period_end    INTEGER NOT NULL,
    joins         INTEGER NOT NULL DEFAULT 0,
    leaves        INTEGER NOT NULL DEFAULT 0,
    net_change    INTEGER NOT NULL DEFAULT 0,
    active_users  INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    member_count  INTEGER
  );
`);

try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analytics_joins ON analytics_joins (guild_id, ts)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analytics_leaves ON analytics_leaves (guild_id, ts)`);
} catch { /* already exists */ }
// analytics_snapshots had three identical (guild_id, period_start) indexes,
// one of them unique. Keep the unique one (the live table already enforces
// it) and drop the redundant pair, each costing a write per snapshot row.
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_as_guild_period_uniq ON analytics_snapshots (guild_id, period_start)`);
  db.exec(`DROP INDEX IF EXISTS idx_analytics_snapshots`);
  db.exec(`DROP INDEX IF EXISTS idx_as_guild_period`);
} catch { /* pre-existing duplicate rows, leave indexes as they are */ }

// ─── Retention ────────────────────────────────────────────────────────────────
// Each server keeps analytics for retention_days (1-90, default 90, set on
// the dashboard); older rows are wiped daily. A server whose newest record
// is more than STALE_DAYS old isn't using analytics any more (the bot left,
// or tracking was switched off) and has all of its analytics purged.
export const MAX_RETENTION_DAYS = 90;
export const STALE_DAYS = 30;
try { db.exec(`ALTER TABLE analytics_config ADD COLUMN retention_days INTEGER NOT NULL DEFAULT ${MAX_RETENTION_DAYS}`); } catch { /* already exists */ }

const DAY_MS = 86_400_000;

export function clampRetentionDays(days) {
  const n = parseInt(days, 10);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, MAX_RETENTION_DAYS);
}

const stmts = {
  isEnabled:      db.prepare(`SELECT enabled FROM analytics_config WHERE guild_id = ?`),
  getRetention:   db.prepare(`SELECT retention_days FROM analytics_config WHERE guild_id = ?`),
  setRetention:   db.prepare(`
    INSERT INTO analytics_config (guild_id, retention_days) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET retention_days = excluded.retention_days
  `),
  analyticsGuilds: db.prepare(`
    SELECT guild_id FROM analytics_snapshots GROUP BY guild_id
    UNION SELECT guild_id FROM analytics_joins GROUP BY guild_id
    UNION SELECT guild_id FROM analytics_leaves GROUP BY guild_id
    UNION SELECT guild_id FROM analytics_activity GROUP BY guild_id
  `),
  latestSnapshot: db.prepare(`SELECT MAX(period_end) AS t FROM analytics_snapshots WHERE guild_id = ?`),
  latestJoin:     db.prepare(`SELECT MAX(ts) AS t FROM analytics_joins WHERE guild_id = ?`),
  latestLeave:    db.prepare(`SELECT MAX(ts) AS t FROM analytics_leaves WHERE guild_id = ?`),
  latestActivity: db.prepare(`SELECT MAX(date) AS d FROM analytics_activity WHERE guild_id = ?`),
  pruneSnapshots: db.prepare(`DELETE FROM analytics_snapshots WHERE guild_id = ? AND period_start < ?`),
  pruneJoins:     db.prepare(`DELETE FROM analytics_joins     WHERE guild_id = ? AND ts < ?`),
  pruneLeaves:    db.prepare(`DELETE FROM analytics_leaves    WHERE guild_id = ? AND ts < ?`),
  pruneActivity:  db.prepare(`DELETE FROM analytics_activity  WHERE guild_id = ? AND date < ?`),
  insertJoin:     db.prepare(`INSERT INTO analytics_joins (guild_id, user_id, ts) VALUES (?, ?, ?)`),
  insertLeave:    db.prepare(`INSERT INTO analytics_leaves (guild_id, user_id, ts) VALUES (?, ?, ?)`),
  upsertActivity: db.prepare(`
    INSERT INTO analytics_activity (guild_id, user_id, date, msg_count) VALUES (?, ?, ?, 1)
    ON CONFLICT(guild_id, user_id, date) DO UPDATE SET msg_count = msg_count + 1
  `),
  insertSnapshot: db.prepare(`
    INSERT INTO analytics_snapshots
      (guild_id, period_start, period_end, joins, leaves, net_change, active_users, message_count, member_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  joinsRange: db.prepare(`
    SELECT COUNT(*) AS n FROM analytics_joins
    WHERE guild_id = ? AND ts >= ? AND ts <= ?
  `),
  leavesRange: db.prepare(`
    SELECT COUNT(*) AS n FROM analytics_leaves
    WHERE guild_id = ? AND ts >= ? AND ts <= ?
  `),
  activityForDate: db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS active_users, COALESCE(SUM(msg_count), 0) AS message_count
    FROM analytics_activity WHERE guild_id = ? AND date = ?
  `),
  lastSnapshot: db.prepare(`
    SELECT period_end FROM analytics_snapshots
    WHERE guild_id = ? ORDER BY period_end DESC LIMIT 1
  `),
  snapshots: db.prepare(`
    SELECT period_start, period_end, joins, leaves, net_change, active_users, message_count, member_count
    FROM analytics_snapshots
    WHERE guild_id = ? ORDER BY period_start DESC LIMIT 30
  `),
};

// Analytics is opt-in (Server Owner, dashboard). These used to record for
// every server regardless, including ones that never switched it on.
export function isAnalyticsEnabled(guildId) {
  try { return !!stmts.isEnabled.get(guildId)?.enabled; } catch { return false; }
}

// Opt in or out (b!analytics, and the dashboard's own route does the same).
// The first time it's switched on, the member count is seeded from Fluxer so
// the joins/leaves graph starts from the real size of the server.
export async function setAnalyticsEnabled(client, guildId, enabled, by) {
  const was = isAnalyticsEnabled(guildId);
  db.prepare(`INSERT INTO analytics_config (guild_id, enabled, enabled_by, enabled_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(guild_id) DO UPDATE SET enabled = excluded.enabled, enabled_by = excluded.enabled_by, enabled_at = excluded.enabled_at`)
    .run(guildId, enabled ? 1 : 0, by ?? null, Date.now());
  if (enabled && !was) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS guild_member_counts (guild_id TEXT PRIMARY KEY, member_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`);
      if (!db.prepare('SELECT 1 FROM guild_member_counts WHERE guild_id = ?').get(guildId)) {
        const g = await client.rest.get(`/guilds/${guildId}?with_counts=true`).catch(() => null);
        const count = g?.approximate_member_count ?? g?.member_count ?? null;
        if (count != null) db.prepare(`INSERT OR REPLACE INTO guild_member_counts (guild_id, member_count, updated_at) VALUES (?, ?, ?)`).run(guildId, count, Date.now());
      }
    } catch { /* graph just starts from the next join */ }
  }
}

export function getRetentionDays(guildId) {
  return clampRetentionDays(stmts.getRetention.get(guildId)?.retention_days) ?? MAX_RETENTION_DAYS;
}

export function setRetentionDays(guildId, days) {
  const clamped = clampRetentionDays(days);
  if (clamped == null) throw new Error('Retention must be a whole number of days from 1 to 90');
  stmts.setRetention.run(guildId, clamped);
  return clamped;
}

// Wipes rows older than each server's retention, and everything for servers
// with no analytics record in STALE_DAYS. Runs daily from startAnalyticsJob.
export function pruneAnalytics(now = Date.now()) {
  const staleCutoff = now - STALE_DAYS * DAY_MS;
  const result = { guilds: 0, staleGuilds: 0, rows: 0 };
  for (const { guild_id: guildId } of stmts.analyticsGuilds.all()) {
    result.guilds++;
    const latestMs = Math.max(
      stmts.latestSnapshot.get(guildId)?.t ?? 0,
      stmts.latestJoin.get(guildId)?.t ?? 0,
      stmts.latestLeave.get(guildId)?.t ?? 0,
      Date.parse(stmts.latestActivity.get(guildId)?.d ?? '') || 0,
    );
    const stale  = latestMs < staleCutoff;
    const cutoff = stale ? Number.MAX_SAFE_INTEGER : now - getRetentionDays(guildId) * DAY_MS;
    const cutoffDate = stale ? '9999-12-31' : new Date(cutoff).toISOString().slice(0, 10);
    db.transaction(() => {
      result.rows += stmts.pruneSnapshots.run(guildId, cutoff).changes;
      result.rows += stmts.pruneJoins.run(guildId, cutoff).changes;
      result.rows += stmts.pruneLeaves.run(guildId, cutoff).changes;
      result.rows += stmts.pruneActivity.run(guildId, cutoffDate).changes;
    })();
    if (stale) result.staleGuilds++;
  }
  return result;
}

export function recordJoin(guildId, userId) {
  if (!isAnalyticsEnabled(guildId)) return;
  try { stmts.insertJoin.run(guildId, userId, Date.now()); } catch { /* non-fatal */ }
}

export function recordLeave(guildId, userId) {
  if (!isAnalyticsEnabled(guildId)) return;
  try { stmts.insertLeave.run(guildId, userId, Date.now()); } catch { /* non-fatal */ }
}

export function recordActivity(guildId, userId) {
  if (!isAnalyticsEnabled(guildId)) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    stmts.upsertActivity.run(guildId, userId, today);
  } catch { /* non-fatal */ }
}

export function getJoinCount(guildId, fromTs, toTs) {
  return stmts.joinsRange.get(guildId, fromTs, toTs)?.n ?? 0;
}

export function getLeaveCount(guildId, fromTs, toTs) {
  return stmts.leavesRange.get(guildId, fromTs, toTs)?.n ?? 0;
}

export function getSnapshots(guildId) {
  return stmts.snapshots.all(guildId);
}

// ─── startAnalyticsJob ────────────────────────────────────────────────────────
// Records one period snapshot per guild per hour, feeding the dashboard's
// growth-history graph (dashboard/server.js's GET /analytics reads this same
// analytics_snapshots table, grouped by day).
let _analyticsTimer = null;
let _analyticsPruneTimer = null;

export function startAnalyticsJob(client) {
  if (_analyticsTimer) return;

  // client.guilds?.cache is always undefined (GuildManager extends
  // Collection directly, confirmed against @fluxerjs/core source), and the
  // real Guild class has no memberCount field either, only a raw REST
  // fetch with ?with_counts=true exposes one. Both bugs together meant
  // this loop never ran at all and member_count was always NULL on every
  // row it would have written anyway.
  const snap = async () => {
    const guilds = client.guilds ?? new Map();
    const now    = Date.now();
    const today  = new Date().toISOString().slice(0, 10);

    for (const [guildId] of guilds) {
      if (!isAnalyticsEnabled(guildId)) continue;
      try {
        const periodStart = stmts.lastSnapshot.get(guildId)?.period_end ?? (now - 60 * 60 * 1000);
        const joins   = getJoinCount(guildId, periodStart, now);
        const leaves  = getLeaveCount(guildId, periodStart, now);
        const act     = stmts.activityForDate.get(guildId, today);
        const countData = await client.rest.get(`/guilds/${guildId}?with_counts=true`).catch(() => null);
        const memberCount = countData?.approximate_member_count ?? countData?.member_count ?? null;

        stmts.insertSnapshot.run(
          guildId, periodStart, now, joins, leaves, joins - leaves,
          act?.active_users ?? 0, act?.message_count ?? 0, memberCount,
        );
      } catch { /* non-fatal, one guild's failure shouldn't skip the rest */ }
    }
  };

  resilience.runLight('analyticsSystem.snap', snap); // immediate
  _analyticsTimer = setInterval(() => resilience.runLight('analyticsSystem.snap', snap), 60 * 60 * 1000); // hourly
  _analyticsTimer.unref?.();

  const prune = () => {
    const r = pruneAnalytics();
    if (r.rows) logger.info(`[ANALYTICS] Retention: removed ${r.rows} row(s) across ${r.guilds} server(s), ${r.staleGuilds} inactive server(s) purged.`);
  };
  resilience.runLight('analyticsSystem.prune', prune); // on boot, then daily
  _analyticsPruneTimer = setInterval(() => resilience.runLight('analyticsSystem.prune', prune), 24 * 60 * 60 * 1000);
  _analyticsPruneTimer.unref?.();
  logger.info('[ANALYTICS] Job started (hourly snapshots, daily retention cleanup).');
}
