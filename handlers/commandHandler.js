import db from '../db.js';
import logger from '../utils/logger.js';
import { Embed } from '../config/embeds.js';
import { Permissions } from '../config/guildPermissions.js';
import * as resilience from './resilience.js';
import { findForeignChannelArg } from '../utils/channelGuard.js';

// ─── Cooldown store ───────────────────────────────────────────────────────────
// Map<commandName, Map<userId, expiresAt>>
const cooldowns = new Map();

// ─── Quarantine ───────────────────────────────────────────────────────────────
// Backed by the shared circuit breaker (resilience.js) under a `command.<name>`
// key, so there's one quarantine store for the whole bot instead of a separate
// one per subsystem. Commands quarantine on the first unknown error (threshold
// 1), a crashing command shouldn't get three tries before it's locked.
const QUARANTINE_THRESHOLD = 1;
const quarantineKey = (name) => `command.${name}`;

// ─── Lazy imports, avoid circular deps at load time ─────────────────────────
let _isStaff          = null;
let _isRealOwner       = null;
let _isBotOwner        = null;
let _checkAccess      = null;
let _getPrefix        = null;
let _invalidateGuild  = null;
let _isChannelAllowed = null;
let _reportError      = null;
let _getTag           = null;
let _isEconomyReleased = null;
let _isEconomyAdmin    = null;
let _ecoComingSoonMsg  = null;
let _isShadowBanned    = null;

async function isShadowBanned(guildId, userId) {
  if (!_isShadowBanned) {
    const mod = await import('./shadowBan.js').catch(() => null);
    _isShadowBanned = mod?.isShadowBanned ?? (() => false);
  }
  return _isShadowBanned(guildId, userId);
}

async function loadStaffSystem() {
  if (!_isStaff) {
    const mod = await import('./staffSystem.js').catch(() => null);
    _isStaff     = mod?.isStaff     ?? (async () => false);
    _isRealOwner = mod?.isRealOwner ?? (async () => false);
    _isBotOwner  = mod?.isBotOwner  ?? (() => false);
  }
}

async function loadEconomyGate() {
  if (!_isEconomyReleased) {
    const mod = await import('./economy/economyAdmins.js').catch(() => null);
    // Same fail-closed convention as loadStaffSystem() above: if the module
    // can't load, default to the SAFE/restrictive answer (not released,
    // nobody's an economy admin), not the permissive one, an unreleased
    // feature staying gated on a load failure is the right failure mode,
    // not it opening up to everyone.
    _isEconomyReleased = mod?.isEconomyReleased ?? (() => false);
    _isEconomyAdmin     = mod?.isEconomyAdmin    ?? (() => false);
    _ecoComingSoonMsg   = mod?.ECONOMY_COMING_SOON_MESSAGE ?? 'The economy system isn\'t available yet.';
  }
}

async function isStaff(client, guildId, userId) {
  await loadStaffSystem();
  return _isStaff(client, guildId, userId);
}

async function isOwnerOrBotOwner(guildId, userId) {
  await loadStaffSystem();
  return (await _isRealOwner(guildId, userId)) || _isBotOwner(userId);
}

// Live REST-based Administrator check, doesn't depend on the member/role
// cache (the bot runs with intents: 0, so that cache is often empty), used
// so the resetprefix recovery command also works for guild admins, not just
// the real owner or bot owner.
let _hasPermissionLiveDirect = null;
async function isGuildAdminLive(client, guildId, userId) {
  if (!_hasPermissionLiveDirect) {
    const mod = await import('./commandPermissions.js').catch(() => null);
    _hasPermissionLiveDirect = mod?.hasPermissionLive ?? (async () => false);
  }
  return _hasPermissionLiveDirect(client, guildId, userId, Permissions.ADMINISTRATOR);
}

let _hasPermissionLive = null;
let _hasRoleLive       = null;

