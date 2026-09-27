// ============================================================
//  commands/general/8ball.js
//  Category : General  |  Access 0  |  Rank 0 (public)
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';

const RESPONSES = [
  // Positive
  { text: 'It is certain.',       color: COLORS.SUCCESS },
  { text: 'It is decidedly so.',  color: COLORS.SUCCESS },
  { text: 'Without a doubt.',     color: COLORS.SUCCESS },
  { text: 'Yes, definitely.',     color: COLORS.SUCCESS },
  { text: 'You may rely on it.',  color: COLORS.SUCCESS },
  { text: 'As I see it, yes.',    color: COLORS.SUCCESS },
  { text: 'Most likely.',         color: COLORS.SUCCESS },
  { text: 'Outlook good.',        color: COLORS.SUCCESS },
  { text: 'Yes.',                 color: COLORS.SUCCESS },
  { text: 'Signs point to yes.',  color: COLORS.SUCCESS },
  // Neutral
  { text: 'Reply hazy, try again.',            color: COLORS.WARNING },
  { text: 'Ask again later.',                  color: COLORS.WARNING },
  { text: 'Better not tell you now.',          color: COLORS.WARNING },
  { text: 'Cannot predict now.',               color: COLORS.WARNING },
  { text: 'Concentrate and ask again.',        color: COLORS.WARNING },
  // Negative
  { text: "Don't count on it.",   color: COLORS.DANGER },
  { text: 'My reply is no.',      color: COLORS.DANGER },
  { text: 'My sources say no.',   color: COLORS.DANGER },
  { text: 'Outlook not so good.', color: COLORS.DANGER },
  { text: 'Very doubtful.',       color: COLORS.DANGER },
];

export default {
  name: '8ball',
  aliases: ['eightball', 'magic8'],
  description: 'Ask the magic 8-ball a yes/no question.',
  usage: '{prefix}8ball <question>',
  category: 'general',

  requiredPermission: null,

  cooldown: 3,

  async execute({ message, args, prefix }) {
    const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';

    const question = args.join(' ').trim();
    if (!question) {
      await message.reply({
        embeds: [Embed.warning('Missing Question').setDescription(`You need to ask something!\nUsage: \`${PREFIX}8ball <question>\``).toJSON()],
      });
      return;
    }

    const response = RESPONSES[Math.floor(Math.random() * RESPONSES.length)];

    const embed = new EmbedBuilder()
      .setColor(response.color)
      .setTitle('🎱  Magic 8-Ball')
      .addFields(
        { name: '❓ Question', value: question.slice(0, 512),  inline: false },
        { name: '🎱 Answer',   value: response.text,           inline: false },
      )
      .setFooter({ text: `Asked by ${message.author.username}` })
      .setTimestamp();

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
