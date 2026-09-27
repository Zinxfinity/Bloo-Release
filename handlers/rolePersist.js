import db from '../db.js';
import { getMemberRoleIds } from '../config/guildPermissions.js';
import { getTrackedMember } from './memberTracking.js';
import logger from '../utils/logger.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS role_persist_config (
    guild_id       TEXT PRIMARY KEY,
    enabled        INTEGER NOT NULL DEFAULT 0,
    excluded_roles TEXT    NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS role_persist_snapshots (
    guild_id    TEXT    NOT NULL,
    user_id     TEXT    NOT NULL,
    role_ids    TEXT    NOT NULL,
    captured_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS role_persist_rules (
    guild_id   TEXT NOT NULL,
    role_id    TEXT NOT NULL,
    reason     TEXT,
    set_by     TEXT,
    set_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (guild_id, role_id)
  );
`);
// An older release named role_persist_rules' columns added_by/added_at
// instead of set_by/set_at, confirmed live with 14 real rules already
// configured by real staff (!rolepersist role add), not a fresh-install
// concern. Plain rename, no value reshaping.
{
  const cols = db.prepare(`PRAGMA table_info(role_persist_rules)`).all().map(c => c.name);
  if (cols.includes('added_by') && !cols.includes('set_by')) {
    try { db.exec('ALTER TABLE role_persist_rules RENAME COLUMN added_by TO set_by'); } catch { /* already renamed */ }
  }
  if (cols.includes('added_at') && !cols.includes('set_at')) {
    try { db.exec('ALTER TABLE role_persist_rules RENAME COLUMN added_at TO set_at'); } catch { /* already renamed */ }
  }
}

// reason/added_by are only populated by the manual `!rolepersist add` command
// (setPersist below), left NULL for automatic leave/rejoin captures
// (snapshotRoles), which have no "who added this" or reason to record.
for (const col of [
  `ALTER TABLE role_persist_snapshots ADD COLUMN reason   TEXT`,
  `ALTER TABLE role_persist_snapshots ADD COLUMN added_by TEXT`,
]) { try { db.exec(col); } catch { /* already exists */ } }

const stmts = {
  getConfig:    db.prepare(`SELECT * FROM role_persist_config WHERE guild_id = ?`),
  ensureConfig: db.prepare(`INSERT OR IGNORE INTO role_persist_config (guild_id) VALUES (?)`),
  setEnabled:   db.prepare(`UPDATE role_persist_config SET enabled = ? WHERE guild_id = ?`),
  setExcluded:  db.prepare(`UPDATE role_persist_config SET excluded_roles = ? WHERE guild_id = ?`),
  mergeSnapshot: db.prepare(`
    INSERT INTO role_persist_snapshots (guild_id, user_id, role_ids, captured_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT (guild_id, user_id) DO UPDATE SET role_ids = excluded.role_ids, captured_at = excluded.captured_at
  `),
  setSnapshotRoles: db.prepare(`UPDATE role_persist_snapshots SET role_ids = ? WHERE guild_id = ? AND user_id = ?`),
  getSnapshot:  db.prepare(`SELECT role_ids FROM role_persist_snapshots WHERE guild_id = ? AND user_id = ?`),
  deleteSnapshot: db.prepare(`DELETE FROM role_persist_snapshots WHERE guild_id = ? AND user_id = ?`),
  listSnapshots: db.prepare(`SELECT user_id, role_ids FROM role_persist_snapshots WHERE guild_id = ?`),
  listRuleRoleIds: db.prepare(`SELECT role_id FROM role_persist_rules WHERE guild_id = ?`),
};

export function getRolePersistConfig(guildId) {
  stmts.ensureConfig.run(guildId);
  return stmts.getConfig.get(guildId);
}

export function setRolePersistEnabled(guildId, enabled) {
  stmts.ensureConfig.run(guildId);
  stmts.setEnabled.run(enabled ? 1 : 0, guildId);
}

export function setExcludedRoles(guildId, roleIds) {
  stmts.ensureConfig.run(guildId);
  stmts.setExcluded.run(JSON.stringify(roleIds), guildId);
}

// ─── snapshotRoles, called on memberLeave ────────────────────────────────────
// Two independent sources feed the same snapshot row: the guild-wide
// capture-everything toggle (role_persist_config.enabled, opt-in per guild),
// and server-wide "always persist this specific role" rules
// (role_persist_rules, set via !rolepersist role add, e.g. @Muted). A rule
// applies even when the general toggle is off, that's the whole point of
// having a narrower opt-in, this previously only had the rules table and
// the command to manage it, restoreRoles() never actually read from it.
export function snapshotRoles(member) {
  const guildId = member.guild?.id ?? member.guildId;
  const userId  = member.user?.id  ?? member.id;
  if (!guildId || !userId) return;

  // v3: GuildMemberRemove's member is a PartialGuildMember, never carries
  // roles even for long-standing members. getMemberRoleIds returns [] in
  // that case, fall back to the live-synced tracking table instead of
  // silently persisting nothing on every single leave.
  let memberRoleIds = getMemberRoleIds(member);
  if (!memberRoleIds.length) {
    memberRoleIds = getTrackedMember(guildId, userId)?.roleIds ?? [];
  }

  const config = stmts.getConfig.get(guildId);
  let generalRoleIds = [];
  if (config?.enabled) {
    let excluded = [];
    try { excluded = JSON.parse(config.excluded_roles || '[]'); } catch { /* malformed config */ }
    generalRoleIds = memberRoleIds.filter(id => !excluded.includes(id));
  }

  const ruleRoleIds = new Set(stmts.listRuleRoleIds.all(guildId).map(r => r.role_id));
  const ruledRoleIds = memberRoleIds.filter(id => ruleRoleIds.has(id));

  const roleIds = [...new Set([...generalRoleIds, ...ruledRoleIds])];
  if (!roleIds.length) return;
  // Merge with any existing row (e.g. a manual `!rolepersist add` pin, or
  // roles a previous restore couldn't apply yet) instead of INSERT OR
  // REPLACE, which dropped those roles and wiped the pin's reason/added_by.
  const existing = stmts.getSnapshot.get(guildId, userId);
  let previous = [];
  try { previous = JSON.parse(existing?.role_ids || '[]'); } catch { /* corrupt, overwrite */ }
  stmts.mergeSnapshot.run(guildId, userId, JSON.stringify([...new Set([...previous, ...roleIds])]));
}

// ─── restoreRoles, called on memberJoin ──────────────────────────────────────
// No config.enabled gate here, a snapshot can exist purely from a role rule
// (see snapshotRoles above) even when the guild-wide toggle is off, and this
// has no way to tell which source contributed which role once they're
// merged into one row, restoring whatever was captured is correct either way.
export async function restoreRoles(client, member) {
  const guildId = member.guild?.id ?? member.guildId;
  const userId  = member.user?.id  ?? member.id;
  if (!guildId || !userId) return;

  const snapshot = stmts.getSnapshot.get(guildId, userId);
  if (!snapshot) return;

  let roleIds = [];
  try { roleIds = JSON.parse(snapshot.role_ids || '[]'); } catch { /* corrupt snapshot */ }
  if (!roleIds.length) { stmts.deleteSnapshot.run(guildId, userId); return; }

  // The snapshot is only trimmed as roles are actually applied. It used to be
  // deleted up front, so a failed member/role fetch (bot position read as 0,
  // every role skipped) lost it for good, letting a persisted @Muted be
  // dodged by leaving and rejoining during a blip.
  const botId = client.user?.id;
  const [botMember, liveRoles] = await Promise.all([
    botId ? client.rest.get(`/guilds/${guildId}/members/${botId}`).catch(() => null) : null,
    client.rest.get(`/guilds/${guildId}/roles`).catch(() => null),
  ]);
  if (!botMember || !Array.isArray(liveRoles) || !liveRoles.length) {
    logger.warn(`[ROLEPERSIST] Could not load roles for ${guildId}, snapshot for ${userId} kept for the next join`);
    return;
  }

  const posMap        = new Map(liveRoles.map(r => [r.id, r.position ?? 0]));
  const botHighestPos = (botMember.roles ?? []).reduce((max, id) => Math.max(max, posMap.get(id) ?? 0), 0);
  const remaining = [];
  for (const roleId of roleIds) {
    if (!posMap.has(roleId)) continue;                              // role deleted, drop it
    if (posMap.get(roleId) >= botHighestPos) { remaining.push(roleId); continue; } // above the bot, retry after a hierarchy fix
    try {
      await client.rest.put(`/guilds/${guildId}/members/${userId}/roles/${roleId}`);
    } catch (err) {
      remaining.push(roleId);
      logger.warn(`[ROLEPERSIST] Could not restore role ${roleId} to ${userId} in ${guildId}:`, err.message);
    }
  }

  if (remaining.length) stmts.setSnapshotRoles.run(JSON.stringify(remaining), guildId, userId);
  else stmts.deleteSnapshot.run(guildId, userId);
}

export function listSnapshots(guildId) {
  return stmts.listSnapshots.all(guildId).map(r => {
    let roleIds = [];
    try { roleIds = JSON.parse(r.role_ids || '[]'); } catch { /* malformed snapshot */ }
    return { userId: r.user_id, roleIds };
  });
}

// ─── setPersist ───────────────────────────────────────────────────────────────
// Manually write a role snapshot for a user (used by !rolepersist add @user).
export function setPersist(guildId, userId, roleIds, reason, setBy) {
  const ids = Array.isArray(roleIds) ? roleIds : [];
  db.prepare(`
    INSERT OR REPLACE INTO role_persist_snapshots (guild_id, user_id, role_ids, captured_at, reason, added_by)
    VALUES (?, ?, ?, unixepoch(), ?, ?)
  `).run(guildId, userId, JSON.stringify(ids), reason ?? null, setBy ?? null);
}

// ─── removePersist ────────────────────────────────────────────────────────────
export function removePersist(guildId, userId) {
  db.prepare('DELETE FROM role_persist_snapshots WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
}

// ─── getPersist ───────────────────────────────────────────────────────────────
export function getPersist(guildId, userId) {
  const row = db.prepare('SELECT * FROM role_persist_snapshots WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  if (!row) return null;
  let roleIds = [];
  try { roleIds = JSON.parse(row.role_ids || '[]'); } catch { /* corrupt */ }
  return { ...row, roleIds };
}

// ─── getAllPersisted ──────────────────────────────────────────────────────────
export function getAllPersisted(guildId) {
  return db.prepare('SELECT * FROM role_persist_snapshots WHERE guild_id = ? ORDER BY captured_at DESC').all(guildId)
    .map(r => {
      let roleIds = [];
      try { roleIds = JSON.parse(r.role_ids || '[]'); } catch { /* corrupt */ }
      return { ...r, roleIds };
    });
}

// ─── setRoleRule ──────────────────────────────────────────────────────────────
// Mark a role as "always persist on rejoin" regardless of user-level snapshot.
export function setRoleRule(guildId, roleId, reason, setBy) {
  db.prepare(`
    INSERT OR REPLACE INTO role_persist_rules (guild_id, role_id, reason, set_by, set_at)
    VALUES (?, ?, ?, ?, unixepoch())
  `).run(guildId, roleId, reason ?? null, setBy ?? null);
}

// ─── removeRoleRule ───────────────────────────────────────────────────────────
export function removeRoleRule(guildId, roleId) {
  db.prepare('DELETE FROM role_persist_rules WHERE guild_id = ? AND role_id = ?').run(guildId, roleId);
}

// ─── getRoleRule ──────────────────────────────────────────────────────────────
export function getRoleRule(guildId, roleId) {
  return db.prepare('SELECT * FROM role_persist_rules WHERE guild_id = ? AND role_id = ?').get(guildId, roleId) ?? null;
}

// ─── getAllRoleRules ──────────────────────────────────────────────────────────
export function getAllRoleRules(guildId) {
  return db.prepare('SELECT * FROM role_persist_rules WHERE guild_id = ? ORDER BY set_at DESC').all(guildId);
}
