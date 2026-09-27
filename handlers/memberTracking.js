import db from '../db.js';

// v3's GuildMemberRemove delivers member as a PartialGuildMember (id, user,
// guild only, per @fluxerjs/core's own type comment: "not joinedAt, roles,
// or member methods"), even for members who'd been in the guild a long
// time, not just genuinely-uncached ones. Role-persist (snapshotRoles) and
// the modlog "time in server" figure (logMemberLeave) both depend on data
// the leave event itself can no longer supply, so this tracks it
// independently: joinedAt captured once at GuildMemberAdd, roleIds kept in
// sync on every GuildMemberUpdate, both read back at leave time instead of
// trusting the now-partial member object passed to GuildMemberRemove.
db.exec(`
  CREATE TABLE IF NOT EXISTS member_tracking (
    guild_id   TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    joined_at  INTEGER,
    role_ids   TEXT    NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (guild_id, user_id)
  );
`);

const stmts = {
  upsertJoin: db.prepare(`
    INSERT INTO member_tracking (guild_id, user_id, joined_at, role_ids, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      joined_at  = excluded.joined_at,
      role_ids   = excluded.role_ids,
      updated_at = excluded.updated_at
  `),
  upsertRoles: db.prepare(`
    INSERT INTO member_tracking (guild_id, user_id, role_ids, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      role_ids   = excluded.role_ids,
      updated_at = excluded.updated_at
  `),
  get: db.prepare(`SELECT joined_at, role_ids FROM member_tracking WHERE guild_id = ? AND user_id = ?`),
};

// Called on GuildMemberAdd, member is always a full (non-partial) object there.
export function recordMemberJoin(guildId, userId, joinedAtMs, roleIds = []) {
  if (!guildId || !userId) return;
  const joinedAtSec = joinedAtMs ? Math.floor(joinedAtMs / 1000) : null;
  stmts.upsertJoin.run(guildId, userId, joinedAtSec, JSON.stringify(roleIds));
}

// Called on GuildMemberUpdate whenever a role diff is detected, keeps the
// snapshot fresh for whenever this member eventually leaves.
export function updateMemberRoles(guildId, userId, roleIds) {
  if (!guildId || !userId) return;
  stmts.upsertRoles.run(guildId, userId, JSON.stringify(roleIds));
}

export function getTrackedMember(guildId, userId) {
  if (!guildId || !userId) return null;
  const row = stmts.get.get(guildId, userId);
  if (!row) return null;
  let roleIds = [];
  try { roleIds = JSON.parse(row.role_ids || '[]'); } catch { /* malformed */ }
  return {
    joinedAt: row.joined_at ? new Date(row.joined_at * 1000) : null,
    roleIds,
  };
}
