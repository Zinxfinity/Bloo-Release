import db from '../db.js';
import { getMemberRoleIds } from '../config/guildPermissions.js';
import logger from '../utils/logger.js';
import * as resilience from './resilience.js';
import { EmbedBuilder } from '@fluxerjs/core';
// Also runs user_preferences' CREATE TABLE as a side effect of import,
// which must happen before the leaderboard/rank prepared statements below
// compile, they reference that table in a NOT IN subquery.
import { wantsLevelupPing } from './userPreferences.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS xp_config (
    guild_id          TEXT    PRIMARY KEY,
    enabled           INTEGER NOT NULL DEFAULT 1,
    xp_min            INTEGER NOT NULL DEFAULT 5,
    xp_max            INTEGER NOT NULL DEFAULT 15,
    xp_cooldown_s     INTEGER NOT NULL DEFAULT 60,
    levelup_channel   TEXT,
    levelup_message   TEXT    NOT NULL DEFAULT 'GG {user}, you reached level **{level}**!',
    stack_roles       INTEGER NOT NULL DEFAULT 1,
    updated_at        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS xp_users (
    guild_id       TEXT    NOT NULL,
    user_id        TEXT    NOT NULL,
    xp             INTEGER NOT NULL DEFAULT 0,
    level          INTEGER NOT NULL DEFAULT 0,
    last_xp_at     INTEGER NOT NULL DEFAULT 0,
    last_decay     INTEGER NOT NULL DEFAULT 0,
    display_name   TEXT,
    hidden         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS xp_role_rewards (
    guild_id TEXT    NOT NULL,
    level    INTEGER NOT NULL,
    role_id  TEXT    NOT NULL,
    PRIMARY KEY (guild_id, level)
  );

  -- The real role-reward source (dashboard/routes/xp.js's per-level "+ Role"
  -- button writes here). PK includes role_id, not just (guild_id, level):
  -- a level can hold multiple roles, confirmed against live data (164 rows
  -- across 27 guilds already rely on this). handleLevelUp previously read
  -- xp_role_rewards instead, a different, always-empty table only the
  -- !xp rolereward command ever touched, silently ignoring every role an
  -- admin configured through the dashboard.
  CREATE TABLE IF NOT EXISTS xp_level_roles (
    guild_id TEXT    NOT NULL,
    level    INTEGER NOT NULL,
    role_id  TEXT    NOT NULL,
    PRIMARY KEY (guild_id, level, role_id)
  );

  -- Custom per-level names and XP thresholds, admin-configured on the
  -- dashboard's "Level Definitions" card. Previously only ever
  -- CREATE TABLE'd lazily from dashboard/routes/xp.js, meaning the bot
  -- itself couldn't rely on this table existing to read from it.
  CREATE TABLE IF NOT EXISTS xp_levels (
    guild_id    TEXT    NOT NULL,
    level       INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    xp_required INTEGER NOT NULL,
    role_id     TEXT,
    PRIMARY KEY (guild_id, level)
  );

  -- Dashboard-managed multipliers, read by xpMultiplier() below.
  CREATE TABLE IF NOT EXISTS xp_channel_rules (
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    multiplier REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (guild_id, channel_id)
  );
  CREATE TABLE IF NOT EXISTS xp_role_rules (
    guild_id   TEXT NOT NULL,
    role_id    TEXT NOT NULL,
    multiplier REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (guild_id, role_id)
  );
  -- started_at/expires_at are milliseconds.
  CREATE TABLE IF NOT EXISTS xp_boost_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT    NOT NULL,
    multiplier REAL    NOT NULL DEFAULT 2.0,
    label      TEXT,
    started_by TEXT,
    started_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Schema migrations, run before ANY db.prepare() call
for (const col of [
  `ALTER TABLE xp_users ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE xp_users ADD COLUMN display_name TEXT`,
  `ALTER TABLE xp_users ADD COLUMN last_xp_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE xp_users ADD COLUMN last_decay INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE xp_config ADD COLUMN stack_roles INTEGER NOT NULL DEFAULT 1`,
  // Missing from the live table, so every `!xp config <field> <value>` threw
  // "no such column: updated_at" before this.
  `ALTER TABLE xp_config ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
  // The rest of these are written by dashboard/routes/xp.js's PATCH
  // /xp/config, which only ever ALTERed in levelup_message/decay_floor_mode/
  // levelup_color/levelup_image itself, the other columns only exist on
  // the live db today because of undocumented earlier drift. Declaring
  // them here too so a fresh install's first dashboard save (or this
  // file's own handleLevelUp, which now reads several of them) doesn't
  // throw "no such column".
  `ALTER TABLE xp_config ADD COLUMN levels_enabled INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE xp_config ADD COLUMN levelup_notify INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE xp_config ADD COLUMN levelup_message TEXT`,
  `ALTER TABLE xp_config ADD COLUMN levelup_color TEXT`,
  `ALTER TABLE xp_config ADD COLUMN levelup_image TEXT`,
  `ALTER TABLE xp_config ADD COLUMN role_rewards INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE xp_config ADD COLUMN role_stack INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE xp_config ADD COLUMN role_remove_on_decay INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE xp_config ADD COLUMN streak_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE xp_config ADD COLUMN streak_mode TEXT NOT NULL DEFAULT 'day'`,
  `ALTER TABLE xp_config ADD COLUMN streak_bonus_pct INTEGER NOT NULL DEFAULT 20`,
  `ALTER TABLE xp_config ADD COLUMN decay_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE xp_config ADD COLUMN decay_rate_pct INTEGER NOT NULL DEFAULT 5`,
  `ALTER TABLE xp_config ADD COLUMN decay_interval_days INTEGER NOT NULL DEFAULT 7`,
  `ALTER TABLE xp_config ADD COLUMN decay_floor_xp INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE xp_config ADD COLUMN decay_floor_mode TEXT NOT NULL DEFAULT 'xp'`,
  // Streak state. The live table already has both from an older build
  // (last_streak_day holds a 'YYYY-MM-DD' date), fresh installs need them.
  `ALTER TABLE xp_users ADD COLUMN streak INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE xp_users ADD COLUMN last_streak_day TEXT`,
]) {
  try { db.exec(col); } catch { /* already exists */ }
}

// One-time: stack_roles (what the bot actually does, default on) and
// role_stack (what the dashboard toggle shows, default off) disagreed for
// most servers, so the next unrelated dashboard save silently switched them
// to non-stacking. Make the dashboard show the real behaviour from now on.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (key TEXT PRIMARY KEY, done_at INTEGER NOT NULL)`);
  if (!db.prepare(`SELECT 1 FROM schema_migrations WHERE key = 'xp_role_stack_sync'`).get()) {
    db.transaction(() => {
      db.exec(`UPDATE xp_config SET role_stack = stack_roles`);
      db.prepare(`INSERT INTO schema_migrations (key, done_at) VALUES ('xp_role_stack_sync', unixepoch())`).run();
    })();
  }
} catch (err) { logger.warn('[XP] role_stack sync migration failed:', err.message); }

// The XP streak is one per member across every server, with bot-wide rules
// set by bot owners (not per server). Chatting in any server where XP is on
// keeps it going, and the bonus applies wherever they earn XP. The old
// per-server xp_users.streak / xp_config.streak_* columns are left in place
// but no longer read.
db.exec(`
  CREATE TABLE IF NOT EXISTS xp_streaks (
    user_id         TEXT PRIMARY KEY,
    streak          INTEGER NOT NULL DEFAULT 0,
    last_streak_day TEXT
  );
  CREATE TABLE IF NOT EXISTS xp_streak_settings (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    enabled    INTEGER NOT NULL DEFAULT 1,
    mode       TEXT    NOT NULL DEFAULT 'day',
    bonus_pct  INTEGER NOT NULL DEFAULT 20,
    updated_by TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO xp_streak_settings (id) VALUES (1);
`);

// One-time: carry each member's most recent per-server streak over, so
// nobody who's mid-streak loses it when the global streak takes over.
try {
  if (!db.prepare(`SELECT 1 FROM schema_migrations WHERE key = 'xp_streak_global'`).get()) {
    db.transaction(() => {
      const rows = db.prepare(`SELECT user_id, streak, last_streak_day FROM xp_users
        WHERE last_streak_day IS NOT NULL AND streak > 0 ORDER BY last_streak_day DESC, streak DESC`).all();
      const ins = db.prepare(`INSERT OR IGNORE INTO xp_streaks (user_id, streak, last_streak_day) VALUES (?, ?, ?)`);
      for (const r of rows) ins.run(r.user_id, r.streak, r.last_streak_day);
      db.prepare(`INSERT INTO schema_migrations (key, done_at) VALUES ('xp_streak_global', unixepoch())`).run();
    })();
  }
} catch (err) { logger.warn('[XP] global streak migration failed:', err.message); }

// Ensure hidden column indexed for leaderboard performance
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_xp_users_lb ON xp_users (guild_id, hidden, xp DESC)`);
} catch { /* already exists */ }

// One-time cleanup: the dashboard's per-level "+ Role" prompt never
// sanitized what got pasted, so a Discord/Fluxer mention (<@&123456>)
// pasted instead of a raw ID left at least one malformed role_id sitting
// next to a clean duplicate for the same level. Strip non-digits; if a
// clean row for the same (guild_id, level, role_id) already exists, drop
// the malformed one instead of colliding with the table's PK. Idempotent
// and cheap, becomes a no-op once every stored role_id is already clean.
try {
  const rows = db.prepare(`SELECT rowid, guild_id, level, role_id FROM xp_level_roles`).all();
  const deleteRow = db.prepare(`DELETE FROM xp_level_roles WHERE rowid = ?`);
  const updateRow = db.prepare(`UPDATE xp_level_roles SET role_id = ? WHERE rowid = ?`);
  const findClean = db.prepare(`SELECT 1 FROM xp_level_roles WHERE guild_id = ? AND level = ? AND role_id = ?`);
  for (const row of rows) {
    const clean = row.role_id.replace(/\D/g, '');
    if (!clean || clean === row.role_id) continue;
    if (findClean.get(row.guild_id, row.level, clean)) deleteRow.run(row.rowid);
    else updateRow.run(clean, row.rowid);
  }
} catch { /* best effort cleanup, non-fatal */ }

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  getConfig:    db.prepare(`SELECT * FROM xp_config WHERE guild_id = ?`),
  ensureConfig: db.prepare(`INSERT OR IGNORE INTO xp_config (guild_id) VALUES (?)`),
  setConfigField: (field) => db.prepare(
    `UPDATE xp_config SET ${field} = ?, updated_at = unixepoch() WHERE guild_id = ?`
  ),
  getUser: db.prepare(`SELECT * FROM xp_users WHERE guild_id = ? AND user_id = ?`),
  upsertUser: db.prepare(`
    INSERT INTO xp_users (guild_id, user_id, xp, level, last_xp_at, display_name)
    VALUES (?, ?, ?, 0, unixepoch(), ?)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      xp           = excluded.xp,
      last_xp_at   = excluded.last_xp_at,
      display_name = COALESCE(excluded.display_name, xp_users.display_name),
      hidden       = 0
  `),
  setLevel: db.prepare(`UPDATE xp_users SET level = ? WHERE guild_id = ? AND user_id = ?`),
  // Manual XP changes (b!xp give/take/set). Unlike upsertUser this leaves
  // last_xp_at alone, so a staff change doesn't reset the member's cooldown.
  setXp: db.prepare(`
    INSERT INTO xp_users (guild_id, user_id, xp, level, last_xp_at, display_name)
    VALUES (?, ?, ?, 0, 0, ?)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      xp           = excluded.xp,
      display_name = COALESCE(excluded.display_name, xp_users.display_name)
  `),
  // stats_private (Account page opt-out, global across every guild, see
  // handlers/userPreferences.js) excludes a user from the leaderboard the
  // same way `hidden` already does for left-server pruning, distinct
  // mechanisms (this one is user-chosen and sticky, `hidden` is
  // admin-triggered and clears itself the moment the user is active
  // again, see softPrune/hardPrune below), same net effect on this query.
  leaderboard: db.prepare(`
    SELECT user_id, xp, level, display_name FROM xp_users
    WHERE guild_id = ? AND hidden = 0
    AND user_id NOT IN (SELECT user_id FROM user_preferences WHERE stats_private = 1)
    ORDER BY xp DESC LIMIT ? OFFSET ?
  `),
  rank: db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM xp_users
    WHERE guild_id = ? AND xp > (SELECT xp FROM xp_users WHERE guild_id = ? AND user_id = ?)
    AND hidden = 0
    AND user_id NOT IN (SELECT user_id FROM user_preferences WHERE stats_private = 1)
  `),
  totalUsers: db.prepare(`
    SELECT COUNT(*) AS n FROM xp_users WHERE guild_id = ? AND hidden = 0
    AND user_id NOT IN (SELECT user_id FROM user_preferences WHERE stats_private = 1)
  `),
  resetUser:  db.prepare(`DELETE FROM xp_users WHERE guild_id = ? AND user_id = ?`),
  resetAll:   db.prepare(`DELETE FROM xp_users WHERE guild_id = ?`),
  // xp_level_roles, not the legacy xp_role_rewards (always empty in
  // production, see the CREATE TABLE comment above): a level can hold
  // multiple roles, so this can return more than one row per level.
  getRoleRewards: db.prepare(`SELECT * FROM xp_level_roles WHERE guild_id = ? ORDER BY level ASC`),
  getCustomLevels: db.prepare(`SELECT * FROM xp_levels WHERE guild_id = ? ORDER BY level ASC`),
  setRoleReward:  db.prepare(`
    INSERT OR IGNORE INTO xp_level_roles (guild_id, level, role_id) VALUES (?, ?, ?)
  `),
  removeRoleReward: db.prepare(`DELETE FROM xp_level_roles WHERE guild_id = ? AND level = ? AND role_id = ?`),
  softPrune: db.prepare(`
    UPDATE xp_users SET hidden = 1
    WHERE guild_id = ? AND user_id NOT IN (SELECT value FROM json_each(?))
  `),
  hardPrune: db.prepare(`
    DELETE FROM xp_users
    WHERE guild_id = ? AND user_id NOT IN (SELECT value FROM json_each(?))
  `),
  setStreak: db.prepare(`UPDATE xp_users SET streak = ?, last_streak_day = ? WHERE guild_id = ? AND user_id = ?`),
  decayGuilds: db.prepare(`SELECT * FROM xp_config WHERE enabled = 1 AND decay_enabled = 1`),
  // last_decay is NULL for every existing row on the live table (no default
  // there), which the old `last_decay < x` check never matched.
  decayDue: db.prepare(`
    SELECT user_id, xp, level FROM xp_users
    WHERE guild_id = ? AND xp > 0 AND last_xp_at < ? AND (last_decay IS NULL OR last_decay < ?)
  `),
  applyDecay: db.prepare(`UPDATE xp_users SET xp = ?, level = ?, last_decay = ? WHERE guild_id = ? AND user_id = ?`),
};

