import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';
import { resolveAccess } from '../../handlers/commandPermissions.js';
import { memberCanAssignRoleLive } from '../../config/guildPermissions.js';
import {
  getXpConfig, setXpConfigField, getUserXp, getUserRank,
  getLeaderboard, resetUserXp, resetAllXp,
  setRoleReward, removeRoleReward, getRoleRewards,
  softPrune, hardPrune, levelProgress,
  getLevelName, getLevelDefinitions, getStreak, getStreakSettings,
} from '../../handlers/xpSystem.js';
import { renderRankCard } from '../../handlers/profileCard.js';
import { parseUserMention } from '@fluxerjs/core';

export default {
  name: 'xp',
  aliases: ['level', 'lvl'],
  description: 'XP system management.',
  usage: '{prefix}xp [config|leaderboard|rank|reset|prune|rolereward]',
  requiredPermission: null,
  internalAccess: true, // subcommands gate themselves via resolveAccess

  cooldown: 5,

  async execute({ message, args, prefix, client }) {
    const guildId    = message.guildId;
    const executorId = message.author.id;
    const sub        = args[0]?.toLowerCase();

    if (!sub) return handleRank(client, message, [], guildId, executorId, prefix);
    if (sub === 'rank')        return handleRank(client, message, args.slice(1), guildId, executorId, prefix);
    if (sub === 'leaderboard' || sub === 'lb') return handleLeaderboard(message, args.slice(1), guildId, prefix);
    if (sub === 'config')      return handleConfig(client, message, args.slice(1), guildId, executorId, prefix);
    if (sub === 'reset')       return handleReset(client, message, args.slice(1), guildId, executorId, prefix);
    if (sub === 'prune')       return handlePrune(client, message, args.slice(1), guildId, executorId, prefix);
    if (sub === 'rolereward' || sub === 'rr') return handleRoleReward(client, message, args.slice(1), guildId, executorId, prefix);

    await message.reply({ embeds: [Embed.warning(`Unknown subcommand. Use \`${prefix}xp rank|leaderboard|config|reset|prune|rolereward\``).toJSON()] });
  },
};

async function handleRank(client, message, args, guildId, executorId, prefix) {
  const targetId = args[0]
    ? (parseUserMention(args[0]) ?? args[0].replace(/\D/g, ''))
    : executorId;

  const userData = getUserXp(guildId, targetId);
  if (!userData) {
    return message.reply({ embeds: [Embed.info('No XP data found for that user.').toJSON()] });
  }

  const rank      = getUserRank(guildId, targetId) ?? 0;
  const xp        = userData.xp;
  const { level, next, progress } = levelProgress(guildId, xp);
  const levelName = getLevelName(guildId, level);

  const targetUser = await client.rest.get(`/users/${targetId}`).catch(() => null);
  const username   = targetUser?.username ?? userData.display_name ?? targetId;
  const avatarUrl  = targetUser?.avatar
    ? `https://fluxerusercontent.com/avatars/${targetId}/${targetUser.avatar}.png?size=128`
    : null;

  const cardBuffer = await renderRankCard({
    username, avatarUrl, xp, level, rank, levelName,
    xpForNextLevel: next ?? xp, // top of a custom ladder
    xpProgress: progress,
  });

  const levelLabel = levelName ? `Level ${level} · ${levelName}` : `Level ${level}`;
  const sendTextFallback = () => {
    const embed = new EmbedBuilder()
      .setColor(COLORS.SUCCESS)
      .setTitle(`${username}: ${levelLabel}`)
      .addFields(
        { name: 'XP',    value: `${xp.toLocaleString()} / ${next == null ? 'Max' : next.toLocaleString()}`, inline: true },
        { name: 'Rank',  value: `#${rank}`, inline: true },
      );
    const streak = getStreak(guildId, targetId);
    if (streak > 1) embed.addFields({ name: 'Streak', value: `${streak}`, inline: true });
    return message.reply({ embeds: [embed.toJSON()] });
  };

  if (cardBuffer) {
    // If the image reply fails for any reason (missing Attach Files
    // permission, size limit, a network blip), fall back to text instead of
    // throwing, which would otherwise quarantine this command after one bad
    // upload unrelated to the command's own logic.
    await message.reply({ files: [{ name: 'rank.png', data: cardBuffer }] }).catch(() => sendTextFallback());
  } else {
    await sendTextFallback();
  }
}

