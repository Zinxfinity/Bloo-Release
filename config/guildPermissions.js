// ─── Fluxer permission flags (bigint, v1.3) ─────────────────────────────────
export const Permissions = Object.freeze({
  ADMINISTRATOR:    1n << 3n,
  KICK_MEMBERS:     1n << 1n,
  BAN_MEMBERS:      1n << 2n,
  MANAGE_CHANNELS:  1n << 4n,
  MANAGE_GUILD:     1n << 5n,
  VIEW_CHANNEL:     1n << 10n,
  SEND_MESSAGES:    1n << 11n,
  MANAGE_MESSAGES:  1n << 13n,
  EMBED_LINKS:      1n << 14n,
  ATTACH_FILES:     1n << 15n,
  READ_HISTORY:     1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  MANAGE_ROLES:     1n << 28n,
  MANAGE_WEBHOOKS:  1n << 29n,
  MODERATE_MEMBERS: 1n << 40n,
});

// ─── Role ID array from member (cross-version safe) ───────────────────────────
export function getMemberRoleIds(member) {
  if (!member) return [];
  // v1.3: GuildMemberRoleManager
  if (member.roles?.roleIds) return member.roles.roleIds;
  // v1.3 cache
  if (member.roles?.cache?.keys) return [...member.roles.cache.keys()];
  // v1.2.2 plain array fallback
  if (Array.isArray(member.roles)) return member.roles;
  return [];
}

// ─── Compute merged permission bitfield for a member ─────────────────────────
export function getMemberPermissionBits(member, guild) {
  let bits = 0n;
  const roleIds = getMemberRoleIds(member);
  for (const roleId of roleIds) {
    const role = guild?.roles?.get?.(roleId);
    if (!role) continue;
    try {
      const p = role.permissions?.toJSON?.() ?? role.permissions;
      if (p != null) bits |= BigInt(p);
    } catch { /* skip malformed */ }
  }
  // Administrator flag implies all permissions
  if ((bits & Permissions.ADMINISTRATOR) !== 0n) {
    return Object.values(Permissions).reduce((a, b) => a | b, 0n);
  }
  return bits;
}

export function hasGuildPermission(member, guild, flag) {
  return (getMemberPermissionBits(member, guild) & flag) !== 0n;
}

// ─── Is this member any kind of staff at all? ────────────────────────────────
// Used where the bot only needs "is this person staff-ish" (e.g. channel
// restriction bypass), not a specific permission. ORs every
// moderation-relevant flag together, deliberately excludes purely
// cosmetic/utility flags like MANAGE_WEBHOOKS or EMBED_LINKS.
export function isAnyStaffPermission(bits) {
  const STAFF_FLAGS = Permissions.KICK_MEMBERS | Permissions.BAN_MEMBERS
    | Permissions.MANAGE_GUILD | Permissions.MANAGE_CHANNELS
    | Permissions.MANAGE_MESSAGES | Permissions.MANAGE_ROLES
    | Permissions.MODERATE_MEMBERS | Permissions.ADMINISTRATOR;
  return (bits & STAFF_FLAGS) !== 0n;
}

// ─── Fetch live role positions from REST ──────────────────────────────────────
export async function fetchLiveRoles(client, guildId) {
  try {
    const roles = await client.rest.get(`/guilds/${guildId}/roles`);
    return Array.isArray(roles) ? roles : [];
  } catch {
    return [];
  }
}

// ─── Build position map from live roles ───────────────────────────────────────
export function buildPosMap(liveRoles) {
  return new Map(liveRoles.map(r => [r.id, r.position ?? 0]));
}

// ─── Highest role position for a set of role IDs ──────────────────────────────
export function highestPosition(roleIds, posMap) {
  return roleIds.reduce((max, id) => Math.max(max, posMap.get(id) ?? 0), 0);
}