// ─── XP formula ───────────────────────────────────────────────────────────────
// Default curve, used for any guild that hasn't defined custom levels via
// the dashboard's "Level Definitions" card (xp_levels). XP needed to reach
// a level: 5 * level^2 + 50 * level + 100, cumulative.
function defaultXpForLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

function defaultLevelFromXp(totalXp) {
  let level = 0;
  let accumulated = 0;
  while (accumulated + defaultXpForLevel(level + 1) <= totalXp) {
    accumulated += defaultXpForLevel(level + 1);
    level++;
  }
  return level;
}

// A guild's custom levels (xp_levels.xp_required) are stored as absolute
// total-XP thresholds ("you need 200 XP total to be Level 2"), unlike the
// default curve above which is a per-level increment summed cumulatively.
// Previously this table was written to by the dashboard and never read
// anywhere bot-side, so any custom curve an admin configured had no effect
// on actual leveling, only on what the (also-never-consulted) name showed
// back in the dashboard's own table.
function getLevelDefinitions(guildId) {
  return stmts.getCustomLevels.all(guildId);
}

// Threshold (total XP) required to REACH `level`. Once a guild defines any
// custom levels, that ladder replaces the default curve entirely rather
// than splicing the two (their thresholds mean different things: custom
// levels are absolute totals, the default curve is cumulative increments),
// so the ladder caps at the highest level an admin has actually defined.
// Infinity for a level beyond that cap means "not attainable yet", callers
// display that as maxed out rather than a bogus number.
function xpForLevel(level, guildId = null) {
  if (guildId) {
    const custom = getLevelDefinitions(guildId);
    if (custom.length) {
      const entry = custom.find(l => l.level === level);
      if (entry) return entry.xp_required;
      const maxLevel = custom[custom.length - 1].level;
      return level > maxLevel ? Infinity : defaultXpForLevel(level);
    }
  }
  return defaultXpForLevel(level);
}

