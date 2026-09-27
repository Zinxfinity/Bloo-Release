import { Embed } from '../../config/embeds.js';
import { setPrefix } from '../../handlers/guildSettings.js';
import { Permissions } from '../../config/guildPermissions.js';

export default {
  name: 'prefix',
  description: 'Set or reset the bot prefix for this server.',
  usage: '{prefix}prefix <new prefix> | {prefix}prefix reset',
  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 5,

  async execute({ message, args, prefix }) {
    const guildId = message.guildId;

    if (!args[0]) {
      return message.reply({ embeds: [Embed.info(`Current prefix: \`${prefix}\``).toJSON()] });
    }

    const newPrefix = args[0] === 'reset' ? (process.env.PREFIX ?? 'b!') : args[0];

    if (newPrefix.length > 10) {
      return message.reply({ embeds: [Embed.warning('Prefix must be 10 characters or fewer.').toJSON()] });
    }

    setPrefix(guildId, newPrefix);
    await message.reply({ embeds: [Embed.success(`Prefix updated to \`${newPrefix}\``).toJSON()] });
  },
};
