import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';

const REACTIONS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

export default {
  name: 'poll',
  aliases: ['vote'],
  description: 'Create a poll. Options separated by | for multi-choice.',
  usage: '{prefix}poll <question> [option1 | option2 | ...]',
  requiredPermission: null,

  cooldown: 10,

  async execute({ message, args, client }) {
    if (!args.length) {
      return message.reply({ content: 'Provide a poll question.' });
    }

    const full     = args.join(' ');
    const parts    = full.split('|').map(p => p.trim()).filter(Boolean);
    const question = parts[0];
    const options  = parts.slice(1);

    const embed = new EmbedBuilder().setColor(COLORS.INFO).setTitle(`📊 ${question}`);

    if (options.length >= 2) {
      embed.setDescription(options.map((o, i) => `${REACTIONS[i]} ${o}`).join('\n'));
    } else {
      embed.setDescription('React with 👍 or 👎');
    }

    const msg = await message.send({ embeds: [embed.toJSON()] }).catch(() => null);
    if (!msg) return;

    const reacts = options.length >= 2 ? REACTIONS.slice(0, options.length) : ['👍', '👎'];
    for (const emoji of reacts) {
      try {
        await client.rest.put(
          `/channels/${message.channelId}/messages/${msg.id}/reactions/${encodeURIComponent(emoji)}/@me`
        );
      } catch { /* best effort */ }
    }
  },
};