function levelFromXp(totalXp, guildId = null) {
  if (guildId) {
    const custom = getLevelDefinitions(guildId);
    if (custom.length) {
      let level = 0;
      for (const entry of custom) {
        if (totalXp >= entry.xp_required) level = entry.level;
        else break;
      }
      return level;
    }
  }
  return defaultLevelFromXp(totalXp);
}

// Total XP needed to reach `level`. xpForLevel's default curve is a
// per-level increment, so the rank card and {next_xp} were comparing a
// member's running total against the size of one level (1,000 XP at level 3
// showed "1000 / 380" with a full bar).
function totalXpForLevel(level, guildId = null) {
  if (level <= 0) return 0;
  const custom = guildId ? getLevelDefinitions(guildId) : [];
  if (custom.length) return custom.find(l => l.level === level)?.xp_required ?? 0;
  let total = 0;
  for (let l = 1; l <= level; l++) total += defaultXpForLevel(l);
  return total;
}

// Where `xp` sits between the current level and the next one. A custom
// ladder only has the levels an admin defined, so "next" is the next defined
// level, and null once the top one is reached.
function levelProgress(guildId, xp) {
  const level  = levelFromXp(xp, guildId);
  const custom = getLevelDefinitions(guildId);
  const floor  = totalXpForLevel(level, guildId);
  let nextLevel = level + 1;
  let next      = totalXpForLevel(level + 1);
  if (custom.length) {
    const above = custom.find(l => l.level > level);
    nextLevel = above?.level ?? null;
    next      = above?.xp_required ?? null;
  }
  const progress = next == null ? 1 : Math.max(0, Math.min(1, (xp - floor) / Math.max(1, next - floor)));
  return { level, floor, nextLevel, next, progress };
}

