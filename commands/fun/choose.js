// ============================================================
//  commands/fun/choose.js
//  Category : General  |  Access 0  |  Rank 0 (public)
//
//  Can't decide? Let the bot choose.
//  Separate options with | or commas.
//
//  !choose pizza | tacos | sushi
//  !choose yes, no, maybe
//  !choose go outside, stay inside
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';

export default {
  name: 'choose',
  aliases: ['pick', 'decide'],
  description: 'Can\'t decide? Give the bot options and it\'ll pick one.',
  usage: '{prefix}choose option1 | option2 | option3',
  category: 'fun',

  requiredPermission: null,

  cooldown: 3,

  async execute({ message, args, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const raw     = args.join(' ').trim();

    if (!raw) {
      await message.reply(`Usage: \`${PREFIX}choose option1 | option2 | option3\``).catch(() => {});
      return;
    }

    // Split on | first, then comma if no | found
    let options = raw.includes('|')
      ? raw.split('|').map(o => o.trim()).filter(Boolean)
      : raw.split(',').map(o => o.trim()).filter(Boolean);

    if (options.length < 2) {
      await message.reply('Give me at least **2 options** to choose from, separated by `|` or `,`.').catch(() => {});
      return;
    }

    if (options.length > 20) {
      await message.reply('Maximum **20 options** at a time. Trim the list down a bit!').catch(() => {});
      return;
    }

    const chosen = options[Math.floor(Math.random() * options.length)];
    const list   = options.map((o, i) => `${i + 1}. ${o}`).join('\n');

    const embed = new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle('🎲  I choose...')
      .setDescription(`**${chosen}**`)
      .addFields({ name: `Options (${options.length})`, value: list.slice(0, 1024), inline: false })
      .setFooter({ text: `Asked by ${message.author.username}` })
      .setTimestamp();

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
