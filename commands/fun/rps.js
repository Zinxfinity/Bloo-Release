// ============================================================
//  commands/fun/rps.js
//  Category : General  |  Access 0  |  Rank 0 (public)
//
//  Rock, Paper, Scissors against the bot.
//  !rps rock   |  !rps paper  |  !rps scissors
//  Aliases also accept r / p / s
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';

const MOVES = { rock: '🪨', paper: '📄', scissors: '✂️' };
const ALIASES = { r: 'rock', p: 'paper', s: 'scissors' };

// 1 = player wins, -1 = bot wins, 0 = tie
function result(player, bot) {
  if (player === bot) return 0;
  if (
    (player === 'rock'     && bot === 'scissors') ||
    (player === 'paper'    && bot === 'rock')     ||
    (player === 'scissors' && bot === 'paper')
  ) return 1;
  return -1;
}

export default {
  name: 'rps',
  aliases: ['rockpaperscissors'],
  description: 'Play Rock, Paper, Scissors against the bot.',
  usage: '{prefix}rps <rock|paper|scissors>',
  category: 'fun',

  requiredPermission: null,

  cooldown: 3,

  async execute({ message, args, prefix }) {
    const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';
    const raw    = args[0]?.toLowerCase();
    const player = ALIASES[raw] ?? (MOVES[raw] ? raw : null);

    if (!player) {
      await message.reply(`Usage: \`${PREFIX}rps <rock|paper|scissors>\``).catch(() => {});
      return;
    }

    const botMoves = Object.keys(MOVES);
    const bot      = botMoves[Math.floor(Math.random() * botMoves.length)];
    const outcome  = result(player, bot);

    const title  = outcome === 1  ? '🏆  You win!'
                 : outcome === -1 ? '🤖  Bot wins!'
                 : '🤝  It\'s a tie!';

    const color  = outcome === 1  ? COLORS.SUCCESS
                 : outcome === -1 ? COLORS.DANGER
                 : COLORS.WARNING;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .addFields(
        { name: `${message.author.username}`, value: `${MOVES[player]} ${player}`, inline: true },
        { name: 'vs',                          value: '⚔️',                         inline: true },
        { name: 'Bot',                         value: `${MOVES[bot]} ${bot}`,       inline: true },
      )
      .setFooter({ text: `Played by ${message.author.username}` })
      .setTimestamp();

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
