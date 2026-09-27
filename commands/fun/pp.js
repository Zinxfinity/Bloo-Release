// ============================================================
//  commands/fun/pp.js
//  Category : General  |  Access 0  |  Rank 0 (public)
//
//  Classic pp size command. Uses a seeded hash, same user
//  always gets the same result (it's "consistent").
//  Completely harmless, no real measurements involved.
//
//  !pp          , measure yourself
//  !pp @user    , measure someone else
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0;
  }
  return h;
}

const COMMENTS = [
  'Legally cannot comment.',
  'The confidence it takes to check this.',
  'Interesting.',
  'The science is settled.',
  'Perfectly average. As all things should be.',
  'The Fluxer Elders have spoken.',
  'Statistically significant.',
  'Peer reviewed.',
  'No further questions.',
  'We don\'t make the rules.',
  'Certified.',
  'This is what it is.',
  'The numbers don\'t lie.',
  'I\'m just the messenger.',
];

function parseUserId(arg) {
  return arg?.match(/^<@!?(\d+)>$/)?.[1] ?? null;
}

export default {
  name: 'pp',
  aliases: ['ppsize', 'howbig'],
  description: 'The bot measures your pp. Results are... consistent.',
  usage: '{prefix}pp [@user]',
  category: 'fun',

  requiredPermission: null,

  cooldown: 5,

  async execute({ message, args }) {
    const targetId = parseUserId(args[0]) ?? message.author.id;
    const size     = hashString(targetId + 'pp2025') % 13; // 0–12
    const bar      = '8' + '='.repeat(size) + 'D';

    const comment = COMMENTS[hashString(targetId) % COMMENTS.length];

    let displayName = `<@${targetId}>`;
    try {
      const member = message.guild?.members?.cache?.get(targetId);
      displayName  = member ? `**${member.displayName}**` : `<@${targetId}>`;
    } catch { /* fine */ }

    const isSelf = targetId === message.author.id;

    const embed = new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle(`📏  PP Size${isSelf ? '' : `: ${displayName}`}`)
      .setDescription(`${isSelf ? message.author.username : displayName}'s pp:\n\n\`${bar}\`  (${size} inches)\n\n*${comment}*`)
      .setFooter({ text: 'Results are 100% accurate and peer-reviewed.' })
      .setTimestamp();

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
