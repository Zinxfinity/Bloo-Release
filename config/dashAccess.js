// ─── Dashboard access: explicit grants and chosen roles ─────────────────────────
// Unlike bot commands (gated by real Fluxer permission bits), dashboard access
// never follows Fluxer permissions: a user has zero dashboard access unless
// the Server Owner (or an existing co_owner-tier holder) grants it, either to
// that person (`b!dash add`) or to one of up to three chosen roles per tier
// (`b!dash role add`). The real Fluxer guild owner and env-listed bot owners
// always get full (co_owner-equivalent) access with no grant needed.
//
// This module takes a `db` handle as its first argument on every function so
// the bot process, bloodash/dashboard, and dashboard/server.js, three separate
// processes, each with their own better-sqlite3 connection to the same
// data/bot.db file, all derive access the exact same way instead of each
// forking its own copy (the problem this replaces: bloodash/dashboard/lib/rank.js and
// dashboard/server.js used to duplicate this logic independently).

// `||` not `??`: a blank FLUXER_API= line in .env is still a non-null empty
// string, which `??` would happily keep instead of falling back.
const FLUXER_API_BASE = process.env.FLUXER_API || 'https://api.fluxer.app';

export function isBotOwner(userId) {
  return (process.env.BOT_OWNERS ?? '').split(',').map(s => s.trim()).filter(Boolean).includes(userId);
}

// ─── isRealOwner ──────────────────────────────────────────────────────────────
// Checks the cached native fact (staff_guild_owners, seeded on ready/guildCreate)
// first; falls back to a live Fluxer fetch + backfill if the cache hasn't
// caught up yet (e.g. a guild added right as the bot restarts).
// The live owner id per guild, kept five minutes, so checking someone who
// isn't the owner doesn't cost a Fluxer call every time (access is checked
// several times per page load).
const ownerCache = new Map();
const OWNER_TTL = 5 * 60_000;
const ownerFailLogged = new Map();

export async function isRealOwner(db, guildId, userId) {
  if (typeof guildId !== 'string' || typeof userId !== 'string') return false;

  const ownerRow = db.prepare(
    `SELECT 1 FROM staff_guild_owners WHERE guild_id = ? AND user_id = ?`
  ).get(guildId, userId);
  if (ownerRow) return true;

  const cached = ownerCache.get(guildId);
  if (cached && Date.now() < cached.until) return cached.ownerId === userId;

  try {
    const r = await fetch(`${FLUXER_API_BASE}/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${process.env.FLUXER_BOT_TOKEN}` },
    });
    if (!r.ok) {
      // Say why, once a minute per server at most: this used to fail
      // silently and show the real owner "No Access".
      const last = ownerFailLogged.get(guildId) ?? 0;
      if (Date.now() - last > 60_000) {
        ownerFailLogged.set(guildId, Date.now());
        console.warn(`[dashAccess] Owner lookup for guild ${guildId} failed: Fluxer answered ${r.status}`);
      }
      return false;
    }
    const guild = await r.json();
    ownerCache.set(guildId, { ownerId: guild.owner_id, until: Date.now() + OWNER_TTL });
    if (ownerCache.size > 2000) ownerCache.delete(ownerCache.keys().next().value);
    if (guild.owner_id !== userId) return false;
    try {
      db.prepare(`INSERT OR IGNORE INTO staff_guild_owners (guild_id, user_id) VALUES (?, ?)`).run(guildId, userId);
    } catch { /* staff_guild_owners not created yet */ }
    return true;
  } catch {
    return false;
  }
}

// ─── Tiers ────────────────────────────────────────────────────────────────────
export const DASH_TIERS = ['viewer', 'mod', 'admin', 'co_owner'];
const TIER_SET = new Set(DASH_TIERS);
export function isValidTier(tier) { return TIER_SET.has(tier); }

// Pages sensitive enough that viewer/mod are always capped at View Only (1),
// regardless of any per-tier override. admin/co_owner are NOT capped here —
// confirmed intentional: Admin is meant to reach these pages, only the
// lowest two tiers are restricted.
export const DASH_CRITICAL_PAGES = new Set([
  'settings-bans', 'settings-antiraid', 'security-lockdown', 'staffranks',
]);

const DASH_TIER_DEFAULT_ACCESS = { viewer: 0, mod: 1, admin: 2, co_owner: 3 };

