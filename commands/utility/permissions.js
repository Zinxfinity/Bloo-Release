// ============================================================
//  commands/utility/permissions.js
//  Category : Utility  |  Rank: Server Owner ONLY (permanent)
//
//  Configures Gate 2 (Fluxer permission / role lock) requirements
//  per command. This command is permanently locked to Server Owner
// , it cannot be lowered via itself (self-lockout protection).
//
//  !permissions list                         , all active overrides
//  !permissions check <command>              , one command's settings
//  !permissions permission <command> <perm>  , require a Fluxer permission
//  !permissions role <command> <@role>       , lock to one exact role
//  !permissions reset <command>              , revert to built-in default
//  !permissions reset all                    , clear all overrides
//  !permissions disable <command> [msg]      , disable command
//  !permissions enable <command>             , re-enable command
// ============================================================

import { EmbedBuilder }              from '@fluxerjs/core';
import { Embed, COLORS }             from '../../config/embeds.js';
import { isBotOwner, isRealOwner }    from '../../handlers/staffSystem.js';
import { Permissions }               from '../../config/guildPermissions.js';
import {
  listOverrides, setCommandPermission, setCommandRole, resetCommand,
  disableCommand, enableCommand, getCommandConfig,
} from '../../handlers/commandPermissions.js';

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

// Accept a permission by common name or alias
const PERM_ALIASES = {
  kick: Permissions.KICK_MEMBERS,           kickmembers: Permissions.KICK_MEMBERS,
  ban: Permissions.BAN_MEMBERS,             banmembers: Permissions.BAN_MEMBERS,
  manageguild: Permissions.MANAGE_GUILD,    manageserver: Permissions.MANAGE_GUILD,
  managemessages: Permissions.MANAGE_MESSAGES,
  managechannels: Permissions.MANAGE_CHANNELS,
  manageroles: Permissions.MANAGE_ROLES,
  managewebhooks: Permissions.MANAGE_WEBHOOKS,
  timeout: Permissions.MODERATE_MEMBERS,    moderatemembers: Permissions.MODERATE_MEMBERS,
  admin: Permissions.ADMINISTRATOR,         administrator: Permissions.ADMINISTRATOR,
};

function parsePermissionInput(input) {
  return PERM_ALIASES[input?.toLowerCase()?.replace(/[\s_-]/g, '')] ?? null;
}

function parseRoleId(arg) {
  return arg?.match(/^<@&(\d+)>$/)?.[1] ?? (arg?.match(/^\d{17,20}$/) ? arg : null);
}

function requirementLabel(cfg, defaultPermission) {
  if (cfg?.required_type === 'role' && cfg.required_value) return `🔒 Role <@&${cfg.required_value}>`;
  if (cfg?.required_type === 'permission' && cfg.required_value) return `🔒 ${PERM_NAMES.get(BigInt(cfg.required_value)) ?? 'Unknown Permission'}`;
  if (defaultPermission === 'SERVER_OWNER') return 'Server Owner (default)';
  if (defaultPermission === 'BOT_OWNER') return 'Bot Owner (default)';
  if (defaultPermission == null) return 'Everyone (default)';
  return `${PERM_NAMES.get(defaultPermission) ?? 'Unknown Permission'} (default)`;
}

