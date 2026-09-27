// ============================================================
//  commands/fun/mock.js
//  Category : General  |  Access 0  |  Rank 0 (public)
//
//  Transforms text into SpOnGeBoB mOcKiNg TExT.
//  !mock some text here
//  !mock @user (quotes their last message in this channel)
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';

function mockText(text) {
  let upper = true;
  return text.split('').map(char => {
    if (!/[a-zA-Z]/.test(char)) return char;
    const result = upper ? char.toUpperCase() : char.toLowerCase();
    upper = !upper;
    return result;
  }).join('');
}

function parseUserId(arg) {
  return arg?.match(/^<@!?(\d+)>$/)?.[1] ?? null;
}

export default {
  name: 'mock',
  aliases: ['spongebob', 'mocktext'],
  description: 'Convert text to SpOnGeBoB mOcKiNg format.',
  usage: '{prefix}mock <text or @user>',
  category: 'fun',

  requiredPermission: null,

  cooldown: 5,

  async execute({ message, args, prefix, client }) {
    const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';

    if (!args.length) {
      await message.reply(`Usage: \`${PREFIX}mock <text>\``).catch(() => {});
      return;
    }

    // If mentioning a user, try to find their last message
    const targetId = parseUserId(args[0]);
    let text;

    if (targetId && args.length === 1) {
      // Fetch recent messages and find the last one from that user
      try {
        const msgs = await client.rest.get(`/channels/${message.channelId}/messages?limit=50`).catch(() => []);
        const last = msgs.find(m => m.author?.id === targetId && m.content?.trim());
        if (last?.content) {
          text = last.content;
        } else {
          await message.reply(`Couldn't find a recent message from <@${targetId}>.`).catch(() => {});
          return;
        }
      } catch {
        await message.reply('Couldn\'t fetch recent messages to mock.').catch(() => {});
        return;
      }
    } else {
      text = args.join(' ');
    }

    const mocked = mockText(text).slice(0, 500);

    const embed = new EmbedBuilder()
      .setColor(COLORS.WARNING)
      .setDescription(`🧽  ${mocked}`)
      .setFooter({ text: `Mocked by ${message.author.username}` });

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
