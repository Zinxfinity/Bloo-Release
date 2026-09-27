import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';
import { isStaff } from '../../handlers/staffSystem.js';
import { parseUserMention } from '@fluxerjs/core';

export default {
  name: 'userinfo',
  aliases: ['ui', 'whois'],
  description: 'Show information about a user.',
  usage: '{prefix}userinfo [@user|id]',
  requiredPermission: null,

  cooldown: 5,

  async execute({ message, args, client }) {
    const guildId = message.guildId;
    const targetId = args[0]
      ? (parseUserMention(args[0]) ?? args[0].replace(/\D/g, ''))
      : message.author.id;

    const member = await client.rest.get(`/guilds/${guildId}/members/${targetId}`).catch(() => null);
    const user   = member?.user ?? await client.rest.get(`/users/${targetId}`).catch(() => null);

    if (!user) return message.reply({ content: 'Could not resolve that user.' });

    const staffLabel = (await isStaff(client, guildId, targetId)) ? 'Staff' : 'None';

    const accountCreated = user.id
      ? `<t:${Math.floor((Number(BigInt(user.id) >> 22n) + 1420070400000) / 1000)}:F>`
      : 'Unknown';

    const joinedAt = member?.joined_at
      ? `<t:${Math.floor(new Date(member.joined_at).getTime() / 1000)}:F>`
      : 'Unknown';

    const roles = (member?.roles ?? []).slice(0, 10).map(id => `<@&${id}>`).join(', ') || 'None';

    const embed = new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle(user.username)
      .addFields(
        { name: 'ID',             value: user.id,         inline: true },
        { name: 'Staff',          value: staffLabel,       inline: true },
        { name: 'Account Created',value: accountCreated,   inline: false },
        { name: 'Joined Server',  value: joinedAt,         inline: false },
        { name: 'Roles',          value: roles,            inline: false },
      )
      .setTimestamp();

    const raw = embed.toJSON();
    if (user.avatar) {
      raw.thumbnail = { url: `https://fluxerusercontent.com/avatars/${user.id}/${user.avatar}.png?size=128` };
    }

    await message.reply({ embeds: [raw] });
  },
};
