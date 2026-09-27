// ============================================================
//  commands/utility/roleinfo.js
//  Category : Utility  |  Access 0  |  Rank 0 (public)
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';

function parseRoleId(arg) {
  if (!arg) return null;
  return arg.match(/^<@&(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

function snowflakeToDate(id) {
  return new Date(Number(BigInt(id) >> 22n) + 1420070400000);
}

export default {
  name: 'roleinfo',
  aliases: ['ri'],
  description: 'Show information about a role: colour, permissions, and member count.',
  usage: '{prefix}roleinfo <@role | roleId>',
  category: 'utility',

  requiredPermission: null,

  cooldown: 5,

  async execute({ message, args, client, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;

    if (!guildId) {
      await message.reply({ embeds: [Embed.danger('Server Only').setDescription('This command can only be used inside a server.').toJSON()] }).catch(() => {});
      return;
    }

    const roleId = parseRoleId(args[0]);
    if (!roleId) {
      await message.reply({
        embeds: [Embed.warning('Missing Role').setDescription(`Mention a role or provide its ID.\nUsage: \`${PREFIX}roleinfo <@role|roleId>\``).toJSON()],
      });
      return;
    }

    // Fetch all roles via REST and find the matching one
    let role;
    try {
      const roles = await client.rest.get(`/guilds/${guildId}/roles`);
      role = Array.isArray(roles) ? roles.find(r => r.id === roleId) : null;
    } catch (err) {
      await message.reply({ embeds: [Embed.danger('Fetch Failed').setDescription('Could not retrieve role data. Please try again.').toJSON()] }).catch(() => {});
      return;
    }

    if (!role) {
      await message.reply({ embeds: [Embed.danger('Role Not Found').setDescription(`No role with ID \`${roleId}\` was found in this server.`).toJSON()] }).catch(() => {});
      return;
    }

    // Fluxer API doesn't expose per-role member counts without fetching all members
    const memberCount = null;

    const createdAt = snowflakeToDate(roleId);
    const createdTs = Math.floor(createdAt.getTime() / 1000);

    // Hex color from role
    const roleHex   = role.color ? `#${role.color.toString(16).padStart(6, '0').toUpperCase()}` : 'No colour';
    const embedColor = role.color ? role.color : COLORS.MUTED;

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle(`🎭  ${role.name}`)
      .addFields(
        { name: '🆔 Role ID',     value: `\`${roleId}\``,                         inline: true  },
        { name: '🎨 Colour',      value: roleHex,                                  inline: true  },
        { name: '📅 Created',     value: `<t:${createdTs}:D> (<t:${createdTs}:R>)`,inline: false },
        { name: '📌 Position',    value: `${role.position ?? 'Unknown'}`,           inline: true  },
        { name: '🔔 Mentionable', value: role.mentionable ? 'Yes' : 'No',           inline: true  },
        { name: '📢 Hoisted',     value: role.hoist       ? 'Yes' : 'No',           inline: true  },
        { name: '🤖 Managed',     value: role.managed     ? 'Yes (bot/integration)' : 'No', inline: true },
      );

    if (memberCount !== null) {
      embed.addFields({ name: '👥 Members', value: `${memberCount}`, inline: true });
    }

    embed.setFooter({ text: `Requested by ${message.author.username}` }).setTimestamp();

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};