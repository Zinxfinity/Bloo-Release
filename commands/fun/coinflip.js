// ============================================================
//  commands/fun/coinflip.js
//  Category : General  |  Access 0  |  Rank 0 (public)
//
//  Flip a coin. Optionally guess heads or tails first.
//  !coinflip          , flip
//  !coinflip heads    , flip and reveal if you were right
//  !coinflip tails
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';

export default {
  name: 'coinflip',
  aliases: ['flip', 'coin'],
  description: 'Flip a coin. Optionally guess heads or tails.',
  usage: '{prefix}coinflip [heads|tails]',
  category: 'fun',

  requiredPermission: null,

  cooldown: 3,

  async execute({ message, args, prefix }) {
    // This command owns the `coinflip` name; betting lives on the economy
    // command's `cf` alias, so point anyone who typed a bet there.
    if (/^\d+$/.test(args[0] ?? '')) {
      await message.reply({ content: `To bet coins, use \`${prefix ?? 'b!'}cf <bet> <heads|tails>\`.` }).catch(() => {});
      return;
    }
    const guess  = args[0]?.toLowerCase();
    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    const emoji  = result === 'heads' ? '🟡' : '⚪';

    let title = `${emoji}  ${result.charAt(0).toUpperCase() + result.slice(1)}!`;
    let color = COLORS.INFO;
    let extra  = '';

    if (guess === 'heads' || guess === 'tails') {
      const correct = guess === result;
      color = correct ? COLORS.SUCCESS : COLORS.DANGER;
      extra = correct
        ? `\nYou guessed **${guess}**. ✅ correct!`
        : `\nYou guessed **${guess}**. ❌ wrong!`;
    }

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(`The coin landed on **${result}**.${extra}`)
      .setFooter({ text: `Flipped by ${message.author.username}` })
      .setTimestamp();

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
