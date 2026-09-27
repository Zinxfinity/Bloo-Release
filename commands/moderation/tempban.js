import { Embed } from '../../config/embeds.js';
import { isBotOwner, isRealOwner } from '../../handlers/staffSystem.js';
import { botCanActOnLive, canActOnLive, isGuildMember } from '../../config/guildPermissions.js';
import { logAction } from '../../handlers/modLog.js';
import {
  performBanAction, banNeedsApproval, approvalWhere, createApprovalRequest, postApprovalRequest,
  isLockedOut, getLockout, recordBan,
} from '../../handlers/banSystem.js';
import { parseUserMention } from '@fluxerjs/core';
import { Permissions } from '../../config/guildPermissions.js';

function parseDuration(str) {
  const match = str?.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const units = { s: 1, m: 60, h: 3600, d: 86400 };
  return n * units[match[2].toLowerCase()];
}

export default {
  name: 'tempban',
  aliases: ['tb'],
  description: 'Temporarily ban a member.',
  usage: '{prefix}tempban <@user|id> <duration> [reason]',
  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const guildId    = message.guildId;
    const executorId = message.author.id;

    if (isLockedOut(guildId, executorId)) {
      const l = getLockout(guildId, executorId);
      return message.reply({ embeds: [Embed.danger('\u{1F512}  Ban Access Locked').setDescription(`You have been locked out.\n**Reason:** ${l.reason}\nExpires: <t:${l.expires_at}:R>`).toJSON()] });
    }

    const targetRaw  = args[0];
    const durationRaw = args[1];

    if (!targetRaw || !durationRaw) {
      return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}tempban <@user|id> <duration> [reason]\``).toJSON()] });
    }

    const targetId   = parseUserMention(targetRaw) ?? targetRaw.replace(/\D/g, '');
    const durationS  = parseDuration(durationRaw);

    if (!targetId) return message.reply({ embeds: [Embed.danger('Could not resolve that user.').toJSON()] });
    if (!durationS) return message.reply({ embeds: [Embed.danger('Invalid duration. Examples: `10m`, `2h`, `7d`').toJSON()] });

    // Someone who already left can still be tempbanned (same as !ban); the
    // rank checks only apply to current members and used to block this.
    const isMember = await isGuildMember(client, guildId, targetId);
    if (isMember && !(isBotOwner(executorId) || await isRealOwner(guildId, executorId)) && !(await canActOnLive(client, guildId, executorId, targetId))) {
      return message.reply({ embeds: [Embed.denied('You cannot tempban someone with an equal or higher rank.').toJSON()] });
    }

    // Live Fluxer-side hierarchy check, the bot's highest role must be above the target's
    const canAct = !isMember || await botCanActOnLive(client, guildId, targetId);
    if (!canAct) {
      return message.reply({ embeds: [Embed.danger('Cannot Tempban').setDescription('My role is not above the target in the Fluxer hierarchy.').toJSON()] });
    }

    const reason = args.slice(2).join(' ') || 'No reason provided.';

    const executorIsOwner = isBotOwner(executorId) || await isRealOwner(guildId, executorId);
    const targetUser = await client.rest.get(`/users/${targetId}`).catch(() => null);
    const targetTag  = targetUser?.username ?? targetId;
    const durationLabel = durationS >= 86400
      ? `${Math.floor(durationS / 86400)}d`
      : durationS >= 3600
        ? `${Math.floor(durationS / 3600)}h`
        : durationS >= 60 ? `${Math.floor(durationS / 60)}m` : `${durationS}s`;

    // Same gate as !ban: servers that require approval get a request, not
    // an immediate ban through the tempban side door.
    if (await banNeedsApproval(client.rest, guildId, executorId, executorIsOwner)) {
      const approvalId = createApprovalRequest({ guildId, targetId, targetTag, executorId, executorTag: message.author.username, reason, deleteDays: 1, actionType: 'temp', durationS });
      await postApprovalRequest(client.rest, guildId, approvalId, { targetId, targetTag, executorTag: message.author.username, reason: `${reason} (temp ban for ${durationLabel})` });
      return message.reply({ embeds: [Embed.warning('\u23F3  Tempban Queued for Approval').setDescription(`Tempban of **${targetTag}** for **${durationLabel}** is waiting for approval ${approvalWhere(guildId)}.\nApproval ID: **#${approvalId}**`).toJSON()] });
    }

    try {
      await performBanAction(client.rest, guildId, targetId, reason, 'temp', 1, durationS);
    } catch (err) {
      return message.reply({ embeds: [Embed.danger(`Tempban failed: ${err.message}`).toJSON()] });
    }
    const { exceeded } = recordBan(guildId, executorId);

    const caseNum = await logAction({
      client, guildId, action: 'tempban',
      targetId, targetTag,
      executorId, executorTag: message.author.username,
      reason,
      extraFields: [{ name: 'Duration', value: durationLabel, inline: true }],
    });

    await message.reply({
      embeds: [Embed.success(`Tempbanned **${targetTag}** for **${durationLabel}** | Case #${caseNum}`).toJSON()],
    });
    if (exceeded) {
      const l = getLockout(guildId, executorId);
      await message.reply({ embeds: [Embed.danger('\u{1F512}  You Have Been Locked Out').setDescription(`Exceeded ban limit. Locked out until <t:${l.expires_at}:R>.`).toJSON()] });
    }
  },
};
