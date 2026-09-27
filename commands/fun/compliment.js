// ============================================================
//  commands/fun/compliment.js
//  Category : General  |  Access 0  |  Rank 0 (public)
//
//  Send a random genuine compliment to a user.
//  !compliment             , compliment yourself
//  !compliment @user       , compliment someone else
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';

const COMPLIMENTS = [
  "You make this server a better place just by being here. 💛",
  "Your energy is genuinely contagious, in the best way.",
  "The fact that you're here makes this community more interesting.",
  "You're the kind of person people are glad they know.",
  "You have a really good way of looking at things.",
  "You're genuinely one of a kind.",
  "Your presence adds something real to this space.",
  "You handle things with more grace than most people realise.",
  "Whatever you're working on, keep going. It matters.",
  "You're actually really good at being you. That's not easy.",
  "You ask the questions other people are too afraid to ask.",
  "People remember conversations with you. That's rare.",
  "You bring a perspective that this server would be worse without.",
  "The things you care about? Worth caring about.",
  "You're funnier than you probably think you are.",
  "There's a quiet kind of strength in how you show up.",
  "You notice things other people miss.",
  "The world would genuinely be a little smaller without you.",
  "You're more capable than you give yourself credit for.",
  "Something about you just makes people feel at ease.",
];

function parseUserId(arg) {
  return arg?.match(/^<@!?(\d+)>$/)?.[1] ?? null;
}

export default {
  name: 'compliment',
  aliases: ['praise', 'wholesome'],
  description: 'Send a genuine compliment to someone.',
  usage: '{prefix}compliment [@user]',
  category: 'fun',

  requiredPermission: null,

  cooldown: 5,

  async execute({ message, args }) {
    const targetId = parseUserId(args[0]) ?? message.author.id;
    const isSelf   = targetId === message.author.id;
    const compliment = COMPLIMENTS[Math.floor(Math.random() * COMPLIMENTS.length)];

    let displayName = `<@${targetId}>`;
    try {
      const member = message.guild?.members?.cache?.get(targetId);
      displayName  = member ? member.displayName : `<@${targetId}>`;
    } catch { /* fine */ }

    const embed = new EmbedBuilder()
      .setColor(0xF4A7B9) // soft pink, wholesome
      .setTitle(isSelf ? '💛  A little something for you' : `💛  For ${displayName}`)
      .setDescription(compliment)
      .setFooter({
        text: isSelf
          ? `${message.author.username}, you deserve this`
          : `From ${message.author.username} 💌`,
      })
      .setTimestamp();

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
