// ============================================================
//  commands/general/feedback.js
//  Category : General  |  Everyone
//
//  b!feedback <message>   tell the Bloo team what's working, what isn't,
//                         or what put you off. Private: only bot owners
//                         see it (Developer → Server Insights).
// ============================================================

import { Embed } from '../../config/embeds.js';
import { addFeedback, FeedbackError } from '../../handlers/serverInsights.js';

export default {
  name: 'feedback',
  aliases: [],
  description: 'Tell the Bloo team what\'s working and what isn\'t. Only the team sees it.',
  usage: '{prefix}feedback <message>',
  requiredPermission: null,
  cooldown: 30,

  async execute({ message, args, prefix, client }) {
    const P = prefix ?? 'b!';
    const text = args.join(' ').trim();
    if (!text) {
      return message.reply({ embeds: [Embed.info([
        `\`${P}feedback <message>\` sends a private note to the Bloo team: something that confused you, something you'd change, or something you liked.`,
        `Only the team sees it. For ideas you'd like others to vote on, use \`${P}suggest\` instead.`,
      ].join('\n\n'), '📨 Feedback').toJSON()] });
    }
    try {
      const guild = message.guildId ? client.guilds.cache.get(message.guildId) : null;
      await addFeedback({
        userId: message.author.id,
        username: message.author.globalName || message.author.username,
        guildId: message.guildId ?? null,
        guildName: guild?.name ?? null,
        text,
      });
      return message.reply({ embeds: [Embed.success('Thanks, that\'s with the team now. Every note gets read.').toJSON()] });
    } catch (err) {
      if (err instanceof FeedbackError) return message.reply({ embeds: [Embed.warning(err.message).toJSON()] });
      throw err;
    }
  },
};
