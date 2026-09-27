// ============================================================
//  commands/fun/ship.js
//  Category : General  |  Access 0  |  Rank 0 (public)
//
//  Ship two users (or yourself + another) and get a love %.
//  Uses a seeded hash so the same pair always gets the same score.
//
//  !ship @user1 @user2   , ship two specific users
//  !ship @user           , ship yourself with that user
//  !ship                 , ship yourself with a random member
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';

// Simple non-crypto string hash, deterministic per pair
function hashPair(a, b) {
  const sorted = [a, b].sort().join(':');
  let h = 5381;
  for (let i = 0; i < sorted.length; i++) {
    h = ((h << 5) + h) ^ sorted.charCodeAt(i);
    h = h >>> 0; // keep unsigned
  }
  return h;
}

function parseUserId(arg) {
  return arg?.match(/^<@!?(\d+)>$/)?.[1] ?? (arg?.match(/^\d{17,20}$/) ? arg : null);
}

const RATINGS = [
  // 0–20
  { min: 0,  max: 20,  label: '💀 Certified Disaster',          color: 0xED4245 },
  // 21–40
  { min: 21, max: 40,  label: '🧊 It\'s giving friendship',     color: 0x5DADE2 },
  // 41–60
  { min: 41, max: 60,  label: '🤷 Possible… maybe… who knows', color: 0xFEE75C },
  // 61–80
  { min: 61, max: 80,  label: '🌸 A cute vibe for sure',        color: 0xEB459E },
  // 81–99
  { min: 81, max: 99,  label: '💞 Practically soulmates',       color: 0x57F287 },
  // 100
  { min: 100, max: 100, label: '👑 Literally perfect',          color: 0xFFD700 },
];

function getRating(score) {
  return RATINGS.find(r => score >= r.min && score <= r.max);
}

function progressBar(score) {
  const filled = Math.round(score / 10);
  return '❤️'.repeat(filled) + '🤍'.repeat(10 - filled);
}

export default {
  name: 'ship',
  aliases: ['love', 'compatibility'],
  description: 'Ship two users and see their love compatibility score.',
  usage: '{prefix}ship [@user1] [@user2]',
  category: 'fun',

  requiredPermission: null,

  cooldown: 5,

  async execute({ message, args, prefix }) {
    const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';
    const authorId = message.author.id;
    const guildId  = message.guildId;

    let idA, idB;

    if (args.length >= 2) {
      idA = parseUserId(args[0]);
      idB = parseUserId(args[1]);
    } else if (args.length === 1) {
      idA = authorId;
      idB = parseUserId(args[0]);
    } else {
      // Random guild member
      idA = authorId;
      const members = message.guild?.members?.cache;
      if (!members || members.size < 2) {
        await message.reply(`Usage: \`${PREFIX}ship @user1 @user2\``).catch(() => {});
        return;
      }
      const others = [...members.keys()].filter(id => id !== authorId);
      idB = others[Math.floor(Math.random() * others.length)];
    }

    if (!idA || !idB) {
      await message.reply({ content: `Usage: \`${PREFIX}ship @user1 @user2\`` }).catch(() => {});
      return;
    }

    if (idA === idB) {
      await message.reply({ content: `💯 Self-love is valid actually. 100%` }).catch(() => {});
      return;
    }

    const score   = hashPair(idA, idB) % 101; // 0–100
    const rating  = getRating(score);
    const bar     = progressBar(score);

    // Build ship name from usernames, embed titles can't render mentions,
    // so this must always resolve to a real displayable name, never `<@id>`.
    let nameA = 'Unknown', nameB = 'Unknown';
    try {
      const memberA = message.guild?.members?.cache?.get(idA);
      const memberB = message.guild?.members?.cache?.get(idB);
      nameA = memberA?.displayName ?? message.client?.users?.cache?.get(idA)?.username ?? 'Unknown';
      nameB = memberB?.displayName ?? message.client?.users?.cache?.get(idB)?.username ?? 'Unknown';
    } catch { /* fine */ }

    const shipName = nameA.slice(0, Math.ceil(nameA.length / 2)) +
                     nameB.slice(Math.floor(nameB.length / 2));

    const embed = new EmbedBuilder()
      .setColor(rating.color)
      .setTitle(`💘  Ship: ${shipName}`)
      .setDescription(`<@${idA}> ❤️ <@${idB}>`)
      .addFields(
        { name: 'Score',  value: `**${score}%**`,   inline: true },
        { name: 'Rating', value: rating.label,       inline: true },
      )
      .addFields({ name: 'Love Meter', value: bar, inline: false })
      .setFooter({ text: `Shipped by ${message.author.username}` })
      .setTimestamp();

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
