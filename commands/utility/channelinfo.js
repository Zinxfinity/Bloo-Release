// ============================================================
//  commands/utility/channelinfo.js
//  Category : Utility  |  Access 0  |  Rank 0 (public)
//
//  Shows info about the current channel or a specified channel.
//  !channelinfo
//  !channelinfo #channel
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import { isChannelInGuild } from '../../utils/channelGuard.js';

const CHANNEL_TYPES = {
  0:  'Text Channel',
  2:  'Voice Channel',
  4:  'Category',
  5:  'Announcement Channel',
  10: 'Announcement Thread',
  11: 'Public Thread',
  12: 'Private Thread',
  13: 'Stage Channel',
  15: 'Forum Channel',
};

function snowflakeToDate(id) {
  return new Date(Number(BigInt(id) >> 22n) + 1420070400000);
}

function formatSlowmode(seconds) {
  if (!seconds || seconds === 0) return 'Off';
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export default {
  name: 'channelinfo',
  aliases: ['channel', 'cinfo'],
  description: 'Show details about a channel: type, topic, slowmode, and more.',
  usage: '{prefix}channelinfo [#channel]',
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

    // Resolve channel, mention, ID, or current
    const channelArg = args[0];
    const channelId  = channelArg?.match(/^<#(\d+)>$/)?.[1]
      ?? (channelArg?.match(/^\d{17,20}$/) ? channelArg : null)
      ?? message.channelId;

    // Public command: never describe channels outside this server (another
    // server's private channel names/topics would leak otherwise).
    if (channelId !== message.channelId && !await isChannelInGuild(client, guildId, channelId)) {
      await message.reply({ embeds: [Embed.danger('Channel Not Found').setDescription('That channel is not in this server.').toJSON()] }).catch(() => {});
      return;
    }

    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch {
      await message.reply({ embeds: [Embed.danger('Channel Not Found').setDescription(`Could not resolve <#${channelId}>.`).toJSON()] }).catch(() => {});
      return;
    }

    const createdAt = snowflakeToDate(channel.id);
    const createdTs = Math.floor(createdAt.getTime() / 1000);
    const typeName  = CHANNEL_TYPES[channel.type] ?? `Type ${channel.type}`;

    const embed = new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle(`📍  #${channel.name ?? channelId}`)
      .addFields(
        { name: '🆔 Channel ID',  value: `\`${channel.id}\``,                          inline: true  },
        { name: '📂 Type',        value: typeName,                                       inline: true  },
        { name: '📅 Created',     value: `<t:${createdTs}:D> (<t:${createdTs}:R>)`,     inline: false },
      );

    if (channel.topic) {
      embed.addFields({ name: '📝 Topic', value: channel.topic.slice(0, 512), inline: false });
    }

    if (channel.rateLimitPerUser !== undefined) {
      embed.addFields({ name: '🐢 Slowmode', value: formatSlowmode(channel.rateLimitPerUser), inline: true });
    }

    if (channel.nsfw !== undefined) {
      embed.addFields({ name: '🔞 Age-restricted', value: channel.nsfw ? 'Yes' : 'No', inline: true });
    }

    if (channel.parentId) {
      embed.addFields({ name: '📁 Category', value: `<#${channel.parentId}>`, inline: true });
    }

    if (channel.position !== undefined) {
      embed.addFields({ name: '📌 Position', value: `${channel.position}`, inline: true });
    }

    embed.setFooter({ text: `Requested by ${message.author.username}` }).setTimestamp();

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
