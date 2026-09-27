import { Embed } from '../../config/embeds.js';
import { logAction } from '../../handlers/modLog.js';
import { parseUserMention } from '@fluxerjs/core';
import { Permissions } from '../../config/guildPermissions.js';
import { syncUnbanAcrossGroup } from '../../handlers/banSync.js';
import { clearPendingTempbans } from '../../handlers/warnSystem.js';

export default {
  name: 'unban',
  aliases: ['ub'],
  description: 'Unban a user by ID.',
  usage: '{prefix}unban <userId> [reason]',
  requiredPermission: Permissions.MANAGE_GUILD,

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const guildId    = message.guildId;
    const executorId = message.author.id;

    const targetRaw = args[0];
    if (!targetRaw) {
      return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}unban <userId> [reason]\``).toJSON()] });
    }

    const targetId = parseUserMention(targetRaw) ?? targetRaw.replace(/\D/g, '');
    const reason   = args.slice(1).join(' ') || 'No reason provided.';
    if (!/^\d{15,22}$/.test(targetId)) {
      return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}unban <userId> [reason]\``).toJSON()] });
    }

    const targetUser = await client.rest.get(`/users/${targetId}`).catch(() => null);
    const targetTag  = targetUser?.username ?? targetId;

    try {
      await client.rest.delete(`/guilds/${guildId}/bans/${targetId}`);
    } catch (err) {
      return message.reply({ embeds: [Embed.danger(`Unban failed: ${err.message}`).toJSON()] });
    }
    clearPendingTempbans(guildId, targetId);

    const caseNum = await logAction({
      client, guildId, action: 'unban',
      targetId, targetTag,
      executorId, executorTag: message.author.username,
      reason,
    });

    syncUnbanAcrossGroup(client, guildId, targetId).catch(() => {});

    await message.reply({
      embeds: [Embed.success(`Unbanned **${targetTag}** | Case #${caseNum}`).toJSON()],
    });
  },
};
