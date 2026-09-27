// ── Mass role operations: shared log + progress store ───────────────────────
// Used by both commands/moderation/role.js (the "!role mass add @Role all"
// bot-process path, using client.rest) and dashboard/routes/massRoles.js
// (the dashboard-process "All members" path, using a raw rate-limit-aware
// fetch since that process has no live gateway client). Both write to the
// same data/bot.db, so this is the one place either surface's operations
// and per-user grant history live, satisfying "a record of the user and
// the role they're being added to, by whoever issued it" for both paths.
//
// Two tables:
//   mass_role_operations — one row per bulk run: who issued it, from where,
//     what role/action, running progress counters, final status. The
//     dashboard's "All members" flow polls this row for live progress since
//     the HTTP request that started it returns immediately (a run against
//     an 1800+ member server can take several minutes, well past the
//     reverse proxy's 120s read timeout, see nginx/bloo.conf).
//   mass_role_grants — one row per (operation, user) result, the actual
//     per-user audit trail: exactly who got the role, succeeded or failed,
//     from which operation.
import db from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS mass_role_operations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     TEXT    NOT NULL,
    role_id      TEXT    NOT NULL,
    role_name    TEXT,
    action       TEXT    NOT NULL,              -- 'add' | 'remove'
    mode         TEXT    NOT NULL,               -- 'all' | 'ids' | 'filtered'
    filter_role_ids TEXT,                        -- JSON array, only set when mode = 'filtered'
    issued_by    TEXT    NOT NULL,
    issued_via   TEXT    NOT NULL,               -- 'command' | 'dashboard'
    reason       TEXT,
    status       TEXT    NOT NULL DEFAULT 'running', -- 'running'|'completed'|'failed'
    total        INTEGER NOT NULL DEFAULT 0,
    succeeded    INTEGER NOT NULL DEFAULT 0,
    failed       INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    started_at   INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_mro_guild ON mass_role_operations (guild_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS mass_role_grants (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id INTEGER NOT NULL REFERENCES mass_role_operations(id),
    user_id      TEXT    NOT NULL,
    result       TEXT    NOT NULL,               -- 'success' | 'failed'
    error        TEXT,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mrg_operation ON mass_role_grants (operation_id);
  CREATE INDEX IF NOT EXISTS idx_mrg_user      ON mass_role_grants (user_id, created_at DESC);
`);

// Migration: filter_role_ids was added after this table's first release.
try { db.exec(`ALTER TABLE mass_role_operations ADD COLUMN filter_role_ids TEXT`); } catch { /* already exists */ }

const insertOp = db.prepare(`
  INSERT INTO mass_role_operations
    (guild_id, role_id, role_name, action, mode, filter_role_ids, issued_by, issued_via, reason, status, total, started_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
`);
const insertGrant = db.prepare(`
  INSERT INTO mass_role_grants (operation_id, user_id, result, error, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const updateCounts = db.prepare(`
  UPDATE mass_role_operations SET succeeded = ?, failed = ? WHERE id = ?
`);
const updateTotal = db.prepare(`
  UPDATE mass_role_operations SET total = ? WHERE id = ?
`);
const finishOp = db.prepare(`
  UPDATE mass_role_operations SET status = ?, succeeded = ?, failed = ?, error = ?, completed_at = ? WHERE id = ?
`);
const getOp = db.prepare(`SELECT * FROM mass_role_operations WHERE id = ?`);
const listOps = db.prepare(`
  SELECT * FROM mass_role_operations WHERE guild_id = ? ORDER BY started_at DESC LIMIT ?
`);
const getRunningOp = db.prepare(`
  SELECT id FROM mass_role_operations WHERE guild_id = ? AND status = 'running' LIMIT 1
`);

export function createOperation({ guildId, roleId, roleName, action, mode, filterRoleIds, issuedBy, issuedVia, reason, total }) {
  const result = insertOp.run(
    guildId, roleId, roleName ?? null, action, mode,
    filterRoleIds?.length ? JSON.stringify(filterRoleIds) : null,
    issuedBy, issuedVia, reason ?? null, total ?? 0, Math.floor(Date.now() / 1000)
  );
  return result.lastInsertRowid;
}

export function recordGrant(operationId, userId, ok, error = null) {
  insertGrant.run(operationId, userId, ok ? 'success' : 'failed', error, Math.floor(Date.now() / 1000));
}

export function updateProgress(operationId, succeeded, failed) {
  updateCounts.run(succeeded, failed, operationId);
}

// Called once the member list is actually known: createOperation() starts
// an "all" mode operation at total=0 (list not fetched yet), so a poller
// can distinguish "still fetching the member list" (total=0, running) from
// "processing" (total>0, running).
export function setOperationTotal(operationId, total) {
  updateTotal.run(total, operationId);
}

export function completeOperation(operationId, { succeeded, failed, error = null }) {
  finishOp.run(error ? 'failed' : 'completed', succeeded, failed, error, Math.floor(Date.now() / 1000), operationId);
}

export function getOperation(operationId) {
  return getOp.get(operationId);
}

export function listOperationsForGuild(guildId, limit = 20) {
  return listOps.all(guildId, limit);
}

// Prevents two "all members" runs stacking up against the same guild at
// once, both a correctness issue (progress counters would interleave
// between two operation rows) and the "no point of exposure" ask, since
// without this a compromised/careless session could kick off repeated
// full-member-list sweeps back to back.
export function hasRunningOperation(guildId) {
  return !!getRunningOp.get(guildId);
}
