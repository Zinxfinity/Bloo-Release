// ============================================================
//  commands/moderation/reseedcount.js
//
//  !reseedcount         , reseed this guild's member count from REST
//  !reseedcount <guild> , Bot Owner: reseed a specific guild
//
//  Rank: Server Owner (6+)
// ============================================================

import { Embed }      from '../../config/embeds.js';

export default {
  name: 'reseedcount',
  aliases: ['fixmembercount', 'reseedmembers'],
  description: 'Reseed the member counter from the live Fluxer API. Use this if {membercount} is showing the wrong number.',
  usage: '{prefix}reseedcount',
  category: 'moderation',
  requiredPermission: 'SERVER_OWNER',

  cooldown: 60,

  async execute({ message, args, client }) {
    const guildId = message.guildId;
    const status = await message.reply({ embeds: [Embed.info('Reseeding…').setDescription('Fetching exact member count from Fluxer. This may take a moment for large servers.').toJSON()] });

    try {
      // client.rest (429-aware), and any failed page aborts the whole reseed:
      // stopping at the first non-OK page used to save a partial count as if
      // it were the real total.
      let total = 0, after = '0';
      while (true) {
        const members = await client.rest.get(`/guilds/${guildId}/members?limit=1000&after=${after}`);
        if (!Array.isArray(members)) throw new Error('Unexpected response from the member list, count left unchanged');
        if (!members.length) break;
        total += members.length;
        if (members.length < 1000) break;
        after = members[members.length - 1].user?.id ?? members[members.length - 1].id;
      }

      if (total === 0) throw new Error('No members returned from API');

      // Write to the real cache table (member_count_cache), guild_member_counts
      // doesn't exist anywhere in this codebase, every invocation of this
      // command threw "no such table: guild_member_counts" before this fix.
      const { updateMemberCount } = await import('../../handlers/memberCountSync.js');
      updateMemberCount(guildId, total);

      await status.edit({ embeds: [Embed.success('Member Count Reseeded')
        .setDescription(`Counter has been reset to **${total.toLocaleString()}** members.`)
        .setFooter({ text: 'Future {membercount} values will increment from this number.' })
        .toJSON()] });

    } catch (err) {
      await status.edit({ embeds: [Embed.danger('Reseed Failed').setDescription(err.message).toJSON()] });
    }
  },
};