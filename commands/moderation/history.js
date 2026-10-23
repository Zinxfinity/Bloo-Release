import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import {
  getCase, getCaseHistory, getCasesForUser,
  getCasesByExecutor, getCaseCount, logAction, normalizeAction,
} from '../../handlers/modLog.js';
import { getAllWarnings } from '../../handlers/warnSystem.js';
import { parseUserMention } from '@fluxerjs/core';
import db from '../../db.js';
import { Permissions } from '../../config/guildPermissions.js';
import { unixSeconds } from '../../utils/format.js';

function parseUserId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

function clamp(raw, def = 5, max = 25) {
  const n = parseInt(raw, 10);
  return isNaN(n) || n < 1 ? def : Math.min(n, max);
}

const ACTION_STYLE = {
  ban:    { emoji: '🔨', color: COLORS.DANGER  },
  kick:   { emoji: '👢', color: COLORS.MOD ?? COLORS.WARNING },
  warn:   { emoji: '⚠️', color: COLORS.WARNING },
  mute:   { emoji: '⏱️', color: COLORS.WARNING },
  unmute: { emoji: '✅', color: COLORS.SUCCESS  },
  unban:  { emoji: '✅', color: COLORS.SUCCESS  },
  note:   { emoji: '📝', color: COLORS.INFO     },
  tempban:  { emoji: '⏳', color: COLORS.DANGER  },
  massban:  { emoji: '🔨', color: COLORS.DANGER  },
  softban:  { emoji: '🔨', color: COLORS.DANGER  },
  timeout:  { emoji: '⏱️', color: COLORS.WARNING },
  'timeout-remove': { emoji: '✅', color: COLORS.SUCCESS },
};

function styleFor(action) {
  return ACTION_STYLE[normalizeAction(action)] ?? { emoji: '📋', color: COLORS.INFO };
}

function buildCaseEmbed(c) {
  const ts    = unixSeconds(c.created_at);
  const style = styleFor(c.action);
  const embed = new EmbedBuilder()
    .setTitle(`${style.emoji} Case #${c.case_number ?? c.id}, ${c.action}`)
    .setColor(style.color);
  if (c.target_id)   embed.addFields({ name: 'Target',   value: `<@${c.target_id}>`,   inline: true });
  if (c.executor_id) embed.addFields({ name: 'By',       value: `<@${c.executor_id}>`, inline: true });
  if (c.reason)      embed.addFields({ name: 'Reason',   value: c.reason,              inline: false });
  embed.addFields({ name: 'When', value: `<t:${ts}:F> (<t:${ts}:R>)`, inline: false });
  return embed;
}

function buildCaseListEmbed(cases, title) {
  const lines = cases.map(c => {
    const ts    = unixSeconds(c.created_at);
    const style = styleFor(c.action);
    const brief = c.reason ? `${c.reason.slice(0, 60)}${c.reason.length > 60 ? '…' : ''}` : 'No reason';
    return `${style.emoji} \`#${c.case_number ?? c.id}\` **${c.action}**, <t:${ts}:d>\n> ${brief}`;
  });
  return new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle(title)
    .setDescription(lines.join('\n\n') || 'No cases.')
    .setTimestamp();
}

export default {
  name: 'history',
  aliases: ['cases', 'case', 'note', 'addnote', 'modhistory'], // not "h": that's b!help
  description: 'View mod history for a user, look up cases, or add a staff note.',
  usage: '{prefix}history <@user|id>\n{prefix}case <id | user @user | by @user | recent [n]>\n{prefix}note @user <text>',
  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const guildId  = message.guildId;
    const authorId = message.author.id;
    if (!guildId) return;

    const cmdName = message.content.slice(prefix?.length ?? 2).trim().split(/\s+/)[0].toLowerCase();

    // Route !note / !addnote
    if (cmdName === 'note' || cmdName === 'addnote') {
      return handleNote(client, message, args, guildId, authorId, prefix);
    }

    // Route !case / !cases
    if (cmdName === 'case' || cmdName === 'cases') {
      return handleCase(client, message, args, guildId, prefix);
    }

    // !history, show mod history for a user
    if (!args[0]) {
      return message.reply({
        embeds: [Embed.info(
          [
            `**User history:** \`${prefix}history @user\``,
            `**Case lookup:**  \`${prefix}case <id>\``,
            `**Cases by user:** \`${prefix}case user @user [n]\``,
            `**Cases by staff:** \`${prefix}case by @user [n]\``,
            `**Recent cases:** \`${prefix}case recent [n]\``,
            `**Staff note:**   \`${prefix}note @user <text>\``,
          ].join('\n'),
          'History, Usage'
        ).toJSON()],
      });
    }

    const targetId = parseUserMention(args[0]) ?? args[0].replace(/\D/g, '');
    if (!targetId) return message.reply({ embeds: [Embed.danger('Could not resolve that user.').toJSON()] });

    let targetTag = targetId, avatarURL = null;
    try {
      const user = await client.rest.get(`/users/${targetId}`);
      targetTag  = user?.username ?? targetId;
    } catch { /* user left or unavailable */ }

    // Warnings come from the warnings table (it knows which were removed);
    // !warn also logs a modlog case, which listed every warning twice.
    const modCases  = getCasesForUser(guildId, targetId, 50).filter(c => String(c.action).toLowerCase() !== 'warn');
    const warnRows  = getAllWarnings(guildId, targetId);
    const warnCases = warnRows.map(w => ({
      case_number: `W-${w.id}`, action: 'warn',
      target_id: w.user_id, executor_id: w.executor_id,
      reason: w.reason, created_at: w.created_at,
      retired: !!w.removed_at,
    }));

    const cases = [...modCases, ...warnCases]
      .sort((a, b) => unixSeconds(b.created_at) - unixSeconds(a.created_at))
      .slice(0, 25);

    if (!cases.length) {
      return message.reply({ embeds: [Embed.info(`No mod history found for <@${targetId}>.`).toJSON()] });
    }

    const counts = {};
    for (const c of cases) counts[c.action] = (counts[c.action] ?? 0) + 1;
    const summary = Object.entries(counts).map(([k, v]) => `${styleFor(k).emoji} **${k}** ×${v}`).join('  ·  ');

    const caseLines = cases.map(c => {
      const style   = styleFor(c.action);
      const ts      = unixSeconds(c.created_at);
      const exec    = c.executor_id ? `<@${c.executor_id}>` : 'Unknown';
      const brief   = c.reason ? `\n> ${c.reason.slice(0, 80)}${c.reason.length > 80 ? '…' : ''}` : '';
      const retired = c.retired ? ' *(retired)*' : '';
      return `${style.emoji} \`#${c.case_number ?? c.id}\` **${c.action}**${retired}, <t:${ts}:d> by ${exec}${brief}`;
    });

    const topAction = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];

    const embed = new EmbedBuilder()
      .setColor(styleFor(topAction).color)
      .setTitle(`Mod History, ${targetTag}`)
      .setDescription(caseLines.join('\n\n').slice(0, 3900))
      .addFields({ name: 'Summary', value: summary || 'None', inline: false })
      .setFooter({ text: `Showing up to 25 most recent • ${targetId}` })
      .setTimestamp();

    await message.reply({ embeds: [embed.toJSON()] });
  },
};

