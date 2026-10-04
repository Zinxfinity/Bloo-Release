// ============================================================
//  commands/fun/reverse.js
//  Category : General  |  Access 0  |  Rank 0 (public)
//
//  Reverses your text. That's it. That's the command.
//  !reverse <text>
//  !reverse @user   , reverses their last message
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';

function parseUserId(arg) {
  return arg?.match(/^<@!?(\d+)>$/)?.[1] ?? null;
}

export default {
  name: 'reverse',
  aliases: ['backwards'], // not "flip": that's b!coinflip
  description: 'Reverse text, or reverse someone\'s last message.',
  usage: '{prefix}reverse <text or @user>',
  category: 'fun',

  requiredPermission: null,

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';

    if (!args.length) {
      await message.reply(`Usage: \`${PREFIX}reverse <text>\` or \`${PREFIX}reverse @user\``).catch(() => {});
      return;
    }

    const targetId = parseUserId(args[0]);
    let text;

    if (targetId && args.length === 1) {
      try {
        const msgs = await client.rest.get(`/channels/${message.channelId}/messages?limit=50`).catch(() => []);
        const last = msgs.find(m => m.author?.id === targetId && m.content?.trim());
        if (!last?.content) {
          await message.reply(`No recent message found from <@${targetId}>.`).catch(() => {});
          return;
        }
        text = last.content;
      } catch {
        await message.reply('Couldn\'t fetch messages to reverse.').catch(() => {});
        return;
      }
    } else {
      text = args.join(' ');
    }

    const reversed = [...text].reverse().join('').slice(0, 500);

    const embed = new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setDescription(`🔄  ${reversed}`)
      .setFooter({ text: `Reversed by ${message.author.username}` });

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
