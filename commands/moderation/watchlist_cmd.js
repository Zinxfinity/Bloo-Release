import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import {
  addToWatchlist, removeFromWatchlist, listWatchlist,
  getWatchEntry, setWatchChannel, getWatchChannel,
} from '../../handlers/watchlist.js';
import { parseUserMention } from '@fluxerjs/core';
import { Permissions } from '../../config/guildPermissions.js';
import { unixSeconds } from '../../utils/format.js';

function parseUserId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

function parseChannelId(arg) {
  if (!arg) return null;
  return arg.match(/^<#(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

export default {
  name: 'watchlist',
  aliases: ['watch', 'flag'],
  description: 'Flag users for heightened monitoring. Alerts on mod actions against watched users and when they join.',
  usage: '{prefix}watchlist <add|remove|list|info|channel> [@user] [reason]',
  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const guildId    = message.guildId;
    const executorId = message.author.id;
    if (!guildId) return;

    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'list') {
      const list = listWatchlist(guildId);
      if (!list.length) {
        return message.reply({ embeds: [Embed.info('Watchlist is empty.').toJSON()] });
      }
      const lines = list.slice(0, 25).map(e =>
        `<@${e.user_id}>: ${e.reason ?? 'No reason'} (added by <@${e.added_by}> <t:${unixSeconds(e.added_at)}:R>)`
      );
      return message.reply({ embeds: [Embed.warning(lines.join('\n'), 'Watchlist').toJSON()] });
    }

    if (sub === 'add') {
      const targetId = parseUserId(args[1]);
      if (!targetId) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}watchlist add @user [reason]\``).toJSON()] });
      }
      const reason = args.slice(2).join(' ') || null;
      addToWatchlist(guildId, targetId, reason, executorId);
      return message.reply({ embeds: [Embed.success(`Added <@${targetId}> to the watchlist.`).toJSON()] });
    }

    if (sub === 'remove') {
      const targetId = parseUserId(args[1]);
      if (!targetId) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}watchlist remove @user\``).toJSON()] });
      }
      removeFromWatchlist(guildId, targetId);
      return message.reply({ embeds: [Embed.success(`Removed <@${targetId}> from the watchlist.`).toJSON()] });
    }

    if (sub === 'info') {
      const targetId = parseUserId(args[1]);
      if (!targetId) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}watchlist info @user\``).toJSON()] });
      }
      const entry = getWatchEntry(guildId, targetId);
      if (!entry) {
        return message.reply({ embeds: [Embed.info(`<@${targetId}> is not on the watchlist.`).toJSON()] });
      }
      const embed = new EmbedBuilder()
        .setColor(COLORS.WARNING)
        .setTitle('Watchlist Entry')
        .addFields(
          { name: 'User',     value: `<@${entry.user_id}>`,     inline: true },
          { name: 'Added By', value: `<@${entry.added_by}>`,    inline: true },
          { name: 'Added',    value: `<t:${unixSeconds(entry.added_at)}:F>`, inline: true },
          { name: 'Reason',   value: entry.reason ?? 'No reason', inline: false },
        );
      return message.reply({ embeds: [embed.toJSON()] });
    }

    if (sub === 'channel') {
      const { getMemberPermissionBitsLive } = await import('../../handlers/staffSystem.js');
      const bits = await getMemberPermissionBitsLive(client, guildId, executorId);
      if ((bits & Permissions.MANAGE_GUILD) === 0n) {
        return message.reply({ embeds: [Embed.denied('Manage Guild permission required.').toJSON()] });
      }
      const chId = parseChannelId(args[1]);
      if (!chId) {
        const current = getWatchChannel(guildId);
        return message.reply({
          embeds: [Embed.info(
            current
              ? `Current watchlist alert channel: <#${current}>\nUse \`${prefix}watchlist channel #channel\` to change it.`
              : `No dedicated watchlist channel set, alerts go to the modlog channel.\nUse \`${prefix}watchlist channel #channel\` to set one.`
          ).toJSON()],
        });
      }
      setWatchChannel(guildId, chId);
      return message.reply({ embeds: [Embed.success(`Watchlist alerts will now be sent to <#${chId}>.`).toJSON()] });
    }

    await message.reply({ embeds: [Embed.warning('Subcommands: `add`, `remove`, `list`, `info`, `channel`').toJSON()] });
  },
};
