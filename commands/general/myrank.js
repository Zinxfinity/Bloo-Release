// ============================================================
//  commands/general/myrank.js
//  Category : General  |  Everyone can run it on themselves
//
//  Shows your own live Fluxer permission summary in this server (there is
//  no manually-assigned rank anymore, everything here is recomputed from
//  Fluxer's own permission bits and ownership facts on every call).
//  Kick Members+ can look up other members' summaries.
//
//  Merged with the old commands/utility/accesslevel.js (same lookup, a
//  different name/aliases). That file is gone now, its aliases live here.
// ============================================================

import { EmbedBuilder }                          from '@fluxerjs/core';
import { COLORS, Embed }                          from '../../config/embeds.js';
import { isBotOwner, isRealOwner, getMemberPermissionBitsLive } from '../../handlers/staffSystem.js';
import { Permissions }                            from '../../config/guildPermissions.js';
import { resolveAccess }                          from '../../handlers/commandPermissions.js';

function parseUserId(arg) {
  if (!arg) return null;
  const m = arg.match(/^<@!?(\d+)>$/) ?? arg.match(/^\d{17,20}$/);
  return m?.[1] ?? m?.[0] ?? null;
}

const PERMISSION_CHECKS = [
  { label: 'Kick Members',  flag: Permissions.KICK_MEMBERS },
  { label: 'Ban Members',   flag: Permissions.BAN_MEMBERS },
  { label: 'Manage Guild',  flag: Permissions.MANAGE_GUILD },
  { label: 'Administrator', flag: Permissions.ADMINISTRATOR },
];

export default {
  name: 'myrank',
  aliases: ['staffrank', 'accesslevel', 'al', 'mylevel', 'myaccess'],
  description: 'Check your live Fluxer permission summary in this server. Kick Members+ can look up others.',
  usage: '{prefix}myrank [@user | userId]',
  category: 'general',

  requiredPermission: null,
  internalAccess: true, // subcommands gate themselves via resolveAccess

  cooldown: 5,

  async execute({ message, args, client }) {
    const guildId = message.guildId;
    if (!guildId) {
      await message.reply({
        embeds: [Embed.danger('This command can only be used inside a server.').toJSON()],
      });
      return;
    }

    const requestedId = parseUserId(args[0]);
    const targetId    = requestedId ?? message.author.id;
    const isSelf      = targetId === message.author.id;

    // Only Kick Members+ can look up others
    if (!isSelf && !await resolveAccess(client, guildId, message.author.id, 'myrank', Permissions.KICK_MEMBERS)) {
      await message.reply({
        embeds: [Embed.denied('Kick Members permission or higher required to look up another member\'s rank.').toJSON()],
      });
      return;
    }

    let displayName = targetId;
    try {
      const member = await client.rest.get(`/guilds/${guildId}/members/${targetId}`).catch(() => null);
      displayName = member?.nick ?? member?.user?.username ?? targetId;
    } catch { /* use ID fallback */ }

    const botOwner   = isBotOwner(targetId);
    const realOwner  = !botOwner && await isRealOwner(guildId, targetId);
    const bits       = await getMemberPermissionBitsLive(client, guildId, targetId);

    const permLines = PERMISSION_CHECKS.map(({ label, flag }) => {
      const held = (bits & flag) !== 0n;
      return `${held ? '✅' : '❌'} ${label}`;
    });

    let statusLine;
    let color;
    if (botOwner) {
      statusLine = 'Bot Owner, unrestricted root access across all servers.';
      color = COLORS.PURPLE;
    } else if (realOwner) {
      statusLine = 'Server Owner, full access in this server.';
      color = COLORS.WARNING;
    } else if ((bits & Permissions.ADMINISTRATOR) !== 0n) {
      statusLine = 'Administrator in this server.';
      color = COLORS.INFO;
    } else {
      statusLine = 'Regular member permissions.';
      color = COLORS.MUTED;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🎖️  ${displayName}'s Permissions`)
      .setColor(color)
      .addFields(
        { name: 'Status',      value: statusLine,          inline: false },
        { name: 'Permissions', value: permLines.join('\n'), inline: false },
      )
      .setFooter({ text: new Date().toUTCString().replace(' GMT', ' UTC') });

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
