import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';

export default {
  name: 'serverinfo',
  aliases: ['si', 'server'],
  description: 'Show information about this server.',
  usage: '{prefix}serverinfo',
  requiredPermission: null,

  cooldown: 5,

  async execute({ message, client }) {
    const guildId = message.guildId;
    const guild   = message.guild
      ?? client.guilds?.cache?.get(guildId)
      ?? await client.rest.get(`/guilds/${guildId}?with_counts=true`).catch(() => null);

    if (!guild) {
      return message.reply({ content: 'Could not fetch server info.' });
    }

    // guild here can be one of three genuinely different shapes depending on
    // which fallback resolved: a real Guild class instance (message.guild,
    // client.guilds.cache, camelCase props, Collections with .size) or a
    // plain raw REST JSON object (snake_case props, plain arrays with
    // .length, not .size). Mixing guild.owner_id (only ever present on the
    // raw shape) with guild.roles?.size (only ever present on the class
    // shape) meant one or the other path always rendered "Unknown"/"?", and
    // an unavailable/partial guild stub (gateway sync mid-flight) can lack
    // even `name`, which crashed setTitle() outright since it treats
    // undefined differently from its documented null-to-clear case.
    const ownerId = guild.ownerId ?? guild.owner_id ?? null;
    const roleCount    = guild.roles?.size    ?? guild.roles?.length    ?? '?';
    const channelCount = guild.channels?.size ?? guild.channels?.length ?? '?';

    // guild.memberCount/approximate_member_count only exist on the raw-JSON
    // shape from the with_counts fallback below, never on a real Guild
    // class instance, so this field showed "?" whenever message.guild or
    // the cache resolved first, which is most of the time in practice.
    // Fetching it directly here works regardless of which shape guild is.
    const memberCount = guild.memberCount ?? guild.approximate_member_count
      ?? await client.rest.get(`/guilds/${guildId}?with_counts=true`)
        .then(d => d?.approximate_member_count ?? '?').catch(() => '?');

    const created = guild.id
      ? `<t:${Math.floor((Number(BigInt(guild.id) >> 22n) + 1420070400000) / 1000)}:F>`
      : 'Unknown';

    const embed = new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle(guild.name ?? 'Unknown Server')
      .addFields(
        { name: 'Members',  value: String(memberCount), inline: true },
        { name: 'Owner',    value: ownerId ? `<@${ownerId}>` : 'Unknown', inline: true },
        { name: 'Created',  value: created, inline: false },
        { name: 'Roles',    value: String(roleCount),    inline: true },
        { name: 'Channels', value: String(channelCount), inline: true },
      )
      .setTimestamp();

    if (guild.icon) {
      const raw = embed.toJSON();
      raw.thumbnail = { url: `https://fluxerusercontent.com/icons/${guild.id}/${guild.icon}.png` };
      return message.reply({ embeds: [raw] });
    }

    await message.reply({ embeds: [embed.toJSON()] });
  },
};
