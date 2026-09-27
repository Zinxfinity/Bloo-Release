import { Embed } from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';
import { isChannelInGuild } from '../../utils/channelGuard.js';

const MAX_SLOWMODE = 21600;

function parseDuration(input) {
  if (!input) return null;
  const lower = input.toLowerCase().trim();
  if (lower === 'off' || lower === '0') return 0;
  const match = lower.match(/^(\d+)(s|sec|m|min|h|hr)?$/);
  if (!match) return null;
  const n    = parseInt(match[1], 10);
  const unit = match[2] ?? 's';
  if (unit.startsWith('h')) return n * 3600;
  if (unit.startsWith('m')) return n * 60;
  return n;
}

function formatDuration(seconds) {
  if (seconds === 0)  return 'Off';
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60 > 0 ? `${seconds % 60}s` : ''}`.trim();
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m > 0 ? ` ${m}m` : ''}`;
}

export default {
  name: 'slowmode',
  aliases: ['slow', 'ratelimit'],
  description: 'Set channel slowmode. Use `off` or `0` to disable. No args shows current rate.',
  usage: '{prefix}slowmode [off | <time>] [#channel]\nTime units: 5s, 10m, 1h, or raw seconds',
  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    if (!message.guildId) return;

    // Resolve optional channel mention, last arg
    let targetChannelId = message.channelId;
    let durationArg     = args[0];

    const lastArg      = args[args.length - 1];
    const channelMatch = lastArg?.match(/^<#(\d+)>$/) ?? (lastArg?.match(/^\d{17,20}$/) ? [null, lastArg] : null);
    if (channelMatch && args.length > 1) {
      targetChannelId = channelMatch[1];
      durationArg     = args[0];
    } else if (channelMatch && args.length === 1) {
      targetChannelId = channelMatch[1];
      durationArg     = null;
    }
    if (targetChannelId !== message.channelId && !await isChannelInGuild(client, message.guildId, targetChannelId)) {
      return message.reply({ embeds: [Embed.danger('That channel is not in this server.').toJSON()] });
    }

    // No duration, show current slowmode
    if (!durationArg) {
      let current = 0;
      try {
        const ch = await client.rest.get(`/channels/${targetChannelId}`);
        current = ch?.rate_limit_per_user ?? 0;
      } catch { /* ignore */ }
      return message.reply({
        embeds: [Embed.info(`Slowmode for <#${targetChannelId}>: **${formatDuration(current)}**`).toJSON()],
      });
    }

    const seconds = parseDuration(durationArg);
    if (seconds === null) {
      return message.reply({
        embeds: [Embed.warning(
          `Invalid duration. Use a number with a unit: \`5s\`, \`30s\`, \`1m\`, \`10m\`, \`1h\`\nOr \`off\` to remove slowmode.`
        ).toJSON()],
      });
    }

    if (seconds > MAX_SLOWMODE) {
      return message.reply({
        embeds: [Embed.warning(`Maximum slowmode is **6 hours** (21600s).`).toJSON()],
      });
    }

    try {
      await client.rest.patch(`/channels/${targetChannelId}`, {
        body: { rate_limit_per_user: seconds },
      });
    } catch (err) {
      return message.reply({ embeds: [Embed.danger(`Failed: ${err.message}`).toJSON()] });
    }

    const action = seconds === 0 ? 'removed' : `set to **${formatDuration(seconds)}**`;
    await message.reply({
      embeds: [Embed.success(`Slowmode ${action} in <#${targetChannelId}>.`).toJSON()],
    });
  },
};
