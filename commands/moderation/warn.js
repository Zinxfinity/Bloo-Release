import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import { isBotOwner, isRealOwner } from '../../handlers/staffSystem.js';
import { canActOnLive, isGuildMember } from '../../config/guildPermissions.js';
import { resolveAccess } from '../../handlers/commandPermissions.js';
import { logAction } from '../../handlers/modLog.js';
import {
  addWarning, getWarnings, getActiveWarnings, removeWarning,
  getActiveWarnCount, getThresholdForCount, getThresholds,
  getWarnConfig, setWarnChannel, setThreshold, removeThreshold,
  addTempban,
} from '../../handlers/warnSystem.js';
import { parseUserMention } from '@fluxerjs/core';
import { Permissions } from '../../config/guildPermissions.js';
import { needsApproval, createApprovalRequest, postApprovalRequest, performBanAction } from '../../handlers/banSystem.js';
import logger from '../../utils/logger.js';
import { applyThreshold } from '../../handlers/warnEscalation.js';

function parseUserId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

export default {
  name: 'warn',
  aliases: ['w', 'warns', 'warnings'],
  description: 'Warn a member. Subcommands: warnings, remove, clear, config.',
  usage: '{prefix}warn <@user|id> [reason]\n{prefix}warns <@user|id>\n{prefix}warn remove <id>\n{prefix}warn clear <@user|id>\n{prefix}warn config [threshold|warnlog]',
  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const guildId    = message.guildId;
    const executorId = message.author.id;
    if (!guildId) return;

    const cmdName = message.content.slice(prefix?.length ?? 2).trim().split(/\s+/)[0].toLowerCase();
    const sub     = args[0]?.toLowerCase();

    // !warns @user, view warnings (also !warn warnings @user)
    if (cmdName === 'warns' || cmdName === 'warnings' || sub === 'warnings' || sub === 'warns') {
      const targetArg = cmdName === 'warns' || cmdName === 'warnings' ? args[0] : args[1];
      return handleView(client, message, targetArg, guildId);
    }

    if (sub === 'remove') return handleRemove(message, args.slice(1), guildId);
    if (sub === 'clear')  return handleClear(message, args.slice(1), guildId, executorId);
    if (sub === 'config') return handleConfig(client, message, args.slice(1), guildId, executorId, prefix);

    // !warn @user [reason]
    const targetRaw = args[0];
    if (!targetRaw) {
      return message.reply({
        embeds: [Embed.info(
          [
            `**Warn user:**     \`${prefix}warn @user [reason]\``,
            `**View warns:**    \`${prefix}warns @user\``,
            `**Remove warn:**   \`${prefix}warn remove <id>\``,
            `**Clear all:**     \`${prefix}warn clear @user\``,
            `**Config:**        \`${prefix}warn config threshold|warnlog\``,
          ].join('\n'),
          'Warn, Usage'
        ).toJSON()],
      });
    }

    const targetId = parseUserMention(targetRaw) ?? targetRaw.replace(/\D/g, '');
    if (!targetId) return message.reply({ embeds: [Embed.danger('Could not resolve that user.').toJSON()] });

    const reason = args.slice(1).join(' ') || 'No reason provided.';

    // A user who already left can still be warned (on record); rank only
    // applies to members.
    if (!(isBotOwner(executorId) || await isRealOwner(guildId, executorId)) && await isGuildMember(client, guildId, targetId) && !(await canActOnLive(client, guildId, executorId, targetId))) {
      return message.reply({ embeds: [Embed.denied('You cannot warn someone with an equal or higher rank.').toJSON()] });
    }

    const { id: warnId } = addWarning(guildId, targetId, executorId, reason);
    const warnCount = getActiveWarnCount(guildId, targetId);

    const targetUser = await client.rest.get(`/users/${targetId}`).catch(() => null);
    const targetTag  = targetUser?.username ?? targetId;

    const caseNum = await logAction({
      client, guildId, action: 'warn',
      targetId, targetTag,
      executorId, executorTag: message.author.username,
      reason,
      extraFields: [{ name: 'Warn #', value: String(warnCount), inline: true }],
    });

    await message.reply({
      embeds: [Embed.success(`Warned **${targetTag}** (${warnCount} active warn${warnCount === 1 ? '' : 's'}) | Case #${caseNum}`).toJSON()],
    });

    // DM the warned user
    try {
      const dm = await client.rest.post(`/users/@me/channels`, { body: { recipient_id: targetId } }).catch(() => null);
      if (dm?.id) {
        await client.rest.post(`/channels/${dm.id}/messages`, {
          body: {
            embeds: [new EmbedBuilder()
              .setColor(COLORS.WARNING)
              .setTitle('You have been warned')
              .setDescription(`In **${(await client.rest.get(`/guilds/${guildId}`).catch(() => null))?.name ?? 'a server'}**`)
              .addFields(
                { name: 'Reason', value: reason, inline: false },
                { name: 'Warn count', value: String(warnCount), inline: true },
              )
              .setTimestamp()
              .toJSON()],
          },
        });
      }
    } catch { /* DMs may be closed */ }

    // Threshold check
    const threshold = getThresholdForCount(guildId, warnCount);
    if (threshold) {
      const outcome = await applyThreshold(client, guildId, targetId, targetTag, threshold, executorId, message.author.username);
      if (outcome) await message.reply({ embeds: [(outcome.ok ? Embed.info : Embed.warning)(outcome.text, 'Warn threshold reached').toJSON()] }).catch(() => {});
    }
  },
};

