// ============================================================
//  commands/moderation/lookup.js
//  Category : Moderation  |  Requires Kick Members (default)
//
//  Cross-reference a user across all bot systems in one embed.
//  !lookup <@user|id>
// ============================================================

import { EmbedBuilder }                      from '@fluxerjs/core';
import { COLORS, Embed }                     from '../../config/embeds.js';
import { isStaff }                           from '../../handlers/staffSystem.js';
import { normalizeAction, getCasesForUser }                   from '../../handlers/modLog.js';
import { getActiveWarnings, getAllWarnings }  from '../../handlers/warnSystem.js';
import { getOpenTicketByUser, getTicketsByUser } from '../../handlers/ticketSystem/index.js';
import { Permissions } from '../../config/guildPermissions.js';

function parseUserId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

function msToAge(ms) {
  const days = Math.floor(ms / 86_400_000);
  if (days < 1)    return 'today';
  if (days < 30)   return `${days}d ago`;
  if (days < 365)  return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function accountAgeDays(userId) {
  const created = Number(BigInt(userId) >> 22n) + 1420070400000;
  return Math.floor((Date.now() - created) / 86_400_000);
}

// Keyed by the canonical action names handlers/modLog.js normalises to.
const ACTION_EMOJI = {
  ban: '🔨', massban: '🔨', softban: '🔨', hardban: '🔨', tempban: '⏳', unban: '✅',
  kick: '👢', warn: '⚠️', 'warn-remove': '🗑️', timeout: '⏱️', 'timeout-remove': '✅',
  mute: '🔇', unmute: '🔊', note: '📝',
};
function caseIcon(action) { return ACTION_EMOJI[normalizeAction(action)] ?? '📋'; }

export default {
  name: 'lookup',
  aliases: ['lu'],
  description: 'Full profile lookup for a user: ban history, warnings, tickets, and rank.',
  usage: '{prefix}lookup @user',
  category: 'moderation',

  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 5,

  async execute({ message, args, client, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    if (!guildId) return;

    const targetId = parseUserId(args[0]);
    if (!targetId) {
      await message.reply({ embeds: [Embed.warning('Missing User').setDescription(`Usage: \`${PREFIX}lookup <@user|id>\``).toJSON()] }).catch(() => {});
      return;
    }

    const sent = await message.reply({ embeds: [Embed.info('🔍  Looking up…').setDescription('Gathering data…').toJSON()] }).catch(() => {});

    const [user, member, banInfo] = await Promise.all([
      client.rest.get(`/users/${targetId}`).catch(() => null),
      client.rest.get(`/guilds/${guildId}/members/${targetId}`).catch(() => null),
      client.rest.get(`/guilds/${guildId}/bans/${targetId}`).catch(() => null),
    ]);

    if (!user && !member) {
      await sent?.edit({ embeds: [Embed.warning('User Not Found').setDescription(`Could not resolve \`${targetId}\`.`).toJSON()] });
      return;
    }

    const displayName = member?.nick ?? user?.username ?? targetId;
    const username    = user?.username ?? targetId;
    const avatarHash  = user?.avatar;
    const avatarURL   = avatarHash
      ? `https://fluxerusercontent.com/avatars/${targetId}/${avatarHash}.png?size=256`
      : null;

    const rankLabel = (await isStaff(client, guildId, targetId)) ? 'Staff' : 'None';

    const createdTs = Number(BigInt(targetId) >> 22n) + 1420070400000;
    const ageDays   = accountAgeDays(targetId);

    const cases     = getCasesForUser(guildId, targetId, 10);
    // created_at is unix seconds (SQLite unixepoch()), not milliseconds
    const caseLines = cases.slice(0, 5).map(c =>
      `${caseIcon(c.action)} \`#${c.case_number}\` ${c.action}, <t:${c.created_at}:d>`
    );

    const activeWarns = getActiveWarnings(guildId, targetId);
    const allWarns    = getAllWarnings(guildId, targetId);

    let openTicket    = null;
    let ticketHistory = [];
    try {
      openTicket    = getOpenTicketByUser(guildId, targetId);
      ticketHistory = getTicketsByUser(guildId, targetId, { limit: 3 });
    } catch { /* ticketSystem unavailable */ }

    let timeoutUntil = null;
    if (member?.communication_disabled_until) {
      const d = new Date(member.communication_disabled_until);
      if (d > new Date()) timeoutUntil = Math.floor(d.getTime() / 1000);
    }

    const roles = member?.roles
      ? (member.roles.filter(id => id !== guildId)).slice(0, 8).map(id => `<@&${id}>`).join(' ') || 'None'
      : 'Not in server';

    const isBanned   = !!banInfo;
    const isTimedOut = !!timeoutUntil;

    const statusParts = [];
    if (isBanned)    statusParts.push('🔨 **Banned**');
    if (isTimedOut)  statusParts.push(`⏱️ **Timed out** until <t:${timeoutUntil}:R>`);
    if (!member && !isBanned) statusParts.push('👻 Not in server');
    if (member && !isBanned && !isTimedOut) statusParts.push('✅ Active member');

    const embedColor = isBanned ? COLORS.DANGER : isTimedOut ? COLORS.WARNING : COLORS.INFO;

    const embed = new EmbedBuilder()
      .setTitle(`🔍  Lookup: ${displayName}`)
      .setColor(embedColor)
      .setThumbnail(avatarURL)
      .addFields(
        { name: '👤  User',           value: `<@${targetId}> \`${username}\` \`${targetId}\``, inline: false },
        { name: '📅  Account Created', value: `<t:${Math.floor(createdTs / 1000)}:D> (${msToAge(Date.now() - createdTs)})${ageDays < 7 ? ' ⚠️ *new account*' : ''}`, inline: true },
        { name: '📥  Joined Server',   value: member?.joined_at ? `<t:${Math.floor(new Date(member.joined_at).getTime() / 1000)}:D>` : 'N/A', inline: true },
        { name: '🏷️  Staff Rank',      value: rankLabel, inline: true },
        { name: '🚦  Status',           value: statusParts.join('\n') || '—', inline: false },
        { name: `📋  Mod Cases (${cases.length}${cases.length === 10 ? '+' : ''})`, value: caseLines.length ? caseLines.join('\n') : 'No cases on record.', inline: false },
        { name: '⚠️  Warnings',         value: `**${activeWarns.length}** active / **${allWarns.length}** total`, inline: true },
        { name: '🎫  Tickets',          value: openTicket ? `Open: <#${openTicket.channel_id}> (\`${openTicket.case_id}\`)` : ticketHistory.length ? `${ticketHistory.length} historical ticket(s)` : 'No tickets', inline: true },
      );

    if (isBanned && banInfo?.reason) {
      embed.addFields({ name: '🔨  Ban Reason', value: banInfo.reason.slice(0, 200), inline: false });
    }
    if (member) {
      embed.addFields({ name: '🎭  Roles', value: roles, inline: false });
    }

    embed.setFooter({ text: `Requested by ${message.author.username}` }).setTimestamp();
    await sent?.edit({ embeds: [embed.toJSON()] });
  },
};
