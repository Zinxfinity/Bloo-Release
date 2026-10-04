// ============================================================
//  commands/general/beta.js
//  Category : General  |  Everyone
//
//  b!beta   for beta testers: what's in testing right now. For everyone
//           else: what the beta is and how to join.
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';
import { isBetaTester, betaConfigured, betaCommands } from '../../handlers/betaTesters.js';

export default {
  name: 'beta',
  aliases: ['betatest'],
  description: 'See what beta testers are trying out, or how to become one.',
  usage: '{prefix}beta',
  requiredPermission: null,
  cooldown: 5,

  async execute({ message, prefix, client }) {
    const P = prefix ?? 'b!';
    const support = process.env.REPORT_CONTACT_INVITE;
    const embed = new EmbedBuilder().setColor(COLORS.PURPLE);

    if (await isBetaTester(message.author.id)) {
      const cmds = betaCommands(client);
      embed.setTitle('🧪 Beta testing')
        .setDescription([
          'Thanks for testing! These are in beta right now, for testers only:',
          '',
          cmds.length ? cmds.map(c => `- \`${P}${c.name}\`: ${c.description ?? ''}`).join('\n') : '- Nothing at the moment. New things show up here first.',
          '',
          `Spotted something off? \`${P}feedback\` goes straight to the team, or post in the support server's beta channel.`,
        ].join('\n'));
    } else {
      embed.setTitle('🧪 The Bloo beta')
        .setDescription([
          'Beta testers try new features about a week before everyone else, and help shape them before release.',
          '',
          betaConfigured() && support
            ? `To join, ask for the beta tester role in the [Bloo support server](${support}).`
            : 'There\'s no open beta right now.',
        ].join('\n'));
    }
    return message.reply({ embeds: [embed.toJSON()] });
  },
};