async function handleView(client, message, targetArg, guildId) {
  const targetId = parseUserId(targetArg) ?? targetArg?.replace(/\D/g, '');
  if (!targetId) return message.reply({ embeds: [Embed.warning('Provide a user to view warnings for.').toJSON()] });

  const warns = getWarnings(guildId, targetId);
  if (!warns.length) {
    return message.reply({ embeds: [Embed.info(`No warnings found for <@${targetId}>.`).toJSON()] });
  }

  const active   = warns.filter(w => !w.removed_at);
  const inactive = warns.filter(w => w.removed_at);

  const lines = warns.slice(0, 20).map(w => {
    // created_at is unix seconds (SQLite unixepoch()), not milliseconds
    const label = w.removed_at ? '~~' : '';
    return `${label}**#${w.id}** <t:${w.created_at}:d> by <@${w.executor_id}>: ${w.reason?.slice(0, 80) ?? 'No reason'}${label}`;
  });

  const embed = new EmbedBuilder()
    .setColor(active.length > 0 ? COLORS.WARNING : COLORS.SUCCESS)
    .setTitle(`Warnings, <@${targetId}>`)
    .setDescription(lines.join('\n'))
    .addFields(
      { name: 'Active', value: String(active.length), inline: true },
      { name: 'Total',  value: String(warns.length),  inline: true },
    )
    .setFooter({ text: `Showing up to 20 most recent` });

  await message.reply({ embeds: [embed.toJSON()] });
}

async function handleRemove(message, args, guildId) {
  const warnId = parseInt(args[0], 10);
  if (!warnId) return message.reply({ embeds: [Embed.warning('Provide a warn ID to remove.').toJSON()] });

  const warn = removeWarning(guildId, warnId, message.author.id);
  if (!warn) return message.reply({ embeds: [Embed.danger(`Warning #${warnId} not found.`).toJSON()] });

  await message.reply({ embeds: [Embed.success(`Removed warning #${warnId}.`).toJSON()] });
}

async function handleClear(message, args, guildId, executorId) {
  const targetId = parseUserId(args[0]) ?? args[0]?.replace(/\D/g, '');
  if (!targetId) return message.reply({ embeds: [Embed.warning('Provide a user to clear warnings for.').toJSON()] });

  const warns = getWarnings(guildId, targetId);
  const active = warns.filter(w => !w.removed_at);
  if (!active.length) {
    return message.reply({ embeds: [Embed.info(`<@${targetId}> has no active warnings.`).toJSON()] });
  }

  for (const w of active) removeWarning(guildId, w.id, executorId);

  await message.reply({ embeds: [Embed.success(`Cleared **${active.length}** warning${active.length === 1 ? '' : 's'} for <@${targetId}>.`).toJSON()] });
}