async function checkCommandAccess(guildId, userId, commandName, defaultPermission) {
  if (!_checkAccess) {
    const mod   = await import('./commandPermissions.js').catch(() => null);
    _checkAccess     = mod?.checkCommandAccess ?? (() => ({ allowed: true, reason: null }));
    _hasPermissionLive = mod?.hasPermissionLive ?? (async () => false);
    _hasRoleLive       = mod?.hasRoleLive ?? (async () => false);
  }
  return _checkAccess(guildId, userId, commandName, defaultPermission);
}

async function getPrefix(guildId) {
  if (!_getPrefix) {
    const mod  = await import('./guildSettings.js').catch(() => null);
    _getPrefix = mod?.getPrefix ?? (() => process.env.PREFIX ?? 'b!');
  }
  return _getPrefix(guildId);
}

async function invalidateGuildPrefix(guildId) {
  if (!_invalidateGuild) {
    const mod       = await import('./guildSettings.js').catch(() => null);
    _invalidateGuild = mod?.invalidateGuild ?? (() => {});
  }
  return _invalidateGuild(guildId);
}

async function isChannelAllowed(guildId, channelId) {
  if (!_isChannelAllowed) {
    const mod        = await import('./channelRestrictions.js').catch(() => null);
    _isChannelAllowed = mod?.isChannelAllowed ?? (() => true);
  }
  return _isChannelAllowed(guildId, channelId);
}

async function reportError(category, payload) {
  if (!_reportError) {
    const mod    = await import('./errorReporter.js').catch(() => null);
    _reportError = mod?.reportError ?? (() => {});
  }
  return _reportError(category, payload);
}

