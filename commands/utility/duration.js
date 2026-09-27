// ============================================================
//  commands/utility/duration.js
//  Category : Utility  |  Rank 0 (public) / Rank 2 server view
//
//  !duration me        , your pending reminders + temp bans
//  !duration bans      , all active temp bans (Mod+)
//  !duration @user|id  , temp ban status for a specific user (Mod+)
//  !duration           , all active timers in this server (Mod+)
//
//  Sources: temp bans live in warn_tempbans (handlers/warnSystem.js,
//  written by !tempban, warn thresholds and the dashboard), reminders in
//  reminders (handlers/reminderPoller.js). Both store unix seconds. This
//  used to read scheduled_actions, which nothing writes temp bans to
//  anymore, so every view came back empty.
// ============================================================

import { EmbedBuilder }    from '@fluxerjs/core';
import { Embed, COLORS }   from '../../config/embeds.js';
import { Permissions }     from '../../config/guildPermissions.js';
import { resolveAccess }   from '../../handlers/commandPermissions.js';
import { listReminders }   from '../../handlers/reminderPoller.js';
import '../../handlers/warnSystem.js'; // ensures warn_tempbans exists
import db from '../../db.js';

const ID_REGEX = /^<@!?(\d+)>$|^(\d{17,20})$/;
function parseUserId(arg) {
  if (!arg) return null;
  const m = arg.match(ID_REGEX);
  return m?.[1] ?? m?.[2] ?? null;
}

const nowS = () => Math.floor(Date.now() / 1000);

