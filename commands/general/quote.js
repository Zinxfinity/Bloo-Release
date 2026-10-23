// ============================================================
//  commands/general/quote.js
//  Category : General  |  Access 0  |  Rank 0 (public)
//
//  Pulls a message by ID and reposts it as a clean embed.
//  Searches the current channel by default; if the message is in
//  a different channel, provide that channel as a second argument.
//
//  !quote <messageId>
//  !quote <messageId> #channel
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';

export default {
  name: 'quote',
  aliases: ['q'],
  description: 'Re-post a message as a clean embed by its message ID.',
  usage: '{prefix}quote <messageId> [#channel]',
  example: '{prefix}quote 1234567890123456789\n{prefix}quote 1234567890123456789 #general',
  category: 'general',

  requiredPermission: null,

  cooldown: 5,

  async execute({ message, args, client, prefix }) {
    const PREFIX    = prefix ?? process.env.PREFIX ?? 'b!';
    const messageId = args[0];

    if (!messageId || !/^\d{17,20}$/.test(messageId)) {
      await message.reply({
        embeds: [
          Embed.warning('Missing Message ID')
            .setDescription(`Provide the ID of the message to quote.\n\nUsage: \`${PREFIX}quote <messageId>\`\n-# Right-click (or long-press) a message and select **Copy Message ID**.`)
            .toJSON(),
        ],
      });
      return;
    }

    // Optional channel override
    const channelArg      = args[1];
    const channelId       = channelArg?.match(/^<#(\d+)>$/)?.[1] ?? (channelArg?.match(/^\d{17,20}$/) ? channelArg : null);
    const targetChannelId = channelId ?? message.channelId;

    let targetChannel;
    try {
      targetChannel = await client.channels.fetch(targetChannelId);
    } catch {
      await message.reply({
        embeds: [Embed.danger('Channel Not Found').setDescription(`Could not resolve <#${targetChannelId}>.`).toJSON()],
      });
      return;
    }

    let quoted;
    try {
      quoted = await targetChannel.messages.fetch(messageId);
    } catch {
      await message.reply({
        embeds: [
          Embed.danger('Message Not Found')
            .setDescription(
              `Could not find message \`${messageId}\` in <#${targetChannelId}>.` +
              (channelId ? '' : `\n-# If it's in a different channel, add it: \`${PREFIX}quote ${messageId} #channel\``)
            )
            .toJSON(),
        ],
      });
      return;
    }

    const author    = quoted.author;
    const content   = quoted.content || '*No text content*';
    const timestamp = Math.floor(quoted.createdTimestamp / 1000);

    const embed = new EmbedBuilder()
      .setColor(COLORS.MUTED)
      .setAuthor({
        name:    author.username,
        iconURL: author.displayAvatarURL?.() ?? undefined,
      })
      .setDescription(content.slice(0, 2048))
      .addFields(
        { name: '📍 Source', value: `<#${quoted.channelId}>`,  inline: true },
        { name: '🕐 Sent',   value: `<t:${timestamp}:F>`,      inline: true },
        {
          name:   '🔗 Jump',
          value:  `[Click to jump](https://fluxer.app/channels/${message.guildId}/${quoted.channelId}/${quoted.id})`,
          inline: true,
        },
      )
      .setFooter({ text: `Quoted by ${message.author.username}` })
      .setTimestamp();

    // Include first image attachment if present. Not a spoilered or
    // explicit-flagged one (flags 8 and 16): an embed image can't be blurred.
    const image = quoted.attachments?.find?.(a =>
      a.contentType?.startsWith('image/') && !((a.flags ?? 0) & 24) && !/^SPOILER_/i.test(a.filename ?? ''));
    if (image) embed.setImage(image.url);

    await message.send({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