// command.category is the commands/<category>/ folder name (set by
// commandLoader.js), used as the human-readable label on error reports.
function categoryLabel(command) {
  const raw = command?.category || 'general';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ─── DM commands ──────────────────────────────────────────────────────────────
// Everything below (permission checks, per-guild prefix, channel restrictions,
// aliases, tags) assumes a real guild and would either throw or silently
// misbehave with a null guildId. Rather than opening that whole pipeline up to
// DMs, only a small allowlist of guild-independent commands get their own
// minimal path here.
const DM_ALLOWED_COMMANDS = new Set(['remind']);

async function handleDMMessage(client, message) {
  const prefix  = process.env.PREFIX ?? 'b!';
  const content = message.content;
  if (!content.startsWith(prefix)) return;

  const withoutPrefix = content.slice(prefix.length).trim();
  if (!withoutPrefix) return;

  const parts   = withoutPrefix.split(/\s+/);
  const rawName = parts[0].toLowerCase();
  const args    = parts.slice(1);

  const command = client.commands.get(rawName);
  if (!command || !DM_ALLOWED_COMMANDS.has(command.name)) return;

  try {
    await command.execute({ message, args, prefix, client });
  } catch (err) {
    logger.warn(`[CMD] DM command error in ${command.name}:`, err.message);
    await safeReply(message, {
      embeds: [Embed.danger('Something went wrong running that command.').toJSON()],
    });
  }
}

// ─── Main message handler, called from messageCreate.js ─────────────────────
export async function handleMessage(client, message) {
  if (message.author?.bot)       return;
  if (!message.content?.trim())  return;

  if (!message.guildId) {
    await handleDMMessage(client, message);
    return;
  }

  const guildId  = message.guildId;
  const userId   = message.author.id;
  const content  = message.content;

  // ── Special recovery: bloo!resetprefix ───────────────────────────────────
  // Fixed trigger word, deliberately not affected by the guild's configured
  // prefix, so it still works if that prefix gets corrupted (see the
  // dashboard settings fallback bug this recovers from). Guild admins can
  // use it too, not just the real owner or bot owner.
  if (content.trim().toLowerCase() === 'bloo!resetprefix') {
    if ((await isOwnerOrBotOwner(guildId, userId)) || (await isGuildAdminLive(client, guildId, userId))) {
      try {
        db.prepare(`UPDATE guild_settings SET prefix = 'b!', updated_at = unixepoch() WHERE guild_id = ?`)
          .run(guildId);
        await invalidateGuildPrefix(guildId);
        await message.reply({ embeds: [Embed.success('Prefix reset to `b!`').toJSON()] });
      } catch { /* best effort */ }
    }
    return;
  }

  // ── Resolve prefix ────────────────────────────────────────────────────────
  const prefix = await getPrefix(guildId);

  if (!content.startsWith(prefix)) return;

  // ── Parse command name and args ───────────────────────────────────────────
  const withoutPrefix = content.slice(prefix.length).trim();
  if (!withoutPrefix) return;

  const parts       = withoutPrefix.split(/\s+/);
  const rawName     = parts[0].toLowerCase();
  const args        = parts.slice(1);

  if (!rawName) return;

  // ── Shadow ban ────────────────────────────────────────────────────────────
  // Deliberately ahead of every numbered gate below and the tag fallback,
  // no reply, no denial embed, just delete the trigger message and stop,
  // identical to what happens after any command that runs successfully
  // (see the Execute block's own safeDelete at the bottom of this
  // function), so there's nothing visibly different for the user to notice.
  if (await isShadowBanned(guildId, userId)) {
    await safeDelete(message);
    return;
  }

  const command = client.commands.get(rawName) ?? await (async () => {
    // Check guild aliases before giving up on unknown commands
    try {
      const { resolveAlias } = await import('./aliasSystem.js');
      const target = resolveAlias(guildId, rawName);
      if (target) return client.commands.get(target) ?? null;
    } catch { /* aliasSystem not available */ }
    return null;
  })();
  if (!command) {
    // Tag fallback, only fires when prefix was used and no real command matched
    if (!_getTag) {
      const mod = await import('./customCommands.js').catch(() => null);
      _getTag = mod?.getTag ?? (() => null);
    }
    const tag = _getTag(guildId, rawName);
    if (!tag) return;

    // Respect channel restriction for non-staff
    const tagIsStaff = await isStaff(client, guildId, userId);
    if (!tagIsStaff) {
      const allowed = await isChannelAllowed(guildId, message.channelId);
      if (!allowed) { await safeDelete(message); return; }
    }

    try {
      // Anyone can trigger a tag, so a tag containing @everyone or a role
      // mention must not let any member mass-ping through the bot.
      const allowedMentions = { parse: ['users'] };
      if (tag.embed) {
        const { EmbedBuilder } = await import('@fluxerjs/core');
        const embed = new EmbedBuilder().setDescription(tag.response).setColor(0x4ade80);
        await message.reply({ embeds: [embed.toJSON()], allowedMentions });
      } else {
        await message.reply({ content: tag.response, allowedMentions });
      }
      await safeDelete(message);
    } catch { /* non-fatal */ }
    return;
  }

  // ── Gate 0: Quarantine ────────────────────────────────────────────────────
  if (command.quarantined) {
    await safeReply(message, {
      embeds: [Embed.denied('This command is temporarily disabled while an issue is investigated.').toJSON()],
    });
    return;
  }

  // ── Gate 1: Channel restriction ───────────────────────────────────────────
  const staff = await isStaff(client, guildId, userId);

  if (!staff) {
    const allowed = await isChannelAllowed(guildId, message.channelId);
    if (!allowed) {
      await safeDelete(message);
      return;
    }
  }

  // ── Gate 2: Per-guild command access (permission/role + disable check) ────
  // Runs for every command, including ones open to everyone by default:
  // `!permissions disable|role|permission` on those used to save and report
  // success but never apply. checkCommandAccess returns plain "allowed" for
  // a null default with no override, so public commands are unaffected.
  {
    const access = await checkCommandAccess(guildId, userId, command.name, command.requiredPermission ?? null);

    if (!access.allowed) {
      if (access.reason) {
        await safeReply(message, { content: access.reason });
      } else if (access.disabled) {
        await safeDelete(message);
      } else {
        await safeReply(message, {
          embeds: [Embed.denied('You do not have the Fluxer permissions required for this command.').toJSON()],
        });
      }
      return;
    }

    // Fails secure, any fetch failure or missing data results in denial.
    // internalAccess commands (ticket, tag, echo, ...) resolve permission per
    // subcommand themselves with the same override, so only the disabled
    // check above applies here; otherwise an override meant for their staff
    // subcommands would also lock out the public ones (e.g. !ticket close).
    let permitted = true;
    if (command.internalAccess)    permitted = true;
    else if (access.requiredRole)  permitted = await _hasRoleLive(client, guildId, userId, access.requiredRole);
    else if (access.requiredPermission) permitted = await _hasPermissionLive(client, guildId, userId, access.requiredPermission);

    if (!permitted) {
      await safeReply(message, { embeds: [Embed.denied('You do not have the Fluxer permissions required for this command.').toJSON()] });
      return;
    }
  }

  // ── Gate 3: Cooldown ──────────────────────────────────────────────────────
  const cooldownS = command.cooldown ?? 3;
  if (cooldownS > 0) {
    if (!cooldowns.has(command.name)) cooldowns.set(command.name, new Map());
    const userCooldowns = cooldowns.get(command.name);
    const now           = Date.now();
    const expires       = userCooldowns.get(userId) ?? 0;

    if (now < expires) {
      const remaining = ((expires - now) / 1000).toFixed(1);
      await safeReply(message, {
        embeds: [Embed.warning(
          `Please wait **${remaining}s** before using \`${prefix}${command.name}\` again.`
        ).toJSON()],
      });
      return;
    }

    userCooldowns.set(userId, now + cooldownS * 1000);

    // Clean up expired entries periodically
    if (Math.random() < 0.05) {
      for (const [uid, exp] of userCooldowns) {
        if (exp < now) userCooldowns.delete(uid);
      }
    }
  }

  // ── Gate 4: Economy release ───────────────────────────────────────────────
  // Every command under commands/economy/ is stamped with category 'economy'
  // by the loader, so this one check covers the whole subsystem instead of
  // needing a guard duplicated into 40+ individual command files (the
  // pattern handlers/economy/disabledSubsystems.js's DISABLED_MESSAGE uses
  // for auction/org, which doesn't scale past a couple of files). Bot
  // owners and the narrower eco_admins whitelist always pass through
  // regardless of release state, that's how they keep building/testing it.
  if (command.category === 'economy') {
    await loadEconomyGate();
    if (!_isEconomyReleased() && !_isEconomyAdmin(userId)) {
      await safeReply(message, {
        embeds: [Embed.info(_ecoComingSoonMsg, '🚧 Coming Soon').toJSON()],
      });
      return;
    }
    // Player commands (no requiredPermission) need the server to have the
    // economy turned on and must be used in one of its economy channels.
    // Admin economy commands work anywhere so staff can set it up.
    if (!command.requiredPermission) {
      const { economyChannelBlock } = await import('./economy/channels.js');
      const block = economyChannelBlock(message, prefix);
      if (block) {
        let reply = null;
        try { reply = await message.reply({ embeds: [Embed.info(block.text).toJSON()] }); } catch { /* best effort */ }
        if (block.redirect) {
          // Keep the wrong channel tidy: drop the attempt and the pointer.
          await safeDelete(message);
          if (reply?.delete) setTimeout(() => reply.delete().catch(() => {}), 8000);
        }
        return;
      }
    }
  }

  // ── Gate 5: Channels from other servers ───────────────────────────────────
  // A channel argument pointing at another server would let staff here post
  // into, read from, or configure that server's channels through the bot.
  // Exempt: commands that deliberately reference other servers
  // (allowForeignChannels, e.g. !echo subscribe) and the bot owner.
  await loadStaffSystem();
  if (!command.allowForeignChannels && !_isBotOwner(userId) && await findForeignChannelArg(client, guildId, args)) {
    await safeReply(message, { embeds: [Embed.denied('That channel is not in this server.').toJSON()] });
    return;
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  try {
    await command.execute({ message, args, prefix, client });
    await safeDelete(message);
  } catch (err) {
    await handleCommandError(message, command, prefix, err);
  }
}

// ─── Error handling ───────────────────────────────────────────────────────────
async function handleCommandError(message, command, prefix, err) {
  const errMsg = err.message ?? String(err);

  // Permission / hierarchy errors, DM user, do not quarantine
  const isPermError = errMsg.includes('permissions')
    || errMsg.includes("You don't have")
    || errMsg.includes('Missing Permissions')
    || err.code === 'MISSING_PERMISSIONS'
    || err.statusCode === 403;

  if (isPermError) {
    logger.warn(`[CMD] Permission error in ${command.name}:`, errMsg);
    await safeDM(message, {
      embeds: [Embed.danger(
        `I don't have the permissions needed to complete \`${prefix}${command.name}\` in **${message.guild?.name ?? 'that server'}**.\n` +
        `Please check my role permissions and try again.`
      ).toJSON()],
    });
    return;
  }

  // Transient gateway errors, notify user, do not quarantine
  const isTransient = errMsg.toLowerCase().includes('gateway')
    || errMsg.toLowerCase().includes('timeout')
    || errMsg.toLowerCase().includes('econnreset')
    || err.code === 'ETIMEDOUT';

  if (isTransient) {
    logger.warn(`[CMD] Transient error in ${command.name}:`, errMsg);
    await safeReply(message, {
      embeds: [Embed.warning(
        'The platform is temporarily unavailable. Please try again in a moment.'
      ).toJSON()],
    });
    return;
  }

  // Unknown error, quarantine command
  logger.error(`[CMD] Unhandled error in ${command.name}:`, err);

  resilience.recordFailure(quarantineKey(command.name), err, {
    threshold: QUARANTINE_THRESHOLD,
    onQuarantine: () => {
      command.quarantined = true;
    },
  });

  await reportError(categoryLabel(command), {
    title:   `Command quarantined: ${command.name}`,
    command: command.name,
    guildId: message.guildId,
    userId:  message.author?.id,
    error:   err,
  });

  await safeReply(message, {
    embeds: [Embed.danger(
      `An unexpected error occurred. This command has been temporarily disabled and the issue has been reported.`
    ).toJSON()],
  });
}

// ─── Quarantine management ────────────────────────────────────────────────────
export function getQuarantined(commandName) {
  if (!resilience.isQuarantined(quarantineKey(commandName))) return null;
  const [entry] = resilience.listQuarantined().filter(e => e.key === quarantineKey(commandName));
  if (!entry) return null;
  return {
    error:    entry.error,
    stack:    entry.stack,
    lockedAt: entry.lockedAt,
  };
}

export function releaseQuarantine(client, commandName) {
  const released = resilience.releaseQuarantine(quarantineKey(commandName));
  if (!released) return false;

  const command = client.commands.get(commandName);
  if (command) command.quarantined = false;

  return true;
}

export function listQuarantined() {
  return resilience.listQuarantined()
    .filter(entry => entry.key.startsWith('command.'))
    .map(entry => ({
      name:     entry.key.slice('command.'.length),
      error:    entry.error,
      stack:    entry.stack,
      lockedAt: entry.lockedAt,
    }));
}

// ─── Safe message helpers ─────────────────────────────────────────────────────
async function safeReply(message, payload) {
  try { await message.reply(payload); } catch { /* best effort */ }
}

async function safeDelete(message) {
  try { await message.delete(); } catch { /* best effort, message may already be gone */ }
}

async function safeDM(message, payload) {
  try {
    const dm = await message.author?.createDM?.().catch(() => null);
    if (dm) await dm.send(payload);
  } catch { /* user may have DMs closed */ }
}