// ─── Can executor act on target member (live hierarchy) ───────────────────────
export async function canActOnLive(client, guildId, executorIdOrMember, targetIdOrMember) {
  // Two supported signatures:
  //   canActOnLive(client, guildId, executorId, targetId)
  //   canActOnLive(client, guildId, executorMember, targetMember)   // legacy
  const liveRoles = await fetchLiveRoles(client, guildId);
  const posMap    = buildPosMap(liveRoles);

  let execRoleIds, targetRoleIds;

  const isStringId = (v) => typeof v === 'string' && /^\d{17,20}$/.test(v);

  if (isStringId(executorIdOrMember) && isStringId(targetIdOrMember)) {
    const [execMember, targetMember] = await Promise.all([
      client.rest.get(`/guilds/${guildId}/members/${executorIdOrMember}`).catch(() => null),
      client.rest.get(`/guilds/${guildId}/members/${targetIdOrMember}`).catch(() => null),
    ]);
    if (!execMember || !targetMember) return false;
    execRoleIds   = Array.isArray(execMember.roles)   ? execMember.roles   : getMemberRoleIds(execMember);
    targetRoleIds = Array.isArray(targetMember.roles) ? targetMember.roles : getMemberRoleIds(targetMember);
  } else {
    execRoleIds   = getMemberRoleIds(executorIdOrMember);
    targetRoleIds = getMemberRoleIds(targetIdOrMember);
  }

  // The server owner outranks everyone regardless of roles. Owners often hold
  // few or no roles, so a plain position compare let any mod with one higher
  // role warn, strip or escalate against them.
  if (isStringId(targetIdOrMember) && targetIdOrMember === await guildOwnerId(client, guildId)) return false;

  const execPos = highestPosition(execRoleIds,   posMap);
  const targPos = highestPosition(targetRoleIds, posMap);
  return execPos > targPos;
}

const _ownerCache = new Map(); // guildId -> { id, at }
async function guildOwnerId(client, guildId) {
  const cached = client.guilds?.cache?.get?.(guildId);
  const fromCache = cached?.ownerId ?? cached?.owner_id;
  if (fromCache) return fromCache;
  const hit = _ownerCache.get(guildId);
  if (hit && Date.now() - hit.at < 300_000) return hit.id;
  const guild = await client.rest.get(`/guilds/${guildId}`).catch(() => null);
  const id = guild?.owner_id ?? guild?.ownerId ?? null;
  if (id) _ownerCache.set(guildId, { id, at: Date.now() });
  return id;
}

// ─── Can bot act on target member (live hierarchy) ────────────────────────────
export async function botCanActOnLive(client, guildId, targetIdOrMember, maybeTargetMember) {
  // Two supported signatures:
  //   botCanActOnLive(client, guildId, targetId)
  //   botCanActOnLive(client, guildId, botMember, targetMember)   // legacy
  // Detect by arity, the 4-arg form passes objects; the 3-arg form passes a target ID string.
  const liveRoles = await fetchLiveRoles(client, guildId);
  const posMap    = buildPosMap(liveRoles);

  let botRoleIds, targetRoleIds;

  if (maybeTargetMember) {
    // Legacy 4-arg form
    botRoleIds    = getMemberRoleIds(targetIdOrMember);   // here = botMember
    targetRoleIds = getMemberRoleIds(maybeTargetMember);
  } else {
    // 3-arg form: fetch both members from REST
    const botId    = client.user?.id;
    const targetId = targetIdOrMember;
    const [botMember, targetMember] = await Promise.all([
      botId    ? client.rest.get(`/guilds/${guildId}/members/${botId}`).catch(() => null) : null,
      targetId ? client.rest.get(`/guilds/${guildId}/members/${targetId}`).catch(() => null) : null,
    ]);
    if (!botMember || !targetMember) return false;
    botRoleIds    = Array.isArray(botMember.roles)    ? botMember.roles    : getMemberRoleIds(botMember);
    targetRoleIds = Array.isArray(targetMember.roles) ? targetMember.roles : getMemberRoleIds(targetMember);
  }

  const botPos  = highestPosition(botRoleIds,    posMap);
  const targPos = highestPosition(targetRoleIds, posMap);
  return botPos > targPos;
}

// ─── Can bot assign a specific role (live hierarchy) ──────────────────────────
export async function botCanAssignRoleLive(client, botMember, guildId, roleId) {
  const liveRoles = await fetchLiveRoles(client, guildId);
  const posMap    = buildPosMap(liveRoles);
  const botPos    = highestPosition(getMemberRoleIds(botMember), posMap);
  const rolePos   = posMap.get(roleId) ?? 0;
  return botPos > rolePos;
}

// ─── Is this user currently in the guild ─────────────────────────────────────
// canActOnLive() returns false for non-members, which surfaced as a misleading
// "equal or higher rank" error; callers check membership first.
export async function isGuildMember(client, guildId, userId) {
  return !!(await client.rest.get(`/guilds/${guildId}/members/${userId}`).catch(() => null));
}

// ─── Can a member hand out a specific role (live hierarchy) ───────────────────
export async function memberCanAssignRoleLive(client, guildId, memberId, roleId) {
  const [liveRoles, member] = await Promise.all([
    fetchLiveRoles(client, guildId),
    client.rest.get(`/guilds/${guildId}/members/${memberId}`).catch(() => null),
  ]);
  if (!member) return false;
  const posMap  = buildPosMap(liveRoles);
  const roleIds = Array.isArray(member.roles) ? member.roles : getMemberRoleIds(member);
  return highestPosition(roleIds, posMap) > (posMap.get(roleId) ?? 0);
}