// Custom name for a level (e.g. "GigaByte"), or null if the guild hasn't
// defined one. Callers fall back to a plain "Level N" label themselves.
function getLevelName(guildId, level) {
  const custom = getLevelDefinitions(guildId);
  return custom.find(l => l.level === level)?.name ?? null;
}

// ─── getXpConfig ─────────────────────────────────────────────────────────────
export function getXpConfig(guildId) {
  stmts.ensureConfig.run(guildId);
  return stmts.getConfig.get(guildId);
}

export function setXpConfigField(guildId, field, value) {
  // Everything the dashboard's XP settings page can change, so b!xp config
  // covers the same ground (the release build has no dashboard at all).
  const allowed = [
    'enabled','xp_min','xp_max','xp_cooldown_s',
    'levelup_channel','levelup_message','stack_roles',
    'levels_enabled','levelup_notify','levelup_color','levelup_image',
    'role_rewards','role_remove_on_decay',
    'decay_enabled','decay_rate_pct','decay_interval_days','decay_floor_xp','decay_floor_mode',
  ];
  if (!allowed.includes(field)) throw new Error(`Unknown xp config field: ${field}`);
  stmts.ensureConfig.run(guildId);
  stmts.setConfigField(field).run(value, guildId);
  // The dashboard's toggle reads role_stack; keep both columns in step.
  if (field === 'stack_roles') stmts.setConfigField('role_stack').run(value, guildId);
}

// ─── handleXpMessage ─────────────────────────────────────────────────────────
/**
 * Called from messageCreate.js for every non-bot, non-command message.
 * Awards XP respecting cooldown; checks for level-up and role rewards.
 */
// Product of: this channel's rule (0 = no XP here), the highest multiplier
// among the member's roles, and the strongest active boost event. Each table
// is created lazily by the dashboard, so a missing table just means 1x.
function xpMultiplier(guildId, channelId, roleIds) {
  const read = (fn) => { try { return fn(); } catch { return null; } };
  const channel = read(() => db.prepare('SELECT multiplier FROM xp_channel_rules WHERE guild_id = ? AND channel_id = ?').get(guildId, channelId)?.multiplier);
  const roles = roleIds.length
    ? read(() => db.prepare(`SELECT MAX(multiplier) AS m FROM xp_role_rules WHERE guild_id = ? AND role_id IN (${roleIds.map(() => '?').join(',')})`).get(guildId, ...roleIds)?.m)
    : null;
  // xp_boost_events.expires_at is milliseconds (written with Date.now()).
  const boost = read(() => db.prepare('SELECT MAX(multiplier) AS m FROM xp_boost_events WHERE guild_id = ? AND expires_at > ?').get(guildId, Date.now())?.m);
  return (channel ?? 1) * (roles ?? 1) * (boost ?? 1);
}

export async function handleXpMessage(client, message) {
  const guildId = message.guildId;
  const userId  = message.author?.id;
  if (!guildId || !userId) return;

  const config = getXpConfig(guildId);
  if (!config?.enabled) return;

  const now  = Math.floor(Date.now() / 1000);
  const user = stmts.getUser.get(guildId, userId);

  // Cooldown check
  const lastXpAt = user?.last_xp_at ?? 0;
  if (now - lastXpAt < config.xp_cooldown_s) return;

  // Award random XP in configured range, scaled by the dashboard's channel
  // rules, role rules and boost events (saved there but never applied before).
  const multiplier = xpMultiplier(guildId, message.channelId, getMemberRoleIds(message.member));
  if (multiplier <= 0) return; // channel set to earn no XP
  const lo     = Math.max(0, Math.min(config.xp_min, config.xp_max));
  const hi     = Math.max(config.xp_min, config.xp_max);
  const base   = lo + Math.floor(Math.random() * (hi - lo + 1));
  const rules  = getStreakSettings();
  const streak = rules.enabled ? nextStreak(streakStmts.get.get(userId), rules.mode, now) : null;
  const bonus  = streak && streak.count >= 2 ? 1 + Math.max(0, Math.min(500, rules.bonus_pct ?? 0)) / 100 : 1;
  const gain   = Math.max(1, Math.round(base * multiplier * bonus));
  const newXp  = (user?.xp ?? 0) + gain;
  const name   = message.member?.displayName ?? message.author?.username ?? null;

  stmts.upsertUser.run(guildId, userId, newXp, name);
  if (streak) streakStmts.set.run(userId, streak.count, streak.day);

  // Keep the stored level in step with the ladder, including after an admin
  // edits the level definitions; only a rise is announced.
  const oldLevel = user?.level ?? 0;
  const newLevel = levelFromXp(newXp, guildId);
  if (newLevel !== oldLevel) stmts.setLevel.run(newLevel, guildId, userId);

  if (newLevel > oldLevel) {
    // "Levels Enabled" is the dashboard's master switch for whether
    // leveling actually does anything visible: off means XP keeps
    // accumulating (so nothing here needs gating) but nobody sees a
    // level-up message or earns a role.
    if (config.levels_enabled ?? 1) {
      await handleLevelUp(client, message, guildId, userId, oldLevel, newLevel, newXp, config);
    }
  }
}

