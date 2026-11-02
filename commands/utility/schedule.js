import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import { scheduleAction, listScheduled, cancelScheduled, SCHEDULE_TYPES, SCHEDULE_MAX_CONTENT } from '../../handlers/scheduleSystem.js';
import { Permissions } from '../../config/guildPermissions.js';
import { isChannelInGuild } from '../../utils/channelGuard.js';

function parseDuration(str) {
  const match = str?.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const units = { s: 1, m: 60, h: 3600, d: 86400 };
  return parseInt(match[1], 10) * units[match[2].toLowerCase()];
}

export default {
  name: 'schedule',
  aliases: ['sched'],
  description: 'Post a message or announcement, or lock or unlock a channel, at a set time.',
  usage: '{prefix}schedule add <message|announcement|lock|unlock> #channel <in: 30m, 2h, 1d> [text]\n{prefix}schedule list\n{prefix}schedule cancel <id>',
  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 5,

  async execute({ message, args, prefix, client }) {
    const guildId    = message.guildId;
    const executorId = message.author.id;
    const sub        = args[0]?.toLowerCase();

    if (!sub || sub === 'list') {
      const actions = listScheduled(guildId);
      if (!actions.length) return message.reply({ embeds: [Embed.info('No scheduled actions.').toJSON()] });
      const lines = actions.map(a =>
        `**#${a.id}** \`${a.action}\` → <#${a.target_id}>, <t:${a.execute_at}:R>`
      );
      return message.reply({ embeds: [Embed.info(lines.join('\n'), 'Scheduled Actions').toJSON()] });
    }

    if (sub === 'cancel') {
      const id = parseInt(args[1], 10);
      if (!id) return message.reply({ embeds: [Embed.warning('Provide an action ID.').toJSON()] });
      if (!cancelScheduled(guildId, id)) return message.reply({ embeds: [Embed.warning(`No scheduled action #${id} in this server.`).toJSON()] });
      return message.reply({ embeds: [Embed.success(`Cancelled scheduled action #${id}.`).toJSON()] });
    }

    if (sub === 'add') {
      // !schedule add <type> #channel <duration> [content...]
      const type      = args[1]?.toLowerCase();
      const channelId = args[2]?.replace(/\D/g, '');
      const durationS = parseDuration(args[3]);
      const content   = args.slice(4).join(' ');

      if (!SCHEDULE_TYPES.includes(type) || !channelId || !durationS) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}schedule add <${SCHEDULE_TYPES.join('|')}> #channel <duration> [content]\``).toJSON()] });
      }
      if (content.length > SCHEDULE_MAX_CONTENT) {
        return message.reply({ embeds: [Embed.warning(`Keep the message under ${SCHEDULE_MAX_CONTENT} characters.`).toJSON()] });
      }
      if (!await isChannelInGuild(client, guildId, channelId)) {
        return message.reply({ embeds: [Embed.danger('That channel is not in this server.').toJSON()] });
      }

      const firesAt = Math.floor(Date.now() / 1000) + durationS;
      const id = scheduleAction(guildId, type, channelId, { content }, firesAt, executorId);
      return message.reply({ embeds: [Embed.success(`Scheduled **${type}** in <#${channelId}> for <t:${firesAt}:R> (ID: #${id}).`).toJSON()] });
    }

    await message.reply({ embeds: [Embed.info([
      `\`${prefix}schedule add message #general 2h Hello everyone!\` post a message in 2 hours`,
      `\`${prefix}schedule add announcement #news 1d Big news!\` the same, as an announcement`,
      `\`${prefix}schedule add lock #chat 30m\` lock a channel later (\`unlock\` to open it again)`,
      `\`${prefix}schedule list\` see what's waiting, with each one's number`,
      `\`${prefix}schedule cancel 3\` cancel number 3`,
      '',
      '-# Times: `30s`, `10m`, `2h`, `1d`. Also on the dashboard: Tools → Scheduled Actions.',
    ].join('\n'), '🗓️ Scheduled actions').toJSON()] });
  },
};
