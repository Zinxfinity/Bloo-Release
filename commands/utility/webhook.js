import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import { addFeed, removeFeed, listFeeds, setFeedEnabled } from '../../handlers/webhookPoller.js';
import { Permissions } from '../../config/guildPermissions.js';
import { isChannelInGuild } from '../../utils/channelGuard.js';

export default {
  name: 'webhook',
  aliases: ['feed', 'rss'],
  description: 'Manage RSS/Atom/JSON feed subscriptions, including X/Twitter via twitter:<handle>.',
  usage: '{prefix}webhook <add|remove|list|enable|disable> [args]',
  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 5,

  async execute({ message, args, prefix, client }) {
    const guildId = message.guildId;
    const sub     = args[0]?.toLowerCase();

    if (!sub || sub === 'list') {
      const feeds = listFeeds(guildId);
      if (!feeds.length) return message.reply({ embeds: [Embed.info('No feeds configured.').toJSON()] });

      const lines = feeds.map(f =>
        `**#${f.id}** \`${f.name}\`: ${f.enabled ? '✅' : '❌'} | every ${f.interval_m}m | <#${f.channel_id}>`
      );
      return message.reply({ embeds: [Embed.info(lines.join('\n'), 'Feed Subscriptions').toJSON()] });
    }

    if (sub === 'add') {
      // !webhook add <name> <url> #channel [interval_m]
      // url also accepts twitter:<handle> or x:<handle> for X/Twitter via
      // TwitterAPI.io (requires TWITTERAPI_KEY in .env), since X has no
      // native RSS and free scraping bridges (Nitter, RSSHub) are unreliable.
      const name      = args[1];
      const url       = args[2];
      const channelId = args[3]?.replace(/\D/g, '');
      const interval  = args[4] === undefined ? 30 : parseInt(args[4], 10);

      if (!name || !url || !channelId) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}webhook add <name> <url|twitter:handle> #channel [interval_minutes]\``).toJSON()] });
      }
      // Same bounds and cap the dashboard enforces (dashboard/routes/webhooks.js).
      if (!Number.isFinite(interval) || interval < 5 || interval > 43200) {
        return message.reply({ embeds: [Embed.warning('Interval must be between 5 and 43200 minutes.').toJSON()] });
      }
      if (listFeeds(guildId).length >= 20) {
        return message.reply({ embeds: [Embed.warning('This server already has the maximum of 20 feeds. Remove one first.').toJSON()] });
      }
      if (!await isChannelInGuild(client, guildId, channelId)) {
        return message.reply({ embeds: [Embed.danger('That channel is not in this server.').toJSON()] });
      }

      const id = addFeed(guildId, name, url, channelId, interval, null, message.author.id);
      return message.reply({ embeds: [Embed.success(`Feed **${name}** added (ID: #${id}). Checking every ${interval}m.`).toJSON()] });
    }

    if (sub === 'remove') {
      const id = parseInt(args[1], 10);
      if (!id) return message.reply({ embeds: [Embed.warning('Provide a feed ID.').toJSON()] });
      removeFeed(guildId, id);
      return message.reply({ embeds: [Embed.success(`Feed #${id} removed.`).toJSON()] });
    }

    if (sub === 'enable' || sub === 'disable') {
      const id      = parseInt(args[1], 10);
      const enabled = sub === 'enable';
      if (!id) return message.reply({ embeds: [Embed.warning('Provide a feed ID.').toJSON()] });
      setFeedEnabled(guildId, id, enabled);
      return message.reply({ embeds: [Embed.success(`Feed #${id} ${enabled ? 'enabled' : 'disabled'}.`).toJSON()] });
    }

    await message.reply({ embeds: [Embed.warning(`Subcommands: \`add\`, \`remove\`, \`list\`, \`enable\`, \`disable\``).toJSON()] });
  },
};
