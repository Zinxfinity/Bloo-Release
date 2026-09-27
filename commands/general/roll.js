// ============================================================
//  commands/general/roll.js
//  Category : General  |  Access 0  |  Rank 0 (public)
//
//  Dice roller. Supports standard NdN notation.
//  !roll          → 1d6
//  !roll d20      → 1d20
//  !roll 2d6      → roll 2 six-sided dice, show each + total
//  !roll 4d10     → up to 20 dice, up to 1000 sides
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';

const MAX_DICE  = 20;
const MAX_SIDES = 1000;

function parseRoll(input) {
  if (!input) return { count: 1, sides: 6 };
  const match = input.toLowerCase().match(/^(\d+)?d(\d+)$/);
  if (!match) return null;
  return {
    count: parseInt(match[1] ?? '1', 10),
    sides: parseInt(match[2], 10),
  };
}

export default {
  name: 'roll',
  aliases: ['dice', 'r'],
  description: 'Roll dice. Supports NdN notation like `2d6`, `d20`, and `4d10`.',
  usage: '{prefix}roll [NdN]',
  category: 'general',

  requiredPermission: null,

  cooldown: 3,

  async execute({ message, args, prefix }) {
    const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';
    const parsed = parseRoll(args[0]);

    if (!parsed) {
      await message.reply({
        embeds: [
          Embed.warning('Invalid Format')
            .setDescription(`Use dice notation like \`d6\`, \`2d10\`, \`4d20\`.\nUsage: \`${PREFIX}roll [NdN]\``)
            .toJSON(),
        ],
      });
      return;
    }

    const { count, sides } = parsed;

    if (sides < 2) {
      await message.reply({ embeds: [Embed.warning('Invalid Dice').setDescription('Dice must have at least 2 sides.').toJSON()] }).catch(() => {});
      return;
    }
    if (sides > MAX_SIDES) {
      await message.reply({ embeds: [Embed.warning('Too Many Sides').setDescription(`Maximum is **${MAX_SIDES}** sides per die.`).toJSON()] }).catch(() => {});
      return;
    }
    if (count < 1) {
      await message.reply({ embeds: [Embed.warning('Invalid Count').setDescription('Must roll at least 1 die.').toJSON()] }).catch(() => {});
      return;
    }
    if (count > MAX_DICE) {
      await message.reply({ embeds: [Embed.warning('Too Many Dice').setDescription(`Maximum is **${MAX_DICE}** dice per roll.`).toJSON()] }).catch(() => {});
      return;
    }

    const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
    const total = rolls.reduce((a, b) => a + b, 0);
    const isNat = count === 1 && (rolls[0] === sides || rolls[0] === 1);

    // Colour by result: nat max = green, nat 1 = red, otherwise blurple
    let color = COLORS.INFO;
    if (isNat && rolls[0] === sides) color = COLORS.SUCCESS;
    if (isNat && rolls[0] === 1)     color = COLORS.DANGER;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`🎲  ${count}d${sides}`)
      .setFooter({ text: `Rolled by ${message.author.username}` })
      .setTimestamp();

    if (count === 1) {
      embed.setDescription(`# ${rolls[0]}${isNat && rolls[0] === sides ? '\n✨ Natural max!' : isNat ? '\n💀 Natural 1!' : ''}`);
    } else {
      embed.setDescription(`**Rolls:** ${rolls.join(', ')}\n**Total:** \`${total}\``);
      embed.addFields(
        { name: 'Highest', value: `${Math.max(...rolls)}`, inline: true },
        { name: 'Lowest',  value: `${Math.min(...rolls)}`, inline: true },
        { name: 'Average', value: `${(total / count).toFixed(1)}`, inline: true },
      );
    }

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
