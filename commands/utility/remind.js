import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import { addReminder, listReminders, deleteReminder } from '../../handlers/reminderPoller.js';

// reminders.guild_id is NOT NULL, but a DM has no real guild, this sentinel
// keeps DM-set reminders in their own consistent bucket for list/cancel,
// separate from any specific guild's reminders. Never collides with a real
// guild snowflake (17-20 digits).
const DM_REMINDER_GUILD = 'dm';

function parseDuration(str) {
  const match = str?.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const units = { s: 1, m: 60, h: 3600, d: 86400 };
  return parseInt(match[1], 10) * units[match[2].toLowerCase()];
}

export default {
  name: 'remind',
  aliases: ['reminder', 'remindme'],
  description: 'Set a personal reminder.',
  usage: '{prefix}remind <duration> <message>  |  {prefix}remind list  |  {prefix}remind cancel <id>',
  requiredPermission: null,

  cooldown: 5,

  async execute({ message, args, prefix }) {
    const guildId = message.guildId ?? DM_REMINDER_GUILD;
    const userId  = message.author.id;
    const sub     = args[0]?.toLowerCase();

    if (sub === 'list') {
      const reminders = listReminders(guildId, userId);
      if (!reminders.length) {
        return message.reply({ embeds: [Embed.info('You have no pending reminders.').toJSON()] });
      }
      const lines = reminders.map(r => `**#${r.id}**: <t:${r.due_at}:R> ${r.message.slice(0, 60)}`);
      return message.reply({ embeds: [Embed.info(lines.join('\n'), 'Your Reminders').toJSON()] });
    }

    if (sub === 'cancel' || sub === 'delete') {
      const id = parseInt(args[1], 10);
      if (!id) return message.reply({ embeds: [Embed.warning('Provide a reminder ID.').toJSON()] });
      deleteReminder(id, userId);
      return message.reply({ embeds: [Embed.success(`Cancelled reminder #${id}.`).toJSON()] });
    }

    // Create reminder
    if (args.length < 2) {
      return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}remind <duration> <message>\``).toJSON()] });
    }

    const durationS = parseDuration(args[0]);
    if (!durationS) {
      return message.reply({ embeds: [Embed.danger('Invalid duration. Examples: `10m`, `2h`, `1d`').toJSON()] });
    }

    const reminderMsg = args.slice(1).join(' ');
    const dueAt       = Math.floor(Date.now() / 1000) + durationS;
    const id          = addReminder(guildId, userId, message.channelId, reminderMsg, dueAt);

    await message.reply({
      embeds: [Embed.success(`I'll remind you <t:${dueAt}:R>. (ID: #${id})`).toJSON()],
    });
  },
};