// Streak periods are UTC days, or Monday-start weeks in 'week' mode. The
// stored last_streak_day is the first date of the period ('YYYY-MM-DD'),
// matching the format older builds already left in the live table.
const DAY_MS = 86_400_000;
function streakPeriod(mode, ms) {
  const day = Math.floor(ms / DAY_MS);
  return mode === 'week' ? Math.floor((day + 3) / 7) : day; // epoch day 0 was a Thursday
}
function periodStartDate(mode, period) {
  const day = mode === 'week' ? period * 7 - 3 : period;
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
function nextStreak(user, mode, nowSeconds) {
  const current = streakPeriod(mode, nowSeconds * 1000);
  const lastMs  = user?.last_streak_day ? Date.parse(`${user.last_streak_day}T00:00:00Z`) : NaN;
  const last    = Number.isFinite(lastMs) ? streakPeriod(mode, lastMs) : null;
  const prev    = user?.streak ?? 0;
  const count   = last === current ? Math.max(1, prev) : last === current - 1 ? prev + 1 : 1;
  return { count, day: periodStartDate(mode, current) };
}

const streakStmts = {
  get: db.prepare(`SELECT streak, last_streak_day FROM xp_streaks WHERE user_id = ?`),
  set: db.prepare(`INSERT INTO xp_streaks (user_id, streak, last_streak_day) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET streak = excluded.streak, last_streak_day = excluded.last_streak_day`),
  settings: db.prepare(`SELECT enabled, mode, bonus_pct, updated_by, updated_at FROM xp_streak_settings WHERE id = 1`),
};

export function getStreakSettings() {
  return streakStmts.settings.get() ?? { enabled: 1, mode: 'day', bonus_pct: 20 };
}

// Bot-owner only (enforced by the callers). Returns an error string or null.
export function setStreakSettings({ enabled, mode, bonus_pct }, updatedBy = null) {
  const cur = getStreakSettings();
  const next = {
    enabled: enabled === undefined ? cur.enabled : (enabled ? 1 : 0),
    mode: mode ?? cur.mode,
    bonus_pct: bonus_pct === undefined ? cur.bonus_pct : Number(bonus_pct),
  };
  if (!['day', 'week'].includes(next.mode)) return 'Streak mode must be daily or weekly.';
  if (!Number.isInteger(next.bonus_pct) || next.bonus_pct < 0 || next.bonus_pct > 500) return 'Streak bonus must be 0 to 500%.';
  db.prepare(`UPDATE xp_streak_settings SET enabled = ?, mode = ?, bonus_pct = ?, updated_by = ?, updated_at = unixepoch() WHERE id = 1`)
    .run(next.enabled, next.mode, next.bonus_pct, updatedBy);
  return null;
}

// guildId is unused now (the streak is global) but kept so callers don't change.
export function getStreak(_guildId, userId) {
  const rules = getStreakSettings();
  const row   = streakStmts.get.get(userId);
  if (!rules.enabled || !row) return 0;
  const now = streakPeriod(rules.mode, Date.now());
  const lastMs = row.last_streak_day ? Date.parse(`${row.last_streak_day}T00:00:00Z`) : NaN;
  const last = Number.isFinite(lastMs) ? streakPeriod(rules.mode, lastMs) : null;
  return last === now || last === now - 1 ? (row.streak ?? 0) : 0;
}

function hexToInt(hex) {
  const n = parseInt(String(hex ?? '').replace(/^#/, ''), 16);
  return isNaN(n) ? null : n;
}

// ─── Reward roles ─────────────────────────────────────────────────────────────
// The one place that decides which level roles a member should hold, used by
// level-ups, manual XP changes and b!xp syncroles. Non-stacking keeps only the
// highest reward level reached, not "a reward at exactly this level": a jump
// from 4 to 6 (a boost, or a sparse custom ladder) would otherwise skip the
// level 5 role. removeHigher also takes away roles for levels above `level`
// (after XP was taken away); a plain level-up never needs that. `have` is the
// member's current role IDs when known, so only real changes are sent.
async function applyRewardRoles(client, guildId, userId, level, config, { removeHigher = false, have = null } = {}) {
  const result = { given: 0, removed: 0, failed: 0 };
  if (!(config.role_rewards ?? 1)) return result;
  const rewards  = stmts.getRoleRewards.all(guildId);
  const reached  = rewards.filter(r => r.level <= level);
  const topLevel = reached.length ? reached[reached.length - 1].level : null;
  const keep     = config.stack_roles ? reached : reached.filter(r => r.level === topLevel);
  const keepIds  = new Set(keep.map(r => r.role_id));
  const drop     = rewards.filter(r => !keepIds.has(r.role_id) && (r.level <= level ? !config.stack_roles : removeHigher));

  // Failures are logged: the usual cause is Bloo's own role sitting below the
  // reward role (or missing Manage Roles), which used to fail with no trace.
  for (const r of keep) {
    if (have?.has(r.role_id)) continue;
    try {
      await client.rest.put(`/guilds/${guildId}/members/${userId}/roles/${r.role_id}`);
      result.given++;
    } catch (err) {
      result.failed++;
      logger.warn(`[XP] Couldn't give level ${r.level} role ${r.role_id} to ${userId} in ${guildId}: ${err.message}. Check Bloo's role is above it and has Manage Roles.`);
    }
  }
  for (const r of drop) {
    if (have && !have.has(r.role_id)) continue;
    try {
      await client.rest.delete(`/guilds/${guildId}/members/${userId}/roles/${r.role_id}`);
      result.removed++;
    } catch (err) {
      result.failed++;
      logger.warn(`[XP] Couldn't remove level ${r.level} role ${r.role_id} from ${userId} in ${guildId}: ${err.message}`);
    }
  }
  return result;
}

// ─── Manual XP changes ────────────────────────────────────────────────────────
export const MAX_XP = 1_000_000_000;

// Reward roles a member with `xp` would hold, so a command can check the
// person changing XP could give those roles by hand before applying it.
export function rewardRolesForXp(guildId, xp) {
  const config = getXpConfig(guildId);
  if (!(config.levels_enabled ?? 1) || !(config.role_rewards ?? 1)) return [];
  const level    = levelFromXp(Math.max(0, xp), guildId);
  const reached  = stmts.getRoleRewards.all(guildId).filter(r => r.level <= level);
  const topLevel = reached.length ? reached[reached.length - 1].level : null;
  return config.stack_roles ? reached : reached.filter(r => r.level === topLevel);
}

// mode: 'give' | 'take' | 'set'. Applies the new level and its reward roles
// straight away (no level-up message: staff see the result in their reply).
export async function adjustXp(client, guildId, userId, mode, amount, displayName = null) {
  const config   = getXpConfig(guildId);
  const user     = stmts.getUser.get(guildId, userId);
  const before   = user?.xp ?? 0;
  const oldLevel = user?.level ?? 0;
  const raw      = mode === 'set' ? amount : mode === 'take' ? before - amount : before + amount;
  const xp       = Math.max(0, Math.min(MAX_XP, Math.round(raw)));
  stmts.setXp.run(guildId, userId, xp, displayName);
  const level = levelFromXp(xp, guildId);
  stmts.setLevel.run(level, guildId, userId);
  const roles = (config.levels_enabled ?? 1)
    ? await applyRewardRoles(client, guildId, userId, level, config, { removeHigher: true })
    : null;
  return { before, xp, oldLevel, level, roles };
}

// ─── b!xp syncroles ───────────────────────────────────────────────────────────
// Brings every tracked member's level roles in line with their XP, for
// members who passed a level before its role existed, or while Bloo couldn't
// give it. One run per server at a time.
const _syncing = new Set();

export async function syncRewardRoles(client, guildId, onProgress = null) {
  if (_syncing.has(guildId)) return { busy: true };
  const config = getXpConfig(guildId);
  if (!(config.levels_enabled ?? 1) || !(config.role_rewards ?? 1)) return { off: true };
  const rewards = stmts.getRoleRewards.all(guildId);
  if (!rewards.length) return { noRewards: true };

  _syncing.add(guildId);
  try {
    // Members below the lowest reward level can't be owed a role.
    const lowest = rewards[0].level;
    const users  = db.prepare(`SELECT user_id, xp FROM xp_users WHERE guild_id = ?`).all(guildId)
      .map(u => ({ ...u, level: levelFromXp(u.xp, guildId) }))
      .filter(u => u.level >= lowest);
    const res = { total: users.length, checked: 0, changed: 0, given: 0, removed: 0, left: 0, failed: 0 };
    for (const u of users) {
      stmts.setLevel.run(u.level, guildId, u.user_id);
      let member;
      try {
        member = await client.rest.get(`/guilds/${guildId}/members/${u.user_id}`);
      } catch (err) {
        if (err.status === 404 || err.statusCode === 404) res.left++;
        else { res.failed++; logger.warn(`[XP] syncroles couldn't read ${u.user_id} in ${guildId}: ${err.message}`); }
        continue;
      }
      const r = await applyRewardRoles(client, guildId, u.user_id, u.level, config, { removeHigher: true, have: new Set(member?.roles ?? []) });
      res.checked++;
      res.given += r.given; res.removed += r.removed; res.failed += r.failed;
      if (r.given || r.removed) res.changed++;
      if (onProgress && res.checked % 25 === 0) await onProgress(res);
    }
    return res;
  } finally {
    _syncing.delete(guildId);
  }
}

// ─── handleLevelUp ────────────────────────────────────────────────────────────
async function handleLevelUp(client, message, guildId, userId, oldLevel, level, totalXp, config) {
  await applyRewardRoles(client, guildId, userId, level, config);

  // Level-up message. levelup_notify is the separate "still give the role,
  // just don't announce it" toggle. With no channel set it goes where the
  // member was talking, which is what the dashboard's field says it does.
  if (!(config.levelup_notify ?? 1)) return;
  const channelId = config.levelup_channel || message.channelId;

  const levelName  = getLevelName(guildId, level) ?? `Level ${level}`;
  const { nextLevel, next: nextXp } = levelProgress(guildId, totalXp);
  // The reward roles this level-up newly reached, for {roles}.
  const fresh      = rewardRolesForXp(guildId, totalXp).filter(r => r.level > oldLevel);
  const rolesText  = fresh.length ? fresh.map(r => `<@&${r.role_id}>`).join(', ') : 'None';
  // Per-user opt-out (Account page, dashboard/routes/userPreferences.js):
  // still announced by name either way, {username} covers "who", this
  // only decides whether {user} actually pings them.
  const userMention = wantsLevelupPing(userId) ? `<@${userId}>` : `**${message.author?.username ?? 'Someone'}**`;

  const text = (config.levelup_message || 'GG {user}, you reached level **{level}**!')
    .replace(/{user}/g,       userMention)
    .replace(/{username}/g,   message.author?.username ?? '')
    .replace(/{level_name}/g, levelName)
    .replace(/{level}/g,      String(level))
    .replace(/{xp}/g,         totalXp.toLocaleString())
    .replace(/{roles}/g,      rolesText)
    .replace(/{next_level}/g, nextLevel == null ? 'Max' : String(nextLevel))
    .replace(/{next_xp}/g,    nextXp == null ? 'Max' : nextXp.toLocaleString());

  // Dashboard calls this section "Level-up Embed Customisation" with no
  // plain-text option, so this always sends as an embed, never plain
  // content. Previously it was always plain text regardless, meaning
  // levelup_color/levelup_image were saved but had nothing to apply to.
  const embed = new EmbedBuilder().setDescription(text);
  const colorInt = hexToInt(config.levelup_color);
  if (colorInt != null) embed.setColor(colorInt);
  if (config.levelup_image) embed.setImage(config.levelup_image);

  // Raw REST, not client.channels.fetch() + channel.send(): confirmed in
  // production that pattern fails with "channel.send is not a function"
  // for at least one channel type on v2.0.1's SDK.
  await client.rest.post(`/channels/${channelId}/messages`, { body: { embeds: [embed.toJSON()] } }).catch(() => {});
}

// ─── getUserXp ────────────────────────────────────────────────────────────────
export function getUserXp(guildId, userId) {
  return stmts.getUser.get(guildId, userId) ?? null;
}

// ─── getUserRank ──────────────────────────────────────────────────────────────
export function getUserRank(guildId, userId) {
  const row = stmts.rank.get(guildId, guildId, userId);
  return row?.rank ?? null;
}

// ─── getLeaderboard ──────────────────────────────────────────────────────────
export function getLeaderboard(guildId, page = 1, pageSize = 10) {
  const offset = (page - 1) * pageSize;
  const rows   = stmts.leaderboard.all(guildId, pageSize, offset);
  const total  = stmts.totalUsers.get(guildId)?.n ?? 0;
  return { rows, total, page, pageSize };
}

// ─── resetUser / resetAll ─────────────────────────────────────────────────────
export function resetUserXp(guildId, userId) {
  stmts.resetUser.run(guildId, userId);
}

export function resetAllXp(guildId) {
  stmts.resetAll.run(guildId);
}

// ─── Role rewards ─────────────────────────────────────────────────────────────
// xp_level_roles allows multiple roles per level (matches the dashboard's
// own "+ Role" button, which can add several), so add is additive and
// remove needs a specific role, not "clear everything bound to this level".
export function setRoleReward(guildId, level, roleId) {
  stmts.setRoleReward.run(guildId, level, roleId);
}

export function removeRoleReward(guildId, level, roleId) {
  stmts.removeRoleReward.run(guildId, level, roleId);
}

export function getRoleRewards(guildId) {
  return stmts.getRoleRewards.all(guildId);
}

// ─── Multipliers, boosts and level names ─────────────────────────────────────
// The same settings the dashboard's XP page edits (dashboard/routes/xp.js),
// with the same limits, for b!xp multiplier / boost / level. Throws
// XpSettingError with a message meant for the person running the command.
export class XpSettingError extends Error {}
const intIn = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

export function setMultiplier(guildId, kind, targetId, multiplier) {
  const table = kind === 'channel' ? 'xp_channel_rules' : kind === 'role' ? 'xp_role_rules' : null;
  if (!table) throw new XpSettingError('Choose channel or role.');
  const col = kind === 'channel' ? 'channel_id' : 'role_id';
  if (multiplier == null) {
    return db.prepare(`DELETE FROM ${table} WHERE guild_id = ? AND ${col} = ?`).run(guildId, targetId).changes > 0;
  }
  if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 10) throw new XpSettingError('The multiplier must be from 0 (no XP) to 10.');
  db.prepare(`INSERT INTO ${table} (guild_id, ${col}, multiplier) VALUES (?, ?, ?)
              ON CONFLICT(guild_id, ${col}) DO UPDATE SET multiplier = excluded.multiplier`).run(guildId, targetId, multiplier);
  return true;
}

export function listMultipliers(guildId) {
  return {
    channels: db.prepare('SELECT channel_id, multiplier FROM xp_channel_rules WHERE guild_id = ? ORDER BY multiplier DESC').all(guildId),
    roles:    db.prepare('SELECT role_id, multiplier FROM xp_role_rules WHERE guild_id = ? ORDER BY multiplier DESC').all(guildId),
  };
}

export function startBoost(guildId, multiplier, hours, label, by) {
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 10) throw new XpSettingError('The multiplier must be above 0 and at most 10.');
  if (!Number.isFinite(hours) || hours <= 0 || hours > 720) throw new XpSettingError('The length must be more than 0 and at most 720 hours (30 days).');
  const now = Date.now();
  return db.prepare(`INSERT INTO xp_boost_events (guild_id, multiplier, label, started_by, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(guildId, multiplier, label ? String(label).slice(0, 80) : null, by ?? null, now, now + hours * 3_600_000).lastInsertRowid;
}

export function endBoost(guildId, boostId) {
  return db.prepare('DELETE FROM xp_boost_events WHERE guild_id = ? AND id = ?').run(guildId, Number(boostId)).changes > 0;
}

export function listBoosts(guildId) {
  db.prepare('DELETE FROM xp_boost_events WHERE guild_id = ? AND expires_at <= ?').run(guildId, Date.now());
  return db.prepare('SELECT * FROM xp_boost_events WHERE guild_id = ? ORDER BY expires_at ASC').all(guildId);
}

export function listLevelDefs(guildId) {
  return db.prepare('SELECT level, name, xp_required FROM xp_levels WHERE guild_id = ? ORDER BY level ASC').all(guildId);
}

export function setLevelDef(guildId, level, xpRequired, name) {
  name = String(name ?? '').trim();
  if (!intIn(level, 1, 1000)) throw new XpSettingError('The level must be a whole number from 1 to 1000.');
  if (!intIn(xpRequired, 1, 1e9)) throw new XpSettingError('The XP needed must be a whole number above 0.');
  if (!name || name.length > 50) throw new XpSettingError('Give the level a name, up to 50 characters.');
  // Levels are reached in order, so a threshold has to sit between its
  // neighbours or every level above it becomes unreachable.
  const below = db.prepare('SELECT level, xp_required FROM xp_levels WHERE guild_id = ? AND level < ? ORDER BY level DESC LIMIT 1').get(guildId, level);
  const above = db.prepare('SELECT level, xp_required FROM xp_levels WHERE guild_id = ? AND level > ? ORDER BY level ASC LIMIT 1').get(guildId, level);
  if (below && xpRequired <= below.xp_required) throw new XpSettingError(`Level ${level} needs more XP than level ${below.level} (${below.xp_required.toLocaleString()} XP).`);
  if (above && xpRequired >= above.xp_required) throw new XpSettingError(`Level ${level} needs less XP than level ${above.level} (${above.xp_required.toLocaleString()} XP).`);
  db.prepare(`INSERT INTO xp_levels (guild_id, level, name, xp_required) VALUES (?, ?, ?, ?)
              ON CONFLICT(guild_id, level) DO UPDATE SET name = excluded.name, xp_required = excluded.xp_required`).run(guildId, level, name, xpRequired);
}

export function removeLevelDef(guildId, level) {
  const removed = db.prepare('DELETE FROM xp_levels WHERE guild_id = ? AND level = ?').run(guildId, level).changes > 0;
  // Same as the dashboard: its reward roles go with it.
  if (removed) db.prepare('DELETE FROM xp_level_roles WHERE guild_id = ? AND level = ?').run(guildId, level);
  return removed;
}

// ─── Prune ───────────────────────────────────────────────────────────────────
/**
 * Fetch live member list and soft-prune users no longer in server.
 * Returns { pruned: number }
 */
export async function softPrune(client, guildId) {
  const members = await fetchAllMemberIds(client, guildId);
  if (!members.length) {
    logger.warn(`[XP] softPrune aborted, empty member list for ${guildId}`);
    return { pruned: 0 };
  }
  const result = stmts.softPrune.run(guildId, JSON.stringify(members));
  return { pruned: result.changes };
}

export async function hardPrune(client, guildId) {
  const members = await fetchAllMemberIds(client, guildId);
  if (!members.length) {
    logger.warn(`[XP] hardPrune aborted, empty member list for ${guildId}`);
    return { pruned: 0 };
  }
  const result = stmts.hardPrune.run(guildId, JSON.stringify(members));
  return { pruned: result.changes };
}

async function fetchAllMemberIds(client, guildId) {
  const ids = [];
  let after = '0';
  for (let page = 0; page < 100; page++) {
    try {
      const batch = await client.rest.get(
        `/guilds/${guildId}/members?limit=1000&after=${after}`
      );
      if (!Array.isArray(batch) || !batch.length) break;
      for (const m of batch) {
        const uid = m.user?.id ?? m.id;
        if (uid) ids.push(uid);
      }
      if (batch.length < 1000) break;
      after = batch[batch.length - 1].user?.id ?? batch[batch.length - 1].id;
    } catch {
      break;
    }
  }
  return ids;
}

// ─── XP decay ────────────────────────────────────────────────────────────────
// Only for servers that turned decay on in the dashboard, using their own
// settings: a member quiet for `decay_interval_days` loses `decay_rate_pct`
// of their XP, once per interval, never below the floor. 'xp' floor mode is
// a fixed amount; 'level' mode stops at the threshold of the member's
// current level so they keep their rank. The previous job ignored every one
// of these settings and never matched a row on the live table anyway.
// Returns the members whose level dropped, for role removal.
export function runXpDecay(nowSeconds = Math.floor(Date.now() / 1000), guildFilter = null) {
  const dropped = [];
  for (const cfg of stmts.decayGuilds.all()) {
    if (guildFilter && !guildFilter.has(cfg.guild_id)) continue;
    const interval = Math.max(1, cfg.decay_interval_days ?? 7) * 86400;
    const rate     = Math.max(0, Math.min(100, cfg.decay_rate_pct ?? 0)) / 100;
    const cutoff   = nowSeconds - interval;
    const due      = stmts.decayDue.all(cfg.guild_id, cutoff, cutoff);
    if (!due.length) continue;
    db.transaction(() => {
      for (const u of due) {
        const floor = cfg.decay_floor_mode === 'level'
          ? totalXpForLevel(levelFromXp(u.xp, cfg.guild_id), cfg.guild_id)
          : Math.max(0, cfg.decay_floor_xp ?? 0);
        const xp    = Math.max(Math.min(floor, u.xp), u.xp - Math.ceil(u.xp * rate));
        const level = levelFromXp(xp, cfg.guild_id);
        stmts.applyDecay.run(xp, level, nowSeconds, cfg.guild_id, u.user_id);
        if (level < u.level) dropped.push({ guildId: cfg.guild_id, userId: u.user_id, level, config: cfg });
      }
    })();
  }
  return dropped;
}

// "Remove Role on XP Decay": take away reward roles for levels the member
// no longer holds, keeping any role they still qualify for at a lower level.
async function removeDecayedRoles(client, dropped) {
  const byGuild = new Map();
  for (const d of dropped) {
    if (!d.config.role_remove_on_decay || !(d.config.role_rewards ?? 1)) continue;
    if (!byGuild.has(d.guildId)) byGuild.set(d.guildId, stmts.getRoleRewards.all(d.guildId));
    const rewards = byGuild.get(d.guildId);
    const reached = rewards.filter(r => r.level <= d.level);
    const topLevel = reached.length ? reached[reached.length - 1].level : null;
    const keep = new Set((d.config.stack_roles ? reached : reached.filter(r => r.level === topLevel)).map(r => r.role_id));
    for (const r of rewards.filter(r => r.level > d.level && !keep.has(r.role_id))) {
      await client.rest.delete(`/guilds/${d.guildId}/members/${d.userId}/roles/${r.role_id}`).catch(() => {});
    }
  }
}

let _decayTimer = null;

export function startXpDecay(client) {
  if (_decayTimer) return;

  const run = async () => {
    const inGuilds = client.guilds?.cache?.size ? new Set(client.guilds.cache.keys()) : null;
    const dropped = runXpDecay(Math.floor(Date.now() / 1000), inGuilds);
    if (dropped.length) await removeDecayedRoles(client, dropped);
  };

  resilience.runLight('xpSystem.decay', run); // immediate
  _decayTimer = setInterval(() => resilience.runLight('xpSystem.decay', run), 24 * 60 * 60 * 1000); // daily
  _decayTimer.unref?.();
  logger.info('[XP] Decay job started (daily).');
}

// ─── xpForLevel export ────────────────────────────────────────────────────────
export { xpForLevel, levelFromXp, getLevelName, getLevelDefinitions, totalXpForLevel, levelProgress };