// ─── Schema ───────────────────────────────────────────────────────────────────
export function ensureDashAccessSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dash_user_access (
      guild_id   TEXT    NOT NULL,
      user_id    TEXT    NOT NULL,
      tier       TEXT    NOT NULL,
      granted_by TEXT    NOT NULL,
      granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS dash_tier_page_perms (
      guild_id     TEXT    NOT NULL,
      page_id      TEXT    NOT NULL,
      tier         TEXT    NOT NULL,
      access_level INTEGER NOT NULL DEFAULT 0,
      updated_by   TEXT,
      updated_at   INTEGER,
      PRIMARY KEY (guild_id, page_id, tier)
    );
    CREATE TABLE IF NOT EXISTS dash_migration_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS dash_role_access (
      guild_id   TEXT    NOT NULL,
      role_id    TEXT    NOT NULL,
      tier       TEXT    NOT NULL,
      granted_by TEXT    NOT NULL,
      granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (guild_id, role_id)
    );
  `);
}

// ─── Role grants ──────────────────────────────────────────────────────────────
// A server can also give a dashboard tier to up to MAX_ROLES_PER_TIER Fluxer
// roles per tier, so staff get access by holding a role instead of one
// grant at a time. Anyone who can hand out that role on Fluxer can therefore
// hand out that tier, which is why only the Server Owner may tie a role to
// Co-Owner (enforced by callers through canManageRoleTier below).
export const MAX_ROLES_PER_TIER = 3;
const rank = tier => DASH_TIERS.indexOf(tier);
const higher = (a, b) => (a == null ? b : b == null ? a : rank(a) >= rank(b) ? a : b);

export class DashRoleError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

export function listRoleGrants(db, guildId) {
  return db.prepare(`SELECT role_id, tier, granted_by, granted_at FROM dash_role_access WHERE guild_id = ? ORDER BY granted_at`).all(guildId);
}

export function grantRoleTier(db, guildId, roleId, tier, grantedBy) {
  if (!isValidTier(tier)) throw new DashRoleError(`Invalid dashboard tier: ${tier}`);
  if (!/^\d{17,20}$/.test(String(roleId))) throw new DashRoleError('A valid role is required.');
  if (String(roleId) === String(guildId)) throw new DashRoleError('@everyone can\'t be given dashboard access.');
  const taken = db.prepare(`SELECT COUNT(*) AS n FROM dash_role_access WHERE guild_id = ? AND tier = ? AND role_id != ?`).get(guildId, tier, roleId).n;
  if (taken >= MAX_ROLES_PER_TIER) throw new DashRoleError(`The ${tier.replace('_', '-')} tier already has ${MAX_ROLES_PER_TIER} roles. Remove one first.`);
  db.prepare(`
    INSERT INTO dash_role_access (guild_id, role_id, tier, granted_by, granted_at) VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT (guild_id, role_id) DO UPDATE SET tier = excluded.tier, granted_by = excluded.granted_by, granted_at = excluded.granted_at
  `).run(guildId, String(roleId), tier, grantedBy);
  clearMemberRoleCache(guildId);
}

export function revokeRoleTier(db, guildId, roleId) {
  const removed = db.prepare(`DELETE FROM dash_role_access WHERE guild_id = ? AND role_id = ?`).run(guildId, String(roleId)).changes > 0;
  clearMemberRoleCache(guildId);
  return removed;
}

// Co-Owner is only for the Server Owner (and bot owners) to hand out through
// a role, and only they may change a role that currently grants it.
export async function canManageRoleTier(db, guildId, actorId, tier, roleId) {
  const current = roleId ? db.prepare(`SELECT tier FROM dash_role_access WHERE guild_id = ? AND role_id = ?`).get(guildId, String(roleId))?.tier : null;
  if (tier !== 'co_owner' && current !== 'co_owner') return true;
  return isBotOwner(actorId) || await isRealOwner(db, guildId, actorId);
}

// Member roles, cached for a minute so a page load that checks access many
// times makes one Fluxer call. A role change reaches the dashboard within
// that minute; failed lookups are retried after 10 seconds.
const roleCache = new Map();
const ROLE_TTL = 60_000, FAIL_TTL = 10_000;
export function clearMemberRoleCache(guildId) {
  for (const key of roleCache.keys()) if (!guildId || key.startsWith(`${guildId}:`)) roleCache.delete(key);
}
async function memberRoles(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const hit = roleCache.get(key);
  if (hit && Date.now() < hit.until) return hit.roles;
  let roles = [], ok = false;
  try {
    const r = await fetch(`${FLUXER_API_BASE}/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${process.env.FLUXER_BOT_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    ok = r.ok || r.status === 404; // 404: not in the server, so no roles
    if (r.ok) roles = (await r.json()).roles ?? [];
  } catch { /* network trouble: no role access until the retry */ }
  roleCache.set(key, { roles, until: Date.now() + (ok ? ROLE_TTL : FAIL_TTL) });
  if (roleCache.size > 5000) roleCache.delete(roleCache.keys().next().value);
  return roles;
}

