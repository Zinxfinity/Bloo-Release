import { Embed } from '../../config/embeds.js';
import { isBotOwner, isRealOwner } from '../../handlers/staffSystem.js';
import { botCanActOnLive, canActOnLive, isGuildMember } from '../../config/guildPermissions.js';
import { logAction } from '../../handlers/modLog.js';
import { parseUserMention } from '@fluxerjs/core';
import { Permissions } from '../../config/guildPermissions.js';
import { isPermissionError, notifyOwnerPermError } from '../../handlers/permissionGuard.js';

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

function parseDuration(str) {
  if (!str) return null;
  const lower = str.toLowerCase().trim();
  if (lower === 'off' || lower === 'remove' || lower === 'lift') return 0;
  const m = lower.match(/^(\d+)(s|sec|m|min|h|hr|d|day)?$/);
  if (!m) return null;
  const n    = parseInt(m[1], 10);
  const unit = m[2]?.[0] ?? 's';
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.min(n * (mult[unit] ?? 1000), MAX_TIMEOUT_MS);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)    return s + 's';
  if (s < 3600)  return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

function parseUserId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

export default {
  name: 'mute',
  aliases: ['unmute', 'timeout', 'untimeout', 'silence', 'unsilence', 'm'],
  description: 'Mute/timeout a member. Use `off` to remove. No duration shows status.',
  usage: '{prefix}mute <@user|id> [duration] [reason]\n{prefix}mute <@user|id> off [reason]\n{prefix}mute <@user|id> , check status\n{prefix}unmute <@user|id> [reason]',
  requiredPermission: Permissions.MODERATE_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const guildId    = message.guildId;
    const executorId = message.author.id;
    if (!guildId) return;

    const cmdName  = message.content.slice(prefix?.length ?? 2).trim().split(/\s+/)[0].toLowerCase();
    const isUnmute = ['unmute', 'untimeout', 'unsilence'].includes(cmdName);

    const targetId = parseUserId(args[0]);
    if (!targetId) {
      return message.reply({
        embeds: [Embed.info(
          [
            `**Mute:**    \`${prefix}mute @user <duration> [reason]\``,
            `**Unmute:**  \`${prefix}mute @user off [reason]\`  or  \`${prefix}unmute @user\``,
            `**Status:**  \`${prefix}mute @user\``,
            `Duration examples: \`30s\`, \`5m\`, \`1h\`, \`7d\``,
          ].join('\n'),
          'Mute, Usage'
        ).toJSON()],
      });
    }

    if (!await isGuildMember(client, guildId, targetId)) {
      return message.reply({ embeds: [Embed.danger('That user is not in this server.').toJSON()] });
    }
    if (!(isBotOwner(executorId) || await isRealOwner(guildId, executorId)) && !(await canActOnLive(client, guildId, executorId, targetId))) {
      return message.reply({ embeds: [Embed.denied('You cannot mute someone with an equal or higher rank.').toJSON()] });
    }

    // Status check: !mute @user (no duration/off arg)
    if (!isUnmute && !args[1]) {
      let memberData;
      try {
        memberData = await client.rest.get(`/guilds/${guildId}/members/${targetId}`);
      } catch {
        return message.reply({ embeds: [Embed.danger('Could not fetch member data.').toJSON()] });
      }
      const until = memberData?.communication_disabled_until;
      if (!until || new Date(until) <= new Date()) {
        return message.reply({ embeds: [Embed.info(`<@${targetId}> is **not muted**.`).toJSON()] });
      }
      const ts = Math.floor(new Date(until).getTime() / 1000);
      return message.reply({ embeds: [Embed.warning(`<@${targetId}> is muted until <t:${ts}:F> (<t:${ts}:R>).`).toJSON()] });
    }

    // Unmute path
    const durationMs = isUnmute ? 0 : parseDuration(args[1]);
    if (!isUnmute && durationMs === null) {
      return message.reply({ embeds: [Embed.warning(`Invalid duration. Examples: \`30s\`, \`5m\`, \`1h\`, \`7d\`, or \`off\` to unmute.`).toJSON()] });
    }

    const isRemoval = isUnmute || durationMs === 0;

    const canAct = await botCanActOnLive(client, guildId, targetId);
    if (!canAct) {
      return message.reply({ embeds: [Embed.danger('My role is not above the target in the hierarchy.').toJSON()] });
    }

    const reasonStart = isUnmute ? 1 : (parseDuration(args[1]) !== null ? 2 : 1);
    const reason = args.slice(reasonStart).join(' ') || (isRemoval ? 'Unmuted.' : 'No reason provided.');
    const until  = isRemoval ? null : new Date(Date.now() + durationMs).toISOString();

    try {
      await client.rest.patch(`/guilds/${guildId}/members/${targetId}`, {
        body: { communication_disabled_until: until },
      });
    } catch (err) {
      if (isPermissionError(err)) await notifyOwnerPermError(client, guildId, isRemoval ? 'unmute' : 'mute', `Could not ${isRemoval ? 'unmute' : 'mute'} <@${targetId}>: ${err.message}`);
      return message.reply({ embeds: [Embed.danger(`${isRemoval ? 'Unmute' : 'Mute'} failed: ${err.message}`).toJSON()] });
    }

    const targetUser = await client.rest.get(`/users/${targetId}`).catch(() => null);
    const targetTag  = targetUser?.username ?? targetId;

    if (isRemoval) {
      const caseNum = await logAction({
        client, guildId, action: 'unmute',
        targetId, targetTag,
        executorId, executorTag: message.author.username,
        reason,
      });
      return message.reply({ embeds: [Embed.success(`Unmuted **${targetTag}** | Case #${caseNum}`).toJSON()] });
    }

    const label = formatDuration(durationMs);
    const caseNum = await logAction({
      client, guildId, action: 'mute',
      targetId, targetTag,
      executorId, executorTag: message.author.username,
      reason,
      extraFields: [{ name: 'Duration', value: label, inline: true }],
    });

    await message.reply({
      embeds: [Embed.success(`Muted **${targetTag}** for **${label}** | Case #${caseNum}`).toJSON()],
    });
  },
};
