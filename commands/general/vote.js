// ============================================================
//  commands/general/vote.js
//  Category : General  |  Everyone
//
//  b!vote   where to vote for Bloo on FluxerList, whether you have, and
//           what voters get. Perks last as long as the vote does.
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS, Embed } from '../../config/embeds.js';
import { checkVote, voteUrl, votingConfigured } from '../../handlers/votes.js';

const perks = () => [
  '💚 a **Supporter** badge on your rank and profile card',
  '✨ the **Supporter** card theme (`b!card theme supporter`)',
  process.env.VOTE_SUPPORT_GUILD_ID && process.env.VOTE_SUPPORTER_ROLE_ID ? '🏷️ the **Supporter** role in the Bloo support server' : null,
].filter(Boolean);

export default {
  name: 'vote',
  aliases: ['upvote', 'supporter'],
  description: 'Vote for Bloo on FluxerList and see what voters get.',
  usage: '{prefix}vote',
  requiredPermission: null,
  cooldown: 5,

  async execute({ message, client }) {
    const url = voteUrl();
    if (!url) return message.reply({ embeds: [Embed.info('Voting isn\'t set up for this bot.').toJSON()] });

    const { voted, votes, offline } = await checkVote(client, message.author.id, message.author.username);
    const embed = new EmbedBuilder().setColor(voted ? COLORS.SUCCESS : COLORS.INFO);
    if (voted) {
      embed.setTitle('Thanks for voting for Bloo 💚')
        .setDescription([
          'Your vote helps more servers find Bloo. While it stands, you have:',
          ...perks().map(p => `- ${p}`),
        ].join('\n'));
    } else {
      embed.setTitle('Vote for Bloo')
        .setDescription([
          `Voting on **[FluxerList](${url})** is free and takes a few seconds. It helps more servers find Bloo.`,
          '',
          'As a thank-you, you get:',
          ...perks().map(p => `- ${p}`),
          '',
          'It\'s one vote per person, and the perks last as long as your vote does. Run `b!vote` again afterwards to check.',
        ].join('\n'));
    }
    const foot = [votes != null ? `${votes} vote${votes === 1 ? '' : 's'} so far` : null, offline && votingConfigured() ? 'Couldn\'t reach FluxerList just now; showing what Bloo last saw' : null].filter(Boolean);
    if (foot.length) embed.setFooter({ text: foot.join(' · ') });
    return message.reply({ embeds: [embed.toJSON()] });
  },
};
