// ─── Staff system, resolved entirely from native Fluxer permissions ─────────
// There is no rank ladder. "Is this person staff" and "can this person do X"
// are answered directly from: BOT_OWNERS (env), real guild ownership (a
// cached native fact from Fluxer's own guild.ownerId), or the member's live
// Fluxer permission bits. Nothing here is stored or configured by staff, it
// is recomputed from Fluxer itself on every check.

import db from '../db.js';
import { getMemberPermissionBits, fetchLiveRoles, isAnyStaffPermission } from '../config/guildPermissions.js';
import { isRealOwner as _isRealOwner, isBotOwner } from '../config/dashAccess.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
// staff_guild_owners caches a native fact (who owns the guild, from Fluxer's
// own guild.ownerId) so ownership doesn't need a REST round-trip on every
// check. It is not a custom rank, it's seeded from Fluxer, never assigned.
db.exec(`
  CREATE TABLE IF NOT EXISTS staff_guild_owners (
    guild_id TEXT PRIMARY KEY,
    user_id  TEXT NOT NULL
  );
`);

const stmts = {
  upsertOwner: db.prepare(`INSERT OR REPLACE INTO staff_guild_owners (guild_id, user_id) VALUES (?, ?)`),
};

// ─── Live permission bits for a member ───────────────────────────────────────
export async function getMemberPermissionBitsLive(client, guildId, userId) {
  if (!guildId || !userId || !client) return 0n;
  try {
    const [memberData, liveRoles] = await Promise.all([
      client.rest.get(`/guilds/${guildId}/members/${userId}`).catch(() => null),
      fetchLiveRoles(client, guildId),
    ]);
    if (!memberData) return 0n;
    const rolesMap  = new Map(liveRoles.map(r => [r.id, r]));
    const fakeGuild = { roles: { get: (id) => rolesMap.get(id) } };
    return getMemberPermissionBits(memberData, fakeGuild);
  } catch {
    return 0n;
  }
}

// ─── Ownership / bot-owner checks ─────────────────────────────────────────────
export async function isRealOwner(guildId, userId) {
  return _isRealOwner(db, guildId, userId);
}
export { isBotOwner };

// ─── isStaff, "does this person have any elevated Fluxer permission" ───────
// Used where the bot only needs a staff/non-staff distinction (e.g. channel
// restriction bypass), not a specific permission bit.
// Cached for 30s per member: automod, the word filter, link enforcement and
// the link auditor each call this on every message, which was ~8 REST calls
// per message in a busy channel. A role change takes effect within 30s.
const STAFF_CACHE_MS = 30_000;
const staffCache = new Map(); // `${guildId}:${userId}` -> { value, at }

export async function isStaff(client, guildId, userId) {
  if (!guildId || !userId) return false;
  if (isBotOwner(userId)) return true;
  if (await isRealOwner(guildId, userId)) return true;
  if (!client) return false;
  const key = `${guildId}:${userId}`;
  const hit = staffCache.get(key);
  if (hit && Date.now() - hit.at < STAFF_CACHE_MS) return hit.value;
  const bits = await getMemberPermissionBitsLive(client, guildId, userId);
  const value = isAnyStaffPermission(bits);
  staffCache.set(key, { value, at: Date.now() });
  if (staffCache.size > 5000) staffCache.delete(staffCache.keys().next().value);
  return value;
}

// ─── setGuildOwner ────────────────────────────────────────────────────────────
// Called from ready.js / guildCreate.js to keep the owner cache current.
export function setGuildOwner(guildId, userId) {
  stmts.upsertOwner.run(guildId, userId);
}

export default { isStaff, isRealOwner, isBotOwner, getMemberPermissionBitsLive, setGuildOwner };
