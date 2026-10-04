// ─── Command permissions ────────────────────────────────────────────────────
// Every command's access requirement is a direct Fluxer permission (or the
// SERVER_OWNER/BOT_OWNER sentinels, which have no permission-bit equivalent),
// never a Bloo-assigned rank. A guild can override any command's requirement
// to a different permission, or lock it to one exact role regardless of that
// role's own permissions.

import db from '../db.js';
import { getMemberPermissionBits, fetchLiveRoles, Permissions } from '../config/guildPermissions.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS command_permissions (
    guild_id       TEXT    NOT NULL,
    command_name   TEXT    NOT NULL,
    required_type  TEXT,   -- 'permission' | 'role' | NULL (use the command's built-in default)
    required_value TEXT,   -- permission bit as a decimal string, or a role ID
    disabled       INTEGER NOT NULL DEFAULT 0,
    disabled_msg   TEXT,
    set_by         TEXT    NOT NULL,
    set_at         INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (guild_id, command_name)
  )
`);

// ─── Schema migrations, run before ANY db.prepare() call ────────────────────
// required_rank is old (pre-Fluxer-permissions) dead weight, kept only so
// existing rows aren't dropped, nothing reads it anymore.
for (const col of [
  `ALTER TABLE command_permissions ADD COLUMN required_rank INTEGER`,
  `ALTER TABLE command_permissions ADD COLUMN required_type TEXT`,
  `ALTER TABLE command_permissions ADD COLUMN required_value TEXT`,
  `ALTER TABLE command_permissions ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE command_permissions ADD COLUMN disabled_msg TEXT`,
  `ALTER TABLE command_permissions ADD COLUMN set_by TEXT NOT NULL DEFAULT 'system'`,
  `ALTER TABLE command_permissions ADD COLUMN set_at INTEGER NOT NULL DEFAULT 0`,
]) { try { db.exec(col); } catch { /* already exists */ } }

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  get: db.prepare(`
    SELECT required_type, required_value, disabled, disabled_msg
    FROM command_permissions
    WHERE guild_id = ? AND command_name = ?
  `),
  upsert: db.prepare(`
    INSERT OR REPLACE INTO command_permissions
      (guild_id, command_name, required_type, required_value, disabled, disabled_msg, set_by, set_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
  `),
  delete: db.prepare(`
    DELETE FROM command_permissions WHERE guild_id = ? AND command_name = ?
  `),
  list: db.prepare(`
    SELECT command_name, required_type, required_value, disabled, disabled_msg, set_by, set_at
    FROM command_permissions
    WHERE guild_id = ?
    ORDER BY command_name
  `),
};

function isCachedServerOwner(guildId, userId) {
  try {
    return !!db.prepare('SELECT 1 FROM staff_guild_owners WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  } catch { return false; }
}

// ─── checkCommandAccess ───────────────────────────────────────────────────────
/**
 * Check whether a user can run a command in a guild.
 * Returns { allowed, reason, disabled, requiredPermission?, requiredRole? }.
 * `requiredPermission`/`requiredRole`, when present, still need a live REST
 * check (member roles can't be verified synchronously), see resolveAccess()
 * below, or commandHandler.js's Gate 3 which does the same for the main
 * command dispatch path.
 *
 * `defaultPermission` is the command's own built-in requirement: a
 * `Permissions.X` bigint, `null` (everyone), or the strings 'SERVER_OWNER' /
 * 'BOT_OWNER'.
 */
export function checkCommandAccess(guildId, userId, commandName, defaultPermission) {
  const row = stmts.get.get(guildId, commandName);

  // Bot Owner (env) always passes, regardless of any override or built-in
  // default, for every command, that's the actual developer.
  const botOwners = (process.env.BOT_OWNERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (botOwners.includes(userId)) return { allowed: true, reason: null, disabled: false };

  // Disabled applies to everyone except the bot owner and the server owner
  // (checked below). It used to come first, so `!permissions disable
  // permissions` locked the server owner out with no way back in via chat.
  const serverOwner = defaultPermission !== 'BOT_OWNER' && isCachedServerOwner(guildId, userId);
  if (row?.disabled && !serverOwner) {
    return { allowed: false, reason: row.disabled_msg ?? null, disabled: true };
  }

  // 'BOT_OWNER' means the actual bot developer, nobody else, full stop.
  // This must return before the real-owner check and the override checks
  // below, previously it didn't: any cached real owner of any guild the
  // bot is in got blanket access to every BOT_OWNER-gated command in the
  // codebase (eval, globalban, maintenance, etc.), and separately a guild
  // admin could downgrade one via !permissions permission/role to whatever
  // they wanted. Both were real, not theoretical, confirmed !eval (arbitrary
  // code execution) was reachable either way. 'SERVER_OWNER' is unaffected,
  // that tier is specifically meant to include this guild's real owner.
  if (defaultPermission === 'BOT_OWNER') {
    return { allowed: false, reason: null, disabled: false };
  }

  // Server Owner (cached native fact) always passes for anything else.
  if (serverOwner) return { allowed: true, reason: null, disabled: false };

  // Per-guild override takes precedence over the command's built-in default
  if (row?.required_type === 'role' && row.required_value) {
    return { allowed: true, reason: null, disabled: false, requiredRole: row.required_value };
  }
  if (row?.required_type === 'permission' && row.required_value) {
    return { allowed: true, reason: null, disabled: false, requiredPermission: BigInt(row.required_value) };
  }

  // Built-in default
  if (defaultPermission == null) return { allowed: true, reason: null, disabled: false }; // everyone
  if (defaultPermission === 'SERVER_OWNER') {
    // Already checked above and failed
    return { allowed: false, reason: null, disabled: false };
  }
  return { allowed: true, reason: null, disabled: false, requiredPermission: defaultPermission };
}

