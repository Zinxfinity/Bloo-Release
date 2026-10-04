import { Embed } from '../../config/embeds.js';
import { releaseQuarantine, listQuarantined } from '../../handlers/commandHandler.js';
import * as resilience from '../../handlers/resilience.js';

// Features (anti-raid on join, automod, the word filter, ...) run through
// resilience.runCritical and switch themselves off after repeated failures,
// the same way commands do. Their keys have a dot in them
// (antiRaid.handleJoin), which is how they're told apart from command names.
const featureLocks = () => resilience.listQuarantined().filter(e => !e.key.startsWith('command.'));

export default {
  name: 'fix',
  description: 'Release a quarantined command or feature.',
  usage: '{prefix}fix [command|feature.key|list]',
  requiredPermission: 'BOT_OWNER',

  cooldown: 0,

  async execute({ message, args, client }) {
    if (!args[0] || args[0] === 'list') {
      const commands = listQuarantined();
      const features = featureLocks();
      if (!commands.length && !features.length) {
        return message.reply({ embeds: [Embed.success('Nothing is quarantined.').toJSON()] });
      }
      const line = (name, error, lockedAt) => `\`${name}\`: ${error?.slice(0, 80) ?? 'Unknown error'} (<t:${Math.floor(lockedAt / 1000)}:R>)`;
      const parts = [];
      if (commands.length) parts.push(`**Commands:**\n${commands.map(q => line(q.name, q.error, q.lockedAt)).join('\n')}`);
      if (features.length) parts.push(`**Features** (switched off until released or restarted):\n${features.map(f => line(f.key, f.error, f.lockedAt)).join('\n')}`);
      return message.reply({ embeds: [Embed.warning(parts.join('\n\n')).toJSON()] });
    }

    // Feature keys are camelCase, so match them case-insensitively.
    if (args[0].includes('.')) {
      const hit = featureLocks().find(f => f.key.toLowerCase() === args[0].toLowerCase());
      if (!hit || !resilience.releaseQuarantine(hit.key)) {
        return message.reply({ embeds: [Embed.danger(`\`${args[0]}\` is not quarantined.`).toJSON()] });
      }
      return message.reply({ embeds: [Embed.success(`Released \`${hit.key}\`. It runs again from the next event.`).toJSON()] });
    }

    const name = args[0].toLowerCase();
    const released = releaseQuarantine(client, name);

    if (!released) {
      return message.reply({ embeds: [Embed.danger(`\`${name}\` is not quarantined.`).toJSON()] });
    }

    await message.reply({ embeds: [Embed.success(`Released \`${name}\` from quarantine.`).toJSON()] });
  },
};
