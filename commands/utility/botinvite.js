// ============================================================
//  commands/utility/botinvite.js
//  Category : Utility  |  Access 0  |  Rank 0 (public)
//
//  Posts the bot's OAuth2 invite link.
//  INVITE_PERMISSIONS in .env controls which permissions are
//  pre-checked in the invite (default: 8 = Administrator).
//
//  .env:
//    INVITE_PERMISSIONS=8          (default, Administrator)
//    INVITE_GUILD_ID=...           (optional, lock to one server)
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';

export default {
  name: 'botinvite',
  aliases: ['invite', 'addbot'],
  description: 'Get the invite link to add Bloo to a server.',
  usage: '{prefix}botinvite',
  category: 'utility',

  requiredPermission: null,

  cooldown: 10,

  async execute({ message, client }) {
    const clientId     = client.user?.id;
    const permissions  = process.env.INVITE_PERMISSIONS ?? '8';
    const guildIdParam = process.env.INVITE_GUILD_ID
      ? `&guild_id=${process.env.INVITE_GUILD_ID}&disable_guild_select=true`
      : '';

    const inviteUrl = `https://web.fluxer.app/oauth2/authorize?client_id=1472435781846110256&scope=bot&permissions=8`;

    const embed = new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle(`➕  Add ${client.user?.username ?? 'this bot'} to your server`)
      .setDescription(`[Click here to invite](${inviteUrl})`)
      .setThumbnail(client.user?.displayAvatarURL?.() ?? null)
      .setFooter({ text: `Requested by ${message.author.username}` })
      .setTimestamp();

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