function formatRemaining(untilS) {
  const s = untilS - nowS();
  if (s <= 0)    return 'expiring';
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const q = {
  guildBans:     db.prepare(`SELECT * FROM warn_tempbans WHERE guild_id = ? AND unbanned = 0 ORDER BY expires_at ASC`),
  userBans:      db.prepare(`SELECT * FROM warn_tempbans WHERE guild_id = ? AND user_id = ? AND unbanned = 0 ORDER BY expires_at ASC`),
  userBansAll:   db.prepare(`SELECT * FROM warn_tempbans WHERE user_id = ? AND unbanned = 0 ORDER BY expires_at ASC`),
  guildRems:     db.prepare(`SELECT * FROM reminders WHERE guild_id = ? AND sent = 0 ORDER BY due_at ASC`),
  userRemsAll:   db.prepare(`SELECT * FROM reminders WHERE user_id = ? AND sent = 0 ORDER BY due_at ASC`),
};

const banLine = (b, withUser) =>
  `${withUser ? `<@${b.user_id}>, ` : ''}expires <t:${b.expires_at}:R> (${formatRemaining(b.expires_at)})\n-# ${(b.reason ?? 'No reason').slice(0, 80)}`;

export default {
  name: 'duration',
  aliases: ['timers', 'active'],
  description: 'View active temp bans and reminders.',
  usage: '{prefix}duration [me | bans | @user]',
  category: 'utility',

  requiredPermission: null,
  internalAccess: true, // subcommands gate themselves via resolveAccess

  cooldown: 5,

  async execute({ message, args, prefix, client }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    const userId  = message.author.id;
    const sub     = args[0]?.toLowerCase();

    // ── Personal view, anyone ────────────────────────────────────────────────
    if (sub === 'me' || !guildId) {
      const reminders = guildId ? listReminders(guildId, userId) : q.userRemsAll.all(userId);
      const bans      = guildId ? q.userBans.all(guildId, userId) : q.userBansAll.all(userId);

      if (!reminders.length && !bans.length) {
        await message.reply({ embeds: [Embed.info('Nothing Active').setDescription('You have no active reminders or temp bans.').toJSON()] }).catch(() => {});
        return;
      }

      const embed = new EmbedBuilder().setTitle('⏱️  Your Active Timers').setColor(COLORS.INFO);
      if (reminders.length) {
        embed.addFields({
          name: `⏰ Reminders (${reminders.length})`,
          value: reminders.map(r => `**#${r.id}**: fires <t:${r.due_at}:R> (${formatRemaining(r.due_at)})\n> ${(r.message ?? '').slice(0, 80)}`).join('\n\n').slice(0, 1020),
          inline: false,
        });
      }
      if (bans.length) {
        embed.addFields({
          name: `🔨 Active Temp Bans (${bans.length})`,
          value: bans.map(b => banLine(b, false)).join('\n').slice(0, 1020),
          inline: false,
        });
      }
      embed.setFooter({ text: `Cancel reminders: ${PREFIX}remind cancel <id>` });
      await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
      return;
    }

    // ── Server view, Mod+ required ───────────────────────────────────────────
    if (!await resolveAccess(client, guildId, userId, 'duration', Permissions.KICK_MEMBERS)) {
      await message.reply({ embeds: [Embed.denied('Mod or higher required.').toJSON()] }).catch(() => {});
      return;
    }

    // ── Single user lookup ────────────────────────────────────────────────────
    const targetId = parseUserId(args[0]);
    if (targetId) {
      const b = q.userBans.get(guildId, targetId);
      if (!b) {
        await message.reply({ embeds: [Embed.info('No Active Temp Ban').setDescription(`<@${targetId}> does not have an active temp ban in this server.`).toJSON()] }).catch(() => {});
        return;
      }
      await message.reply({
        embeds: [new EmbedBuilder()
          .setTitle('🔨  Active Temp Ban')
          .setColor(COLORS.DANGER)
          .addFields(
            { name: '🎯 User',      value: `<@${targetId}> \`${targetId}\``,                           inline: true },
            { name: '⏳ Remaining', value: `${formatRemaining(b.expires_at)} (<t:${b.expires_at}:R>)`, inline: true },
            { name: '📋 Reason',    value: b.reason ?? 'No reason',                                     inline: false },
            { name: '🕐 Banned',    value: b.banned_at ? `<t:${b.banned_at}:R>` : 'Unknown',             inline: true },
          ).toJSON()],
      }).catch(() => {});
      return;
    }

    const bans = q.guildBans.all(guildId);

    // ── Bans-only view ────────────────────────────────────────────────────────
    if (sub === 'bans') {
      if (!bans.length) {
        await message.reply({ embeds: [Embed.info('No Active Temp Bans').setDescription('There are no active temp bans in this server.').toJSON()] }).catch(() => {});
        return;
      }
      const lines = bans.slice(0, 20).map(b => banLine(b, true));
      if (bans.length > 20) lines.push(`*… and ${bans.length - 20} more*`);
      await message.reply({ embeds: [Embed.info(`🔨  Active Temp Bans (${bans.length})`).setDescription(lines.join('\n').slice(0, 4000)).toJSON()] }).catch(() => {});
      return;
    }

    // ── All active timers in server ───────────────────────────────────────────
    const rems = q.guildRems.all(guildId);
    if (!bans.length && !rems.length) {
      await message.reply({ embeds: [Embed.info('Nothing Active').setDescription('No active temp bans or reminders in this server.').toJSON()] }).catch(() => {});
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('⏱️  Active Timers')
      .setColor(COLORS.INFO)
      .setFooter({ text: `${bans.length + rems.length} total active timer(s)` });

    if (bans.length) {
      const lines = bans.slice(0, 15).map(b => banLine(b, true));
      if (bans.length > 15) lines.push(`*… and ${bans.length - 15} more*`);
      embed.addFields({ name: `🔨 Temp Bans (${bans.length})`, value: lines.join('\n').slice(0, 1020), inline: false });
    }
    if (rems.length) {
      const lines = rems.slice(0, 10).map(r => `<@${r.user_id}>: <t:${r.due_at}:R> ${(r.message ?? '').slice(0, 60)}`);
      embed.addFields({ name: `⏰ Reminders (${rems.length})`, value: lines.join('\n').slice(0, 1020), inline: false });
    }

    await message.reply({ embeds: [embed.toJSON()], allowedMentions: { parse: [] } }).catch(() => {});
  },
};