async function handleCase(client, message, args, guildId, prefix) {
  const [sub, ...rest] = args;

  if (!sub) {
    const total = getCaseCount(guildId);
    return message.reply({
      embeds: [Embed.info(
        [
          `**${total.toLocaleString()}** case(s) on record.`,
          `\`${prefix}case <id>\`, look up by number`,
          `\`${prefix}case user @user [n]\`, cases targeting a user`,
          `\`${prefix}case by @user [n]\`, cases by a staff member`,
          `\`${prefix}case recent [n]\`, most recent cases`,
        ].join('\n'),
        'Case Lookup'
      ).toJSON()],
    });
  }

  // !case <number>
  if (/^\d+$/.test(sub)) {
    const c = getCase(guildId, parseInt(sub, 10));
    if (!c) return message.reply({ embeds: [Embed.danger(`Case #${sub} not found.`).toJSON()] });
    return message.reply({ embeds: [buildCaseEmbed(c).toJSON()] });
  }

  switch (sub.toLowerCase()) {
    case 'user': {
      const targetId = parseUserId(rest[0]);
      if (!targetId) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}case user @user [n]\``).toJSON()] });
      const cases = getCasesForUser(guildId, targetId, clamp(rest[1]));
      if (!cases.length) return message.reply({ embeds: [Embed.info(`No cases found for <@${targetId}>.`).toJSON()] });
      return message.reply({ embeds: [buildCaseListEmbed(cases, `Cases, <@${targetId}>`).toJSON()] });
    }

    case 'by': {
      const execId = parseUserId(rest[0]);
      if (!execId) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}case by @user [n]\``).toJSON()] });
      const cases = getCasesByExecutor(guildId, execId, clamp(rest[1]));
      if (!cases.length) return message.reply({ embeds: [Embed.info(`No cases by <@${execId}> found.`).toJSON()] });
      return message.reply({ embeds: [buildCaseListEmbed(cases, `Cases by <@${execId}>`).toJSON()] });
    }

    case 'recent': {
      const n = clamp(rest[0], 5, 20);
      const cases = db.prepare(
        `SELECT * FROM modlog_cases WHERE guild_id = ? ORDER BY case_number DESC LIMIT ?`
      ).all(guildId, n);
      if (!cases.length) return message.reply({ embeds: [Embed.info('No recent cases found.').toJSON()] });
      return message.reply({ embeds: [buildCaseListEmbed(cases, `Recent Cases`).toJSON()] });
    }

    default:
      return message.reply({ embeds: [Embed.warning(`Unknown subcommand. Use: user, by, recent, or a case number.`).toJSON()] });
  }
}

async function handleNote(client, message, args, guildId, authorId, prefix) {
  const targetId = parseUserId(args[0]);
  if (!targetId) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}note @user <text>\``).toJSON()] });

  const text = args.slice(1).join(' ').trim();
  if (!text) return message.reply({ embeds: [Embed.warning('Provide the note text.').toJSON()] });

  const targetUser = await client.rest.get(`/users/${targetId}`).catch(() => null);
  const targetTag  = targetUser?.username ?? targetId;

  await logAction({
    client, guildId, action: 'note',
    targetId, targetTag,
    executorId: authorId, executorTag: message.author.username,
    reason: text,
  });

  await message.reply({ embeds: [Embed.success(`Note added for <@${targetId}>.`).toJSON()] });
}
