// ============================================================
//  commands/general/advpoll.js
//
//  !advpoll <single|multiple> <dd/MM/yyyy>
//  <question>
//  <description, or a blank line if none>
//  <choice 1>
//  <choice 2>
//  ... up to 10 choices, one per line
//
//  Live-tallied replacement for !poll: single or multi-choice voting,
//  results visible as the poll runs (not just at the end), a host/mod
//  "Close Vote" reaction to end it early, and an expiry date instead of
//  running forever. See handlers/advPoll.js for the vote-tracking/embed
//  logic this command only kicks off.
// ============================================================

import { Embed } from '../../config/embeds.js';
import { parseAdvPoll, createPoll, attachMessage, buildPollEmbed, getOptions, NUMBER_EMOJIS, CLOSE_EMOJI, MAX_CHOICES } from '../../handlers/advPoll.js';

export default {
  name: 'advpoll',
  aliases: [],
  description: 'Create a live-tallied poll with single or multi-choice voting and an expiry date.',
  usage: '{prefix}advpoll <single|multiple> <dd/MM/yyyy> (then question/description/choices on following lines)',
  category: 'general',

  requiredPermission: null,

  cooldown: 10,

  async execute({ message, client, prefix }) {
    const guildId = message.guildId;
    if (!guildId) {
      await message.reply({ embeds: [Embed.danger('Server only.').toJSON()] }).catch(() => {});
      return;
    }

    const parsed = parseAdvPoll(message.content);
    if (!parsed.ok) {
      const cmdWord = message.content.split('\n')[0].trim().split(/\s+/)[0] || `${prefix}advpoll`;
      await message.reply({
        embeds: [Embed.warning(
          `${parsed.error}\n\n**Format:**\n\`\`\`\n${cmdWord} <single|multiple> <dd/MM/yyyy>\n<question>\n<description or blank line>\n<choice 1>\n<choice 2>\n<up to ${MAX_CHOICES} choices>\n\`\`\``
        ).toJSON()],
      }).catch(() => {});
      return;
    }

    const { mode, endsAt, question, description, choices } = parsed;
    const { poll, options } = createPoll(guildId, message.channelId, message.author.id, mode, question, description, endsAt, choices);

    const embed = buildPollEmbed(poll, options);
    const msg = await message.send({ embeds: [embed] }).catch(() => null);
    if (!msg) return;

    attachMessage(poll.id, msg.id);

    // Seed the numbered option reactions plus the close-vote reaction, then
    // strip any OTHER reaction a user adds later (handled in
    // events/guild/reactionAdd.js) so people can't clutter the poll.
    const reactEmojis = [...NUMBER_EMOJIS.slice(0, choices.length), CLOSE_EMOJI];
    for (const emoji of reactEmojis) {
      try {
        await client.rest.put(`/channels/${message.channelId}/messages/${msg.id}/reactions/${encodeURIComponent(emoji)}/@me`);
      } catch { /* best effort */ }
    }
  },
};
