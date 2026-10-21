import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import { addFeed, removeFeed, listFeeds, setFeedEnabled } from '../../handlers/webhookPoller.js';
import { Permissions } from '../../config/guildPermissions.js';
import { isChannelInGuild } from '../../utils/channelGuard.js';
import { missingPermissions } from '../../utils/channelPermissions.js';

const MAX_NAME = 80;
const looksLikeFeed = s => /^(https?:\/\/|twitter:|x:)/i.test(s ?? '');

// b!webhook add <name> <url> #channel [minutes]. Arguments arrive split on
// spaces, so a name with spaces has to be put back together. Quoted names
// work ("Mr Potato Head", including the curly quotes phones insert), and so
// do unquoted ones: everything before the feed address is the name.
export function parseAddArgs(words) {
  const text = words.join(' ').trim();
  const quoted = text.match(/^["“'‘](.+?)["”'’]\s+(.*)$/s);
  if (quoted) {
    const [url, ...rest] = quoted[2].trim().split(/\s+/);
    return { name: quoted[1].trim(), url, rest };
  }
  const at = words.findIndex(looksLikeFeed);
  if (at > 0) return { name: words.slice(0, at).join(' ').trim(), url: words[at], rest: words.slice(at + 1) };
  // No recognisable address: keep the old one-word-name reading.
  return { name: words[0], url: words[1], rest: words.slice(2) };
}

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
      const parsed    = parseAddArgs(args.slice(1));
      const { name, url } = parsed;
      const channelId = parsed.rest[0]?.replace(/\D/g, '');
      const interval  = parsed.rest[1] === undefined ? 30 : parseInt(parsed.rest[1], 10);

      if (!name || !url || !channelId) {
        return message.reply({ embeds: [Embed.warning(
          `Usage: \`${prefix}webhook add <name> <url|twitter:handle> #channel [interval_minutes]\`\n` +
          `The name can be several words, e.g. \`${prefix}webhook add "Mr Potato Head" https://example.com/feed.xml #news\`.`
        ).toJSON()] });
      }
      if (name.length > MAX_NAME) {
        return message.reply({ embeds: [Embed.warning(`Feed names can be up to ${MAX_NAME} characters.`).toJSON()] });
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
      // Bloo needs to be able to post there, after the channel's own
      // overrides, not just server-wide (announcement channels usually
      // block @everyone, and that block applies to Bloo too).
      const missing = await missingPermissions(p => client.rest.get(p), guildId, channelId, client.user?.id);
      if (missing?.length) {
        return message.reply({ embeds: [Embed.warning(
          `I can't post in <#${channelId}> yet. I'm missing: **${missing.join('**, **')}**.\n\n` +
          `Server-wide permissions aren't enough when the channel has its own settings. Open the channel's **Permissions**, add my role, allow those, then run this again.`,
          'Missing permissions'
        ).toJSON()] });
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
      if (enabled) {
        const feed = listFeeds(guildId).find(f => f.id === id);
        const missing = feed && await missingPermissions(p => client.rest.get(p), guildId, feed.channel_id, client.user?.id);
        if (missing?.length) {
          return message.reply({ embeds: [Embed.warning(
            `Feed #${id} would fail again: I'm missing **${missing.join('**, **')}** in <#${feed.channel_id}>.\n\n` +
            `Open the channel's **Permissions**, add my role, allow those, then run \`${prefix}webhook enable ${id}\` again.`,
            'Missing permissions'
          ).toJSON()] });
        }
      }
      setFeedEnabled(guildId, id, enabled);
      return message.reply({ embeds: [Embed.success(`Feed #${id} ${enabled ? 'enabled' : 'disabled'}.`).toJSON()] });
    }

    await message.reply({ embeds: [Embed.warning(`Subcommands: \`add\`, \`remove\`, \`list\`, \`enable\`, \`disable\``).toJSON()] });
  },
};