export default {
  name: 'permissions',
  aliases: ['perms', 'cmdperms'],
  description: 'Lock commands to a specific Fluxer permission or an exact role in this server.',
  usage: '{prefix}permissions <list|check|permission|role|reset|disable|enable> [args]',
  category: 'utility',

  requiredPermission: 'SERVER_OWNER', // permanently locked
  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const guildId    = message.guildId;
    const executorId = message.author.id;

    // Permanent Server Owner lock, prevents self-lowering via !permissions.
    // commandHandler's Gate 3 already required SERVER_OWNER to reach here;
    // this is an extra hard floor so the check can't be bypassed by an
    // override even if one somehow got set on this command itself.
    if (!isBotOwner(executorId) && !await isRealOwner(guildId, executorId)) {
      return message.reply({ embeds: [Embed.denied('This command is permanently locked to Server Owner.').toJSON()] });
    }

    const sub     = args[0]?.toLowerCase();
    const rawName = args[1]?.toLowerCase();
    // Overrides are keyed by the canonical command name (what the handler
    // looks up), so `perms` or any other alias is stored as its real command.
    const cmdName = rawName && rawName !== 'all' ? (client.commands?.get(rawName)?.name ?? rawName) : rawName;

    if (rawName && rawName !== 'all' && ['check', 'permission', 'role', 'disable', 'enable'].includes(sub) && !client.commands?.get(rawName)) {
      return message.reply({ embeds: [Embed.warning(`\`${rawName}\` isn't a command.`).toJSON()] });
    }
    if (sub === 'disable' && cmdName === 'permissions') {
      return message.reply({ embeds: [Embed.warning("`permissions` can't be disabled, it's how commands get re-enabled.").toJSON()] });
    }

    // ── list ─────────────────────────────────────────────────────────────
    if (!sub || sub === 'list') {
      const overrides = listOverrides(guildId);
      if (!overrides.length) {
        return message.reply({ embeds: [Embed.info('No command permission overrides set.').toJSON()] });
      }
      const lines = overrides.map(o => {
        const flags = [];
        if (o.disabled) flags.push('❌ disabled' + (o.disabled_msg ? ` ("${o.disabled_msg.slice(0, 30)}")` : ''));
        if (o.required_type === 'role' && o.required_value) flags.push(`🔒 Role <@&${o.required_value}>`);
        if (o.required_type === 'permission' && o.required_value) flags.push(`🔒 ${PERM_NAMES.get(BigInt(o.required_value)) ?? 'Unknown Permission'}`);
        return `\`${o.command_name}\`: ${flags.join(', ') || 'default'}`;
      });
      const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle('Command Permission Overrides')
        .setDescription(lines.join('\n').slice(0, 4000));
      return message.reply({ embeds: [embed.toJSON()] });
    }

    // ── check ─────────────────────────────────────────────────────────────
    if (sub === 'check') {
      if (!cmdName) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}permissions check <command>\``).toJSON()] });
      const command = client.commands?.get(cmdName);
      const config  = getCommandConfig(guildId, cmdName);
      const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(`Permissions: \`${cmdName}\``)
        .addFields(
          { name: 'Built-in Default', value: command ? requirementLabel(null, command.requiredPermission) : 'Unknown command', inline: true },
          { name: 'Effective',        value: requirementLabel(config, command?.requiredPermission), inline: true },
          { name: 'Disabled',         value: config?.disabled ? `Yes${config.disabled_msg ? `, "${config.disabled_msg}"` : ''}` : 'No', inline: true },
          { name: 'Override Set By',  value: config?.set_by ? `<@${config.set_by}>` : 'None', inline: true },
        );
      return message.reply({ embeds: [embed.toJSON()] });
    }

    // ── permission ───────────────────────────────────────────────────────
    if (sub === 'permission' || sub === 'perm') {
      const permInput = args[2];
      if (!cmdName || !permInput) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}permissions permission <command> <permission>\`\nPermissions: ${[...PERM_NAMES.values()].join(', ')}`).toJSON()] });
      }
      // BOT_OWNER-gated commands (eval, globalban, maintenance, etc.) mean
      // "the actual bot developer, nobody else", not configurable down to
      // any Fluxer permission by a server owner, no matter how trusted.
      if (client.commands?.get(cmdName)?.requiredPermission === 'BOT_OWNER') {
        return message.reply({ embeds: [Embed.denied(`\`${cmdName}\` is restricted to the bot owner and cannot be reconfigured.`).toJSON()] });
      }
      const flag = parsePermissionInput(permInput);
      if (flag === null) {
        return message.reply({ embeds: [Embed.danger(`Unknown permission: \`${permInput}\`. Valid: ${[...PERM_NAMES.values()].join(', ')}`).toJSON()] });
      }
      setCommandPermission(guildId, cmdName, flag, executorId);
      return message.reply({ embeds: [Embed.success(`\`${cmdName}\` now requires **${PERM_NAMES.get(flag)}** in this server.`).toJSON()] });
    }

    // ── role ─────────────────────────────────────────────────────────────
    if (sub === 'role') {
      const roleArg = args[2];
      if (!cmdName || !roleArg) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}permissions role <command> <@role>\``).toJSON()] });
      }
      if (client.commands?.get(cmdName)?.requiredPermission === 'BOT_OWNER') {
        return message.reply({ embeds: [Embed.denied(`\`${cmdName}\` is restricted to the bot owner and cannot be reconfigured.`).toJSON()] });
      }
      const roleId = parseRoleId(roleArg);
      if (!roleId) {
        return message.reply({ embeds: [Embed.danger('Provide a valid role mention or ID.').toJSON()] });
      }
      setCommandRole(guildId, cmdName, roleId, executorId);
      return message.reply({ embeds: [Embed.success(`\`${cmdName}\` is now locked to <@&${roleId}> in this server (exact role match, independent of that role's own permissions).`).toJSON()] });
    }

    // ── reset ─────────────────────────────────────────────────────────────
    if (sub === 'reset') {
      if (cmdName === 'all') {
        const overrides = listOverrides(guildId);
        for (const o of overrides) resetCommand(guildId, o.command_name);
        return message.reply({ embeds: [Embed.success(`Reset all ${overrides.length} command permission override(s).`).toJSON()] });
      }
      if (!cmdName) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}permissions reset <command|all>\``).toJSON()] });
      resetCommand(guildId, cmdName);
      return message.reply({ embeds: [Embed.success(`Reset \`${cmdName}\` to its built-in default.`).toJSON()] });
    }

    // ── disable ───────────────────────────────────────────────────────────
    if (sub === 'disable') {
      if (!cmdName) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}permissions disable <command> [message]\``).toJSON()] });
      const msg = args.slice(2).join(' ') || null;
      disableCommand(guildId, cmdName, executorId, msg);
      return message.reply({ embeds: [Embed.success(`Disabled \`${cmdName}\` in this server${msg ? ` with message: "${msg}"` : ' (silent)'}.`).toJSON()] });
    }

    // ── enable ────────────────────────────────────────────────────────────
    if (sub === 'enable') {
      if (!cmdName) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}permissions enable <command>\``).toJSON()] });
      enableCommand(guildId, cmdName, executorId);
      return message.reply({ embeds: [Embed.success(`Re-enabled \`${cmdName}\` in this server.`).toJSON()] });
    }

    await message.reply({ embeds: [Embed.info(`Subcommands: \`list\`, \`check\`, \`permission\`, \`role\`, \`reset\`, \`disable\`, \`enable\``).toJSON()] });
  },
};
