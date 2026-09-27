// ============================================================
//  handlers/serverGroups.js
//
//  "Server groups", named collections of guilds that opt in to
//  share ban/unban syncing (see handlers/banSync.js). A guild may
//  belong to multiple groups. Each guild's membership carries its
//  own sync_bans/sync_unbans toggles, syncing is opt-in per
//  guild, per direction, not an all-or-nothing switch.
// ============================================================

import { randomUUID } from 'crypto';
import db             from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS server_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS server_group_members (
    group_id    TEXT NOT NULL,
    guild_id    TEXT NOT NULL,
    added_by    TEXT NOT NULL,
    added_at    INTEGER NOT NULL,
    sync_bans   INTEGER NOT NULL DEFAULT 1,
    sync_unbans INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (group_id, guild_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sgm_guild ON server_group_members (guild_id);
`);

export function createGroup(name, userId) {
  const id  = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO server_groups (id, name, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, userId, now, now);
  return id;
}

export function getGroup(groupId) {
  return db.prepare(`SELECT * FROM server_groups WHERE id = ?`).get(groupId) ?? null;
}

export function findGroupByName(name) {
  return db.prepare(`SELECT * FROM server_groups WHERE name = ? COLLATE NOCASE`).get(name) ?? null;
}

export function listGroups() {
  return db.prepare(`SELECT * FROM server_groups ORDER BY created_at DESC`).all();
}

export function deleteGroup(groupId) {
  db.prepare(`DELETE FROM server_group_members WHERE group_id = ?`).run(groupId);
  const result = db.prepare(`DELETE FROM server_groups WHERE id = ?`).run(groupId);
  return result.changes > 0;
}

export function addGuildToGroup(groupId, guildId, userId, { syncBans = true, syncUnbans = true } = {}) {
  db.prepare(`
    INSERT INTO server_group_members (group_id, guild_id, added_by, added_at, sync_bans, sync_unbans)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_id, guild_id) DO UPDATE SET
      sync_bans = excluded.sync_bans, sync_unbans = excluded.sync_unbans
  `).run(groupId, guildId, userId, Date.now(), syncBans ? 1 : 0, syncUnbans ? 1 : 0);
  db.prepare(`UPDATE server_groups SET updated_at = ? WHERE id = ?`).run(Date.now(), groupId);
}

export function removeGuildFromGroup(groupId, guildId) {
  const result = db.prepare(`DELETE FROM server_group_members WHERE group_id = ? AND guild_id = ?`).run(groupId, guildId);
  db.prepare(`UPDATE server_groups SET updated_at = ? WHERE id = ?`).run(Date.now(), groupId);
  return result.changes > 0;
}

export function setSyncToggle(groupId, guildId, field, value) {
  if (field !== 'sync_bans' && field !== 'sync_unbans') throw new Error(`Invalid toggle field: ${field}`);
  const result = db.prepare(`UPDATE server_group_members SET ${field} = ? WHERE group_id = ? AND guild_id = ?`)
    .run(value ? 1 : 0, groupId, guildId);
  return result.changes > 0;
}

export function getMembership(groupId, guildId) {
  return db.prepare(`SELECT * FROM server_group_members WHERE group_id = ? AND guild_id = ?`).get(groupId, guildId) ?? null;
}

export function getGroupsForGuild(guildId) {
  return db.prepare(`
    SELECT sg.*, sgm.sync_bans, sgm.sync_unbans
    FROM server_group_members sgm
    JOIN server_groups sg ON sg.id = sgm.group_id
    WHERE sgm.guild_id = ?
    ORDER BY sg.name COLLATE NOCASE
  `).all(guildId);
}

export function getGroupMembers(groupId) {
  return db.prepare(`SELECT * FROM server_group_members WHERE group_id = ? ORDER BY added_at ASC`).all(groupId);
}