async function handleLeaderboard(message, args, guildId, prefix) {
  const page  = parseInt(args[0], 10) || 1;
  const { rows, total } = getLeaderboard(guildId, page, 10);

  if (!rows.length) {
    const msg = total ? `There are only ${Math.ceil(total / 10)} page(s).` : 'No XP data yet.';
    return message.reply({ embeds: [Embed.info(msg).toJSON()] });
  }

  const offset = (page - 1) * 10;
  const levelNames = new Map(getLevelDefinitions(guildId).map(l => [l.level, l.name]));
  const lines  = rows.map((r, i) => {
    const name = levelNames.get(r.level);
    const levelText = name ? `Level **${r.level}** (${name})` : `Level **${r.level}**`;
    return `**${offset + i + 1}.** <@${r.user_id}>: ${levelText} (${r.xp.toLocaleString()} XP)`;
  });

  const embed = new EmbedBuilder()
    .setColor(COLORS.SUCCESS)
    .setTitle('XP Leaderboard')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Page ${page} • ${total} users • ${prefix}xp leaderboard <page>` });

  await message.reply({ embeds: [embed.toJSON()] });
}

async function handleConfig(client, message, args, guildId, executorId, prefix) {
  if (!await resolveAccess(client, guildId, executorId, 'xp', Permissions.BAN_MEMBERS)) {
    return message.reply({ embeds: [Embed.denied('Ban Members or higher required.').toJSON()] });
  }

  const field = args[0]?.toLowerCase();
  // The message is free text, so take everything after the field name
  // (it used to keep only the first word).
  const value = field === 'message' ? args.slice(1).join(' ').trim() : args[1];

  if (!field || !value) {
    const config = getXpConfig(guildId);
    const embed  = new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle('XP Config')
      .addFields(
        { name: 'Enabled',          value: config.enabled ? 'Yes' : 'No', inline: true },
        { name: 'XP Range',         value: `${config.xp_min}–${config.xp_max}`,  inline: true },
        { name: 'Cooldown',         value: `${config.xp_cooldown_s}s`,    inline: true },
        { name: 'Level-up Channel', value: config.levelup_channel ? `<#${config.levelup_channel}>` : 'Where the member is talking', inline: true },
        { name: 'Stack Roles',      value: config.stack_roles ? 'Yes' : 'No', inline: true },
        { name: 'Streak Bonus',     value: (s => s.enabled ? `+${s.bonus_pct}% (${s.mode === 'week' ? 'weekly' : 'daily'}, all servers)` : 'Off')(getStreakSettings()), inline: true },
        { name: 'Decay',            value: config.decay_enabled ? `${config.decay_rate_pct}% every ${config.decay_interval_days} days` : 'Off', inline: true },
      )
      .setFooter({ text: `${prefix}xp config <enabled|min|max|cooldown|channel|message|stackroles> <value>. More settings on the dashboard.` });
    return message.reply({ embeds: [embed.toJSON()] });
  }

  const fieldMap = {
    enabled:    'enabled',
    min:        'xp_min',
    max:        'xp_max',
    cooldown:   'xp_cooldown_s',
    channel:    'levelup_channel',
    message:    'levelup_message',
    stackroles: 'stack_roles',
  };

  const dbField = fieldMap[field];
  if (!dbField) {
    return message.reply({ embeds: [Embed.warning(`Unknown field. Valid: ${Object.keys(fieldMap).join(', ')}`).toJSON()] });
  }

  const warn = (text) => message.reply({ embeds: [Embed.warning(text).toJSON()] });
  let parsed;
  if (['enabled', 'stack_roles'].includes(dbField)) {
    const v = value.toLowerCase();
    if (['true', '1', 'on', 'yes'].includes(v)) parsed = 1;
    else if (['false', '0', 'off', 'no'].includes(v)) parsed = 0;
    else return warn('Use `on` or `off`.');
  } else if (['xp_min', 'xp_max', 'xp_cooldown_s'].includes(dbField)) {
    parsed = Number(value);
    const max = dbField === 'xp_cooldown_s' ? 86400 : 10000;
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) return warn(`\`${field}\` must be a whole number from 0 to ${max}.`);
    const cfg = getXpConfig(guildId);
    if ((dbField === 'xp_min' && parsed > cfg.xp_max) || (dbField === 'xp_max' && parsed < cfg.xp_min)) {
      return warn(`Min can't be above max (currently ${cfg.xp_min}–${cfg.xp_max}).`);
    }
  } else if (dbField === 'levelup_channel') {
    // The command handler's foreign-channel gate already rejects channels
    // from other servers; this just stores the bare ID.
    if (['none', 'off', 'reset'].includes(value.toLowerCase())) parsed = null;
    else if (!(parsed = value.replace(/\D/g, ''))) return warn('Mention a channel, or use `none` to post where the member is talking.');
  } else {
    if (value.length > 1000) return warn('Keep the message under 1000 characters.');
    parsed = value;
  }

  setXpConfigField(guildId, dbField, parsed);
  await message.reply({ embeds: [Embed.success(`Set \`${field}\` to \`${value}\`.`).toJSON()] });
}

