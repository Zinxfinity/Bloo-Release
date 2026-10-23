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
import { isBotOwner } from '../../config/dashAccess.js';

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
      // ECONOMY-BETA: remove at launch.
      const ecoOpen = !!(await import('../../handlers/economy/betaTest.js').catch(() => null))?.betaOpen();
      const lines = [
        ...(ecoOpen ? ['- **The economy game**: open to testers in the support server\'s economy channel. Check the latest round post there for what to test.'] : []),
        ...cmds.map(c => `- \`${P}${c.name}\`: ${c.description ?? ''}`),
      ];
      embed.setTitle('🧪 You\'re a beta tester')
        .setDescription([
          lines.length
            ? `Thanks for helping! You can try these before everyone else:\n\n${lines.join('\n')}`
            : 'There\'s nothing to test right now. When something new is ready, it\'ll be listed here and announced in the support server\'s beta channel.',
          '',
          `Found a bug, or something confusing? Tell us with \`${P}feedback\`, or post in the beta channel.`,
          // Bot owners count as testers without the role.
          ...(isBotOwner(message.author.id) ? ['', '-# You see this because you\'re a bot owner.'] : []),
        ].join('\n'));
    } else {
      embed.setTitle('🧪 The Bloo beta')
        .setDescription([
          'Beta testers get to try new features before everyone else, and help us fix them before release.',
          '',
          betaConfigured() && support
            ? `**How to join:** join the [Bloo support server](${support}) and ask the team for the Beta Tester role. Once you have it, run \`${P}beta\` again to see what's being tested.`
            : 'The beta isn\'t open to new testers right now.',
        ].join('\n'));
    }
    return message.reply({ embeds: [embed.toJSON()] });
  },
};
