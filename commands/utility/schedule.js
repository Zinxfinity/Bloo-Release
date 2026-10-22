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
  description: 'Schedule an action: message, lock, unlock, announcement.',
  usage: '{prefix}schedule <add|list|cancel> [args]',
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

    await message.reply({ embeds: [Embed.warning('Subcommands: `add`, `list`, `cancel`').toJSON()] });
  },
};
