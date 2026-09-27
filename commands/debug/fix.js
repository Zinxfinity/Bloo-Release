import { Embed } from '../../config/embeds.js';
import { releaseQuarantine, listQuarantined } from '../../handlers/commandHandler.js';

export default {
  name: 'fix',
  description: 'Release a quarantined command.',
  usage: '{prefix}fix [command|list]',
  requiredPermission: 'BOT_OWNER',

  cooldown: 0,

  async execute({ message, args, client }) {
    if (!args[0] || args[0] === 'list') {
      const quarantined = listQuarantined();
      if (!quarantined.length) {
        return message.reply({ embeds: [Embed.success('No commands are quarantined.').toJSON()] });
      }
      const lines = quarantined.map(q =>
        `\`${q.name}\`: ${q.error?.slice(0, 80) ?? 'Unknown error'} (<t:${Math.floor(q.lockedAt / 1000)}:R>)`
      );
      return message.reply({ embeds: [Embed.warning(`**Quarantined commands:**\n${lines.join('\n')}`).toJSON()] });
    }

    const name = args[0].toLowerCase();
    const released = releaseQuarantine(client, name);

    if (!released) {
      return message.reply({ embeds: [Embed.danger(`\`${name}\` is not quarantined.`).toJSON()] });
    }

    await message.reply({ embeds: [Embed.success(`Released \`${name}\` from quarantine.`).toJSON()] });
  },
};