async function handleConfig(client, message, args, guildId, executorId, prefix) {
  if (!await resolveAccess(client, guildId, executorId, 'warn', Permissions.BAN_MEMBERS)) {
    return message.reply({ embeds: [Embed.denied('Ban Members or higher required.').toJSON()] });
  }

  const sub = args[0]?.toLowerCase();

  // Retired 2026-09-26: every mute uses Fluxer's timeout, which already takes any
  // length up to 28 days, and nothing ever gave a mute role to anyone.
  if (sub === 'muterole') {
    return message.reply({ embeds: [Embed.info(`Mutes use Fluxer's timeout, so there's no mute role to set. Choose the length when you mute, like \`${prefix}warn config threshold 3 mute 12h\` or \`${prefix}mute @user 3d\` (up to 28 days).`).toJSON()] });
  }

  if (sub === 'threshold') {
    const count  = parseInt(args[1], 10);
    const action = args[2]?.toLowerCase();
    const valid  = ['mute', 'kick', 'tempban', 'ban'];

    if (args[1] === 'list') {
      const thresholds = getThresholds(guildId);
      if (!thresholds.length) return message.reply({ embeds: [Embed.info('No thresholds configured.').toJSON()] });
      const lines = thresholds.map(t => `**${t.count}** warns → **${t.action}**${t.duration_seconds ? ` (${t.duration_seconds}s)` : ''}`);
      return message.reply({ embeds: [Embed.info(lines.join('\n'), 'Warn Thresholds').toJSON()] });
    }

    if (args[1] === 'clear') {
      const n = parseInt(args[2], 10);
      if (!n) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}warn config threshold clear <count>\``).toJSON()] });
      removeThreshold(guildId, n);
      return message.reply({ embeds: [Embed.success(`Removed threshold at **${n}** warnings.`).toJSON()] });
    }

    if (!count || !valid.includes(action)) {
      return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}warn config threshold <count> <${valid.join('|')}> [duration]\``).toJSON()] });
    }
    // "1h" used to be parseInt'd to 1, so a threshold meant as a one-hour
    // mute/tempban lasted one second.
    const durS = args[3] ? parseDurationSeconds(args[3]) : null;
    if (args[3] && !durS) {
      return message.reply({ embeds: [Embed.warning('Invalid duration. Use e.g. `30m`, `12h`, `7d`, or a number of seconds.').toJSON()] });
    }
    setThreshold(guildId, count, action, durS);
    return message.reply({ embeds: [Embed.success(`Set threshold: **${count}** warns → **${action}**${durS ? ` (${args[3]})` : ''}.`).toJSON()] });
  }

  if (sub === 'warnlog') {
    const chRaw = args[1];
    if (!chRaw) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}warn config warnlog #channel\``).toJSON()] });
    const chId = chRaw.replace(/\D/g, '');
    setWarnChannel(guildId, chId);
    return message.reply({ embeds: [Embed.success(`Warn log channel set to <#${chId}>.`).toJSON()] });
  }

  // Show current config
  const cfg = getWarnConfig(guildId);
  const thresholds = getThresholds(guildId);
  const thresholdLines = thresholds.length
    ? thresholds.map(t => `• **${t.count}** warns → **${t.action}**${t.duration_seconds ? ` (${t.duration_seconds}s)` : ''}`).join('\n')
    : 'None configured';

  await message.reply({
    embeds: [new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle('Warn Config')
      .addFields(
        { name: 'Warn Log',    value: cfg?.warn_channel_id ? `<#${cfg.warn_channel_id}>` : 'Not set', inline: true },
        { name: 'Thresholds',  value: thresholdLines, inline: false },
      )
      .setFooter({ text: `Use "${prefix}warn config threshold|warnlog" to update` })
      .toJSON()],
  });
}

function parseDurationSeconds(input) {
  const m = String(input).trim().toLowerCase().match(/^(\d+)\s*(s|m|h|d|w)?$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2] ?? 's']);
}