// ─── setCommandPermission ─────────────────────────────────────────────────────
export function setCommandPermission(guildId, commandName, permissionFlag, setBy = 'system') {
  const existing = stmts.get.get(guildId, commandName);
  stmts.upsert.run(
    guildId, commandName, 'permission', String(permissionFlag),
    existing?.disabled ?? 0, existing?.disabled_msg ?? null, setBy,
  );
}

// ─── setCommandRole ───────────────────────────────────────────────────────────
export function setCommandRole(guildId, commandName, roleId, setBy = 'system') {
  const existing = stmts.get.get(guildId, commandName);
  stmts.upsert.run(
    guildId, commandName, 'role', roleId,
    existing?.disabled ?? 0, existing?.disabled_msg ?? null, setBy,
  );
}

// ─── disableCommand ───────────────────────────────────────────────────────────
export function disableCommand(guildId, commandName, setBy = 'system', disabledMsg = null) {
  const existing = stmts.get.get(guildId, commandName);
  stmts.upsert.run(
    guildId, commandName, existing?.required_type ?? null, existing?.required_value ?? null,
    1, disabledMsg, setBy,
  );
}

// ─── enableCommand ────────────────────────────────────────────────────────────
export function enableCommand(guildId, commandName, setBy = 'system') {
  const existing = stmts.get.get(guildId, commandName);
  if (!existing) return;
  stmts.upsert.run(
    guildId, commandName, existing.required_type, existing.required_value,
    0, null, setBy,
  );
}

// ─── resetCommand ─────────────────────────────────────────────────────────────
export function resetCommand(guildId, commandName) {
  stmts.delete.run(guildId, commandName);
}

// ─── listOverrides ────────────────────────────────────────────────────────────
export function listOverrides(guildId) {
  return stmts.list.all(guildId);
}

// ─── getCommandConfig ─────────────────────────────────────────────────────────
export function getCommandConfig(guildId, commandName) {
  return stmts.get.get(guildId, commandName) ?? null;
}

// ─── resolveAccess ────────────────────────────────────────────────────────────
// Async helper for sub-command gates inside command execute() functions.
// Returns true if the user is allowed, false if denied. Fails secure.
export async function resolveAccess(client, guildId, userId, commandName, defaultPermission) {
  const access = checkCommandAccess(guildId, userId, commandName, defaultPermission);
  if (!access.allowed) return false;
  if (access.requiredRole) return hasRoleLive(client, guildId, userId, access.requiredRole);
  if (access.requiredPermission) return hasPermissionLive(client, guildId, userId, access.requiredPermission);
  return true;
}

// ─── Live checks (shared by resolveAccess and commandHandler.js's Gate 3) ────
export async function hasPermissionLive(client, guildId, userId, requiredFlag) {
  try {
    const [memberData, liveRoles] = await Promise.all([
      client.rest.get(`/guilds/${guildId}/members/${userId}`).catch(() => null),
      fetchLiveRoles(client, guildId),
    ]);
    if (!memberData) return false;
    const rolesMap  = new Map(liveRoles.map(r => [r.id, r]));
    const fakeGuild = { roles: { get: (id) => rolesMap.get(id) } };
    const bits      = getMemberPermissionBits(memberData, fakeGuild);
    const ADMIN     = 1n << 3n;
    return (bits & ADMIN) !== 0n || (bits & requiredFlag) !== 0n;
  } catch { return false; }
}

export async function hasRoleLive(client, guildId, userId, roleId) {
  try {
    const member = await client.rest.get(`/guilds/${guildId}/members/${userId}`).catch(() => null);
    return !!member?.roles?.includes(roleId);
  } catch { return false; }
}

// ─── requirementLabel ─────────────────────────────────────────────────────────
// What a command needs in this server, for refusal messages: a role mention
// or permission name from a per-server override, otherwise the default.
// requirementPhrase() wraps it as "the @Mod role" / "the **Kick Members** permission".
const PERM_NAMES = new Map([
  [Permissions.KICK_MEMBERS,     'Kick Members'],
  [Permissions.BAN_MEMBERS,      'Ban Members'],
  [Permissions.MANAGE_GUILD,     'Manage Server'],
  [Permissions.MANAGE_MESSAGES,  'Manage Messages'],
  [Permissions.MANAGE_CHANNELS,  'Manage Channels'],
  [Permissions.MANAGE_ROLES,     'Manage Roles'],
  [Permissions.MANAGE_WEBHOOKS,  'Manage Webhooks'],
  [Permissions.MODERATE_MEMBERS, 'Timeout Members'],
  [Permissions.ADMINISTRATOR,    'Administrator'],
]);

export function requirementLabel(guildId, commandName, defaultPermission) {
  const cfg = getCommandConfig(guildId, commandName);
  if (cfg?.required_type === 'role' && cfg.required_value) return `<@&${cfg.required_value}>`;
  if (cfg?.required_type === 'permission' && cfg.required_value) return PERM_NAMES.get(BigInt(cfg.required_value)) ?? 'Unknown Permission';
  if (defaultPermission === 'SERVER_OWNER') return 'Server Owner';
  if (defaultPermission === 'BOT_OWNER') return 'Bot Owner';
  if (defaultPermission == null) return 'Everyone';
  return PERM_NAMES.get(defaultPermission) ?? 'Unknown Permission';
}

export function requirementPhrase(guildId, commandName, defaultPermission) {
  const label = requirementLabel(guildId, commandName, defaultPermission);
  if (label.startsWith('<@&')) return `the ${label} role`;
  if (['Server Owner', 'Bot Owner'].includes(label)) return `the ${label}`;
  return `the **${label}** permission`;
}