async function handleReset(client, message, args, guildId, executorId, prefix) {
  if (!await resolveAccess(client, guildId, executorId, 'xp', Permissions.BAN_MEMBERS)) {
    return message.reply({ embeds: [Embed.denied('Ban Members or higher required.').toJSON()] });
  }

  const target = args[0];
  if (!target) {
    return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}xp reset @user|all\``).toJSON()] });
  }

  if (target === 'all') {
    // Same bar as the dashboard's server-wide wipe.
    if (!await resolveAccess(client, guildId, executorId, 'xp', 'SERVER_OWNER')) {
      return message.reply({ embeds: [Embed.denied('Only the Server Owner can wipe everyone\'s XP.').toJSON()] });
    }
    resetAllXp(guildId);
    return message.reply({ embeds: [Embed.success('Reset all XP data for this server.').toJSON()] });
  }

  const targetId = parseUserMention(target) ?? target.replace(/\D/g, '');
  resetUserXp(guildId, targetId);
  await message.reply({ embeds: [Embed.success(`Reset XP for <@${targetId}>.`).toJSON()] });
}

async function handlePrune(client, message, args, guildId, executorId, prefix) {
  if (!await resolveAccess(client, guildId, executorId, 'xp', Permissions.BAN_MEMBERS)) {
    return message.reply({ embeds: [Embed.denied('Ban Members or higher required.').toJSON()] });
  }

  const mode = args[0]?.toLowerCase();
  if (mode !== 'soft' && mode !== 'hard') {
    return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}xp prune soft|hard\``).toJSON()] });
  }

  await message.reply({ embeds: [Embed.info('Fetching member list…').toJSON()] });

  const result = mode === 'hard'
    ? await hardPrune(client, guildId)
    : await softPrune(client, guildId);

  await message.reply({
    embeds: [Embed.success(`${mode === 'hard' ? 'Hard' : 'Soft'} prune complete. **${result.pruned}** user(s) pruned.`).toJSON()],
  });
}

async function handleRoleReward(client, message, args, guildId, executorId, prefix) {
  if (!await resolveAccess(client, guildId, executorId, 'xp', Permissions.BAN_MEMBERS)) {
    return message.reply({ embeds: [Embed.denied('Ban Members or higher required.').toJSON()] });
  }

  const sub = args[0]?.toLowerCase();

  if (sub === 'add') {
    const level  = parseInt(args[1], 10);
    const roleId = args[2]?.replace(/\D/g, '');
    if (!level || !roleId) {
      return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}xp rolereward add <level> @role\``).toJSON()] });
    }
    // Level-ups hand this role out automatically, so whoever sets it up has
    // to be able to give it themselves.
    if (!await memberCanAssignRoleLive(client, guildId, executorId, roleId)) {
      return message.reply({ embeds: [Embed.denied('That role is at or above your highest role, so you can\'t make it a reward.').toJSON()] });
    }
    setRoleReward(guildId, level, roleId);
    return message.reply({ embeds: [Embed.success(`Added <@&${roleId}> as a reward for Level **${level}**.`).toJSON()] });
  }

  if (sub === 'remove') {
    const level  = parseInt(args[1], 10);
    // A level can hold more than one role (same table the dashboard's
    // "+ Role" button writes to), so this needs to know which one to
    // remove rather than clearing everything bound to the level.
    const roleId = args[2]?.replace(/\D/g, '');
    if (!level || !roleId) {
      return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}xp rolereward remove <level> @role\``).toJSON()] });
    }
    removeRoleReward(guildId, level, roleId);
    return message.reply({ embeds: [Embed.success(`Removed <@&${roleId}> as a reward for Level **${level}**.`).toJSON()] });
  }

  // List
  const rewards = getRoleRewards(guildId);
  if (!rewards.length) {
    return message.reply({ embeds: [Embed.info('No role rewards configured.').toJSON()] });
  }
  const lines = rewards.map(r => `Level **${r.level}** → <@&${r.role_id}>`);
  await message.reply({ embeds: [Embed.info(lines.join('\n'), 'Role Rewards').toJSON()] });
}
