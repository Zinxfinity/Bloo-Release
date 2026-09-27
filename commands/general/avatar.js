import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';
import { parseUserMention } from '@fluxerjs/core';

export default {
  name: 'avatar',
  aliases: ['av', 'pfp'],
  description: "Show a user's avatar.",
  usage: '{prefix}avatar [@user|id]',
  requiredPermission: null,

  cooldown: 3,

  async execute({ message, args, client }) {
    const targetId = args[0]
      ? (parseUserMention(args[0]) ?? args[0].replace(/\D/g, ''))
      : message.author.id;

    const user = await client.rest.get(`/users/${targetId}`).catch(() => null);
    if (!user) return message.reply({ content: 'Could not resolve that user.' });

    const avatarUrl = user.avatar
      ? `https://fluxerusercontent.com/avatars/${user.id}/${user.avatar}.png?size=512`
      : null;

    const embed = new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle(`${user.username}'s avatar`);

    if (avatarUrl) {
      embed.setImage(avatarUrl);
    } else {
      embed.setDescription('This user has no avatar.');
    }

    await message.reply({ embeds: [embed.toJSON()] });
  },
};
