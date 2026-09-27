import { Embed } from '../../config/embeds.js';
import { isBotOwner, isRealOwner } from '../../handlers/staffSystem.js';
import { logAction } from '../../handlers/modLog.js';
import { botCanActOnLive, canActOnLive, isGuildMember } from '../../config/guildPermissions.js';
import { parseUserMention } from '@fluxerjs/core';
import { Permissions } from '../../config/guildPermissions.js';
import { isPermissionError, notifyOwnerPermError } from '../../handlers/permissionGuard.js';

export default {
  name: 'kick',
  aliases: ['k'],
  description: 'Kick a member from the server.',
  usage: '{prefix}kick <@user|id> [reason]',
  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const guildId    = message.guildId;
    const executorId = message.author.id;

    const targetRaw = args[0];
    if (!targetRaw) {
      return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}kick <@user|id> [reason]\``).toJSON()] });
    }

    const targetId = parseUserMention(targetRaw) ?? targetRaw.replace(/\D/g, '');
    if (!targetId) return message.reply({ embeds: [Embed.danger('Could not resolve that user.').toJSON()] });

    const reason = args.slice(1).join(' ') || 'No reason provided.';

    if (!await isGuildMember(client, guildId, targetId)) {
      return message.reply({ embeds: [Embed.danger('That user is not in this server.').toJSON()] });
    }
    if (!(isBotOwner(executorId) || await isRealOwner(guildId, executorId)) && !(await canActOnLive(client, guildId, executorId, targetId))) {
      return message.reply({ embeds: [Embed.denied('You cannot kick someone with an equal or higher rank.').toJSON()] });
    }

    const targetMember = await client.rest.get(`/guilds/${guildId}/members/${targetId}`).catch(() => null);
    const botMember    = await client.rest.get(`/guilds/${guildId}/members/${client.user.id}`).catch(() => null);

    if (targetMember && botMember) {
      const canAct = await botCanActOnLive(client, guildId,
        { roles: botMember.roles },
        { roles: targetMember.roles }
      );
      if (!canAct) {
        return message.reply({ embeds: [Embed.danger("I can't kick that member because their role is above mine.").toJSON()] });
      }
    }

    const targetUser = await client.rest.get(`/users/${targetId}`).catch(() => null);
    const targetTag  = targetUser?.username ?? targetId;

    try {
      await client.rest.delete(
        `/guilds/${guildId}/members/${targetId}?reason=${encodeURIComponent(reason)}`
      );
    } catch (err) {
      if (isPermissionError(err)) await notifyOwnerPermError(client, guildId, 'kick', `Could not kick <@${targetId}>: ${err.message}`);
      return message.reply({ embeds: [Embed.danger(`Kick failed: ${err.message}`).toJSON()] });
    }

    const caseNum = await logAction({
      client, guildId, action: 'kick',
      targetId, targetTag,
      executorId, executorTag: message.author.username,
      reason,
    });

    await message.reply({
      embeds: [Embed.success(`Kicked **${targetTag}** | Case #${caseNum}`).toJSON()],
    });
  },
};