// ─── Bot roles ────────────────────────────────────────────────────────────────
// Fluxer's role data doesn't say whether a role belongs to a bot, so it's
// worked out from who holds it: a role held only by bot accounts is a bot
// role (Bloo's own, or another bot's). That needs the member list; when
// Fluxer won't give it, Bloo's own roles named after it are still caught.
// Bot roles can't be given dashboard access. Results are kept 10 minutes.
const API_HEADERS = () => ({ Authorization: `Bot ${process.env.FLUXER_BOT_TOKEN}` });
let botUser = null, botUserUntil = 0;
async function getBotUser() {
  if (botUser && Date.now() < botUserUntil) return botUser;
  try {
    const r = await fetch(`${FLUXER_API_BASE}/users/@me`, { headers: API_HEADERS(), signal: AbortSignal.timeout(5000) });
    if (r.ok) { const u = await r.json(); botUser = { id: u.id, name: u.global_name || u.username }; botUserUntil = Date.now() + 3_600_000; }
  } catch { /* try again next time */ }
  return botUser;
}
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const botRoleCache = new Map();

// Map of roleId → the bot's name, for the given guild.
export async function findBotRoles(guildId, roles = []) {
  const hit = botRoleCache.get(guildId);
  if (hit && Date.now() < hit.until) return hit.map;
  const found = new Map();
  let complete = false;
  try {
    const byBot = new Map(), byHuman = new Set();
    let after = '0';
    for (let page = 0; page < 5; page++) {
      const r = await fetch(`${FLUXER_API_BASE}/guilds/${guildId}/members?limit=1000&after=${after}`, { headers: API_HEADERS(), signal: AbortSignal.timeout(8000) });
      if (!r.ok) break;
      const batch = await r.json();
      if (!Array.isArray(batch)) break;
      for (const m of batch) {
        for (const roleId of m.roles ?? []) {
          if (m.user?.bot) { if (!byBot.has(roleId)) byBot.set(roleId, m.user.global_name || m.user.username || 'a bot'); }
          else byHuman.add(roleId);
        }
      }
      if (batch.length < 1000) { complete = true; break; }
      after = batch[batch.length - 1].user?.id ?? batch[batch.length - 1].id;
    }
    if (complete) for (const [roleId, name] of byBot) if (!byHuman.has(roleId)) found.set(roleId, name);
  } catch { /* fall back below */ }

  // Always: Bloo's own roles that carry its name.
  const me = await getBotUser();
  if (me) {
    try {
      if (!roles.length) {
        const rr = await fetch(`${FLUXER_API_BASE}/guilds/${guildId}/roles`, { headers: API_HEADERS(), signal: AbortSignal.timeout(5000) });
        if (rr.ok) roles = await rr.json();
      }
      const r = await fetch(`${FLUXER_API_BASE}/guilds/${guildId}/members/${me.id}`, { headers: API_HEADERS(), signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const mine = new Set((await r.json()).roles ?? []);
        for (const role of roles) if (mine.has(role.id) && norm(role.name) && norm(role.name) === norm(me.name)) found.set(role.id, me.name);
      }
    } catch { /* best effort */ }
  }
  botRoleCache.set(guildId, { map: found, until: Date.now() + (complete ? 600_000 : 60_000) });
  return found;
}

// The best tier any of the member's roles gives, and which role gives it.
export async function getRoleTier(db, guildId, userId) {
  const grants = listRoleGrants(db, guildId);
  if (!grants.length) return null; // no Fluxer call for servers not using this
  const roles = new Set(await memberRoles(guildId, userId));
  let best = null;
  for (const g of grants) if (roles.has(g.role_id) && (!best || rank(g.tier) > rank(best.tier))) best = g;
  return best ? { tier: best.tier, roleId: best.role_id } : null;
}

// ─── Access resolution ────────────────────────────────────────────────────────
// Where someone's tier comes from: owner (real or bot owner), an explicit
// grant, or a role. When a person has both a grant and a role, the higher
// tier wins, so a role can raise access but never lower a grant.
export async function resolveDashTier(db, guildId, userId) {
  if (isBotOwner(userId)) return { tier: 'co_owner', via: 'owner' };
  if (await isRealOwner(db, guildId, userId)) return { tier: 'co_owner', via: 'owner' };
  const grant = db.prepare(`SELECT tier FROM dash_user_access WHERE guild_id = ? AND user_id = ?`).get(guildId, userId)?.tier ?? null;
  const role = await getRoleTier(db, guildId, userId);
  const tier = higher(grant, role?.tier ?? null);
  if (tier == null) return { tier: null, via: null };
  return tier === grant ? { tier, via: 'grant' } : { tier, via: 'role', roleId: role.roleId };
}

export async function getDashTier(db, guildId, userId) {
  return (await resolveDashTier(db, guildId, userId)).tier; // null = zero access, no implicit tier
}

export function getDashAccess(db, guildId, tier, pageId) {
  if (tier == null) return 0;
  if (tier === 'co_owner') return 3;
  const row = db.prepare(
    `SELECT access_level FROM dash_tier_page_perms WHERE guild_id = ? AND page_id = ? AND tier = ?`
  ).get(guildId, pageId, tier);
  let level = row ? row.access_level : (DASH_TIER_DEFAULT_ACCESS[tier] ?? 0);
  if (DASH_CRITICAL_PAGES.has(pageId) && (tier === 'viewer' || tier === 'mod')) level = Math.min(level, 1);
  return level;
}

export async function hasDashAccess(db, guildId, userId, pageId, minLevel) {
  const tier = await getDashTier(db, guildId, userId);
  if (tier == null) return false;
  return getDashAccess(db, guildId, tier, pageId) >= minLevel;
}

export async function hasDashTier(db, guildId, userId, minTier) {
  const tier = await getDashTier(db, guildId, userId);
  return tier != null && DASH_TIERS.indexOf(tier) >= DASH_TIERS.indexOf(minTier);
}

// ─── Grant management (backs `b!dash add/remove/list`) ───────────────────────
export function grantDashTier(db, guildId, userId, tier, grantedBy) {
  if (!isValidTier(tier)) throw new Error(`Invalid dashboard tier: ${tier}`);
  db.prepare(`
    INSERT INTO dash_user_access (guild_id, user_id, tier, granted_by, granted_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      tier = excluded.tier, granted_by = excluded.granted_by, granted_at = excluded.granted_at
  `).run(guildId, userId, tier, grantedBy);
}

export function revokeDashTier(db, guildId, userId) {
  const result = db.prepare(`DELETE FROM dash_user_access WHERE guild_id = ? AND user_id = ?`).run(guildId, userId);
  return result.changes > 0;
}

export function listDashGrants(db, guildId) {
  return db.prepare(
    `SELECT user_id, tier, granted_by, granted_at FROM dash_user_access WHERE guild_id = ? ORDER BY granted_at`
  ).all(guildId);
}

// ─── Migration: dash_page_perms (rank-keyed) → dash_tier_page_perms (tier-keyed) ───
// Deliberately conservative ("under-migrate"): carries forward only what was
// already durably recorded as a page-level customization. Does NOT attempt to
// auto-discover who should hold a tier from live Fluxer role scans, Server
// Owners restore staff access explicitly via `b!dash add` after this runs.
function rankToTier(rank) {
  if (rank >= 8) return 'co_owner';
  if (rank >= 5) return 'admin';
  if (rank >= 2) return 'mod';
  return 'viewer';
}

export function runDashAccessMigration(db) {
  ensureDashAccessSchema(db);

  const marker = db.prepare(`SELECT value FROM dash_migration_state WHERE key = 'dash_tier_migration_v1'`).get();
  if (marker) return;

  let oldRows = [];
  try {
    oldRows = db.prepare(`SELECT guild_id, page_id, rank, access_level FROM dash_page_perms`).all();
  } catch { /* dash_page_perms never existed on this install */ }

  const insert = db.prepare(`
    INSERT INTO dash_tier_page_perms (guild_id, page_id, tier, access_level, updated_by, updated_at)
    VALUES (?, ?, ?, ?, 'migration', unixepoch())
    ON CONFLICT (guild_id, page_id, tier) DO UPDATE SET access_level = MAX(access_level, excluded.access_level)
  `);
  for (const row of oldRows) {
    if (row.rank >= 10) continue; // server owner / bot owner rows, ownership isn't tier-based
    insert.run(row.guild_id, row.page_id, rankToTier(row.rank), row.access_level);
  }

  db.prepare(`INSERT OR REPLACE INTO dash_migration_state (key, value) VALUES ('dash_tier_migration_v1', unixepoch())`).run();
}
