// ─── !ticket blacklist add/remove/list ──────────────────────────────────────────

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed } from '../../../config/embeds.js';
import { getMemberPermissionBitsLive } from '../../../handlers/staffSystem.js';
import { Permissions } from '../../../config/guildPermissions.js';
import {
  addToTicketBlacklist as addToBlacklist,
  removeFromTicketBlacklist as removeFromBlacklist,
  getTicketBlacklist as getBlacklist,
} from '../../../handlers/ticketSystem/index.js';

export async function handleBlacklist({ message, client, prefix, guildId, rest }) {
  const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';
  const [action, userArg, ...reasonParts] = rest;

  // ticket/index.js routes 'blacklist' as a public subcommand (its own
  // gate is bypassed) on the assumption this file checks auth internally,
  // same as close.js's isMod check below. It previously didn't, so any
  // member could blacklist or unblacklist anyone from tickets.
  const authorBits = await getMemberPermissionBitsLive(client, guildId, message.author.id);
  const isMod = (authorBits & Permissions.KICK_MEMBERS) !== 0n;
  if (!isMod) {
    await message.reply({
      embeds: [Embed.denied('Mod+').setDescription('Only staff can manage the ticket blacklist.').toJSON()],
    }).catch(() => {});
    return;
  }

  if (action === 'add') {
    const userId = userArg?.replace(/\D/g, '');
    if (!userId) {
      await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket blacklist add <@user> [reason]\``).toJSON()] }).catch(() => {});
      return;
    }

    if (userId === message.author.id) {
      await message.reply({ embeds: [Embed.warning('You cannot blacklist yourself.').toJSON()] }).catch(() => {});
      return;
    }

    const targetBits = await getMemberPermissionBitsLive(client, guildId, userId);
    if ((targetBits & Permissions.KICK_MEMBERS) !== 0n) {
      await message.reply({ embeds: [Embed.warning('You cannot blacklist a staff member.').toJSON()] }).catch(() => {});
      return;
    }

    const reason = reasonParts.join(' ').trim() || null;
    addToBlacklist(guildId, userId, message.author.id, reason);

    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle('🚫  User Blacklisted')
          .setDescription(`<@${userId}> has been blacklisted from opening support tickets.`)
          .addFields(
            { name: '👤 User',      value: `<@${userId}> (\`${userId}\`)`, inline: true  },
            { name: '👮 By',        value: message.author.username,         inline: true  },
            { name: '📋 Reason',    value: reason ?? 'No reason provided',  inline: false },
          )
          .setTimestamp()
          .toJSON(),
      ],
    });
    return;
  }

  if (action === 'remove') {
    const userId = userArg?.replace(/\D/g, '');
    if (!userId) {
      await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket blacklist remove <@user>\``).toJSON()] }).catch(() => {});
      return;
    }

    const removed = removeFromBlacklist(guildId, userId);
    if (!removed) {
      await message.reply({ embeds: [Embed.info(`<@${userId}> is not on the ticket blacklist.`).toJSON()] }).catch(() => {});
      return;
    }

    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('✅  Blacklist Removed')
          .setDescription(`<@${userId}> can now open support tickets again.`)
          .setTimestamp()
          .toJSON(),
      ],
    });
    return;
  }

  if (action === 'list') {
    const entries = getBlacklist(guildId);
    if (!entries.length) {
      await message.reply({ embeds: [Embed.info('No users are currently blacklisted from tickets.').toJSON()] }).catch(() => {});
      return;
    }

    const lines = entries.map((e, i) => {
      const reason = e.reason ? `: ${e.reason}` : '';
      return `${i + 1}. <@${e.user_id}>${reason}\n-# Added by <@${e.added_by}> <t:${e.added_at}:R>`;
    });

    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle(`🚫  Ticket Blacklist: ${entries.length} user(s)`)
          .setDescription(lines.join('\n\n').slice(0, 3900))
          .setTimestamp()
          .toJSON(),
      ],
    });
    return;
  }

  await message.reply({ embeds: [Embed.info('Ticket Blacklist')
    .setDescription(
      `\`${PREFIX}ticket blacklist add <@user> [reason]\`: block a user\n` +
      `\`${PREFIX}ticket blacklist remove <@user>\`: unblock a user\n` +
      `\`${PREFIX}ticket blacklist list\`: show all blocked users`
    ).toJSON()] });
}
