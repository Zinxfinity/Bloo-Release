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
  adjustXp, syncRewardRoles, rewardRolesForXp, MAX_XP,
  XpSettingError, setMultiplier, listMultipliers, startBoost, endBoost, listBoosts,
  listLevelDefs, setLevelDef, removeLevelDef,
} from '../../handlers/xpSystem.js';
import { logAction } from '../../handlers/modLog.js';
import logger from '../../utils/logger.js';
import { isBotOwner, isRealOwner } from '../../handlers/staffSystem.js';

// Whether someone can hand out a role themselves. The server owner and bot
// owners always can; everyone else needs a highest role above it.
async function canHandOut(client, guildId, userId, roleId) {
  if (isBotOwner(userId) || await isRealOwner(guildId, userId)) return true;
  return memberCanAssignRoleLive(client, guildId, userId, roleId);
}
import { renderRankCard } from '../../handlers/profileCard.js';
import { getCardProfile } from '../../handlers/cardBackgrounds.js';
import { parseUserMention } from '@fluxerjs/core';

export default {
  name: 'xp',
  aliases: ['level', 'lvl'],
  description: 'XP system management.',
  usage: '{prefix}xp [config|leaderboard|rank|reset|prune|rolereward]\n{prefix}xp <give|take|set> @user <amount>\n{prefix}xp syncroles\n{prefix}xp multiplier [<#channel|@role> <0-10|reset>]\n{prefix}xp boost [<multiplier> <hours> [label] | end <id>]\n{prefix}xp level [set <level> <xp> <name> | remove <level>]',
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
    if (sub === 'give' || sub === 'take' || sub === 'set') return handleAdjust(client, message, sub, args.slice(1), guildId, executorId, prefix);
    if (sub === 'syncroles')   return handleSyncRoles(client, message, guildId, executorId);
    if (['multiplier', 'multi', 'boost', 'level', 'levels'].includes(sub)) return handleXpSettings(client, message, sub, args.slice(1), guildId, executorId, prefix);

    await message.reply({ embeds: [Embed.warning(`Unknown subcommand. Use \`${prefix}xp rank|leaderboard|config|reset|prune|rolereward|give|take|set|syncroles|multiplier|boost|level\``).toJSON()] });
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
  const { level, next, nextLevel, progress } = levelProgress(guildId, xp);
  const levelName = getLevelName(guildId, level);

  const targetUser = await client.rest.get(`/users/${targetId}`).catch(() => null);
  const username   = targetUser?.username ?? userData.display_name ?? targetId;
  const avatarUrl  = targetUser?.avatar
    ? `https://fluxerusercontent.com/avatars/${targetId}/${targetUser.avatar}.png?size=128`
    : null;

  const card = getCardProfile(targetId); // theme and approved background, from b!card
  const cardBuffer = await renderRankCard({
    theme: card.theme, background: card.background, supporter: card.supporter, contributor: card.contributor,
    username, avatarUrl, xp, level, rank, levelName,
    xpForNextLevel: next ?? xp,
    maxed: next == null, // top of a custom ladder
    // "27% to 🫖 Tea Lover": the server's name for the next level, or its number.
    nextLabel: next == null ? null : (getLevelName(guildId, nextLevel) ?? `Level ${nextLevel}`),
    fallbackName: userData.display_name,
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
  const onOff = c => (c ? 'On' : 'Off');

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
        { name: 'Levels',           value: onOff(config.levels_enabled ?? 1), inline: true },
        { name: 'Level-up Message', value: (config.levelup_notify ?? 1) ? 'Posted' : 'Not posted', inline: true },
        { name: 'Reward Roles',     value: onOff(config.role_rewards ?? 1), inline: true },
        { name: 'Embed Colour',     value: config.levelup_color ?? 'Default', inline: true },
        { name: 'Banner Image',     value: config.levelup_image ? 'Set' : 'None', inline: true },
        { name: 'Streak Bonus',     value: (s => s.enabled ? `+${s.bonus_pct}% (${s.mode === 'week' ? 'weekly' : 'daily'}, all servers)` : 'Off')(getStreakSettings()), inline: true },
        { name: 'Decay',            value: config.decay_enabled
            ? `${config.decay_rate_pct}% after ${config.decay_interval_days} quiet days, never below ${config.decay_floor_mode === 'level' ? 'level' : ''} ${(config.decay_floor_xp ?? 0).toLocaleString()}${config.decay_floor_mode === 'level' ? '' : ' XP'}${config.role_remove_on_decay ? ', reward roles removed' : ''}`
            : 'Off', inline: false },
      )
      .setFooter({ text: `${prefix}xp config <setting> <value>. Settings: enabled, min, max, cooldown, channel, message, stackroles, levels, notify, rolerewards, color, image, decay, decayrate, decaydays, decayfloor, decayfloormode, decayroles` });
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
    // Same settings as the dashboard's XP page.
    levels:         'levels_enabled',
    notify:         'levelup_notify',
    rolerewards:    'role_rewards',
    color:          'levelup_color',
    colour:         'levelup_color',
    image:          'levelup_image',
    decay:          'decay_enabled',
    decayrate:      'decay_rate_pct',
    decaydays:      'decay_interval_days',
    decayfloor:     'decay_floor_xp',
    decayfloormode: 'decay_floor_mode',
    decayroles:     'role_remove_on_decay',
  };

  const dbField = fieldMap[field];
  if (!dbField) {
    return message.reply({ embeds: [Embed.warning(`Unknown field. Valid: ${Object.keys(fieldMap).join(', ')}`).toJSON()] });
  }

  const warn = (text) => message.reply({ embeds: [Embed.warning(text).toJSON()] });
  let parsed;
  const RANGES = { decay_rate_pct: [0, 100, '%'], decay_interval_days: [1, 365, ' days'], decay_floor_xp: [0, 1e9, ''] };
  if (['enabled', 'stack_roles', 'levels_enabled', 'levelup_notify', 'role_rewards', 'decay_enabled', 'role_remove_on_decay'].includes(dbField)) {
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
  } else if (RANGES[dbField]) {
    const [lo, hi, unit] = RANGES[dbField];
    parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < lo || parsed > hi) return warn(`\`${field}\` must be a whole number from ${lo} to ${hi.toLocaleString()}${unit}.`);
  } else if (dbField === 'decay_floor_mode') {
    parsed = value.toLowerCase();
    if (!['xp', 'level'].includes(parsed)) return warn('Use `xp` (never drop below that much XP) or `level` (never drop below that level).');
  } else if (dbField === 'levelup_color') {
    if (['none', 'off', 'reset', 'default'].includes(value.toLowerCase())) parsed = null;
    else if (/^#?[0-9a-f]{6}$/i.test(value)) parsed = value.startsWith('#') ? value : `#${value}`;
    else return warn('Use a 6-digit hex colour like `#F5A623`, or `none`.');
  } else if (dbField === 'levelup_image') {
    if (['none', 'off', 'reset'].includes(value.toLowerCase())) parsed = null;
    else if (/^https?:\/\/\S+$/i.test(value)) parsed = value;
    else return warn('Use an image link starting with http(s), or `none`.');
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
    if (!await canHandOut(client, guildId, executorId, roleId)) {
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

// ─── give / take / set ────────────────────────────────────────────────────────
// Manage Roles, because the new level hands out (or takes away) level roles.
// Give/set also refuse when that would grant a reward role the moderator
// couldn't give by hand, so XP can't be used to get around the role order.
async function handleAdjust(client, message, mode, args, guildId, executorId, prefix) {
  if (!await resolveAccess(client, guildId, executorId, 'xp', Permissions.MANAGE_ROLES)) {
    return message.reply({ embeds: [Embed.denied('Manage Roles or higher required.').toJSON()] });
  }
  const usage = () => message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}xp ${mode} @user <amount>\``).toJSON()] });
  const targetId = args[0] ? (parseUserMention(args[0]) ?? args[0].replace(/\D/g, '')) : '';
  const amount   = Number(String(args[1] ?? '').replace(/[,_]/g, ''));
  if (!/^\d{15,22}$/.test(targetId) || !Number.isInteger(amount)) return usage();
  if (amount < 0 || amount > MAX_XP || (mode !== 'set' && amount === 0)) {
    return message.reply({ embeds: [Embed.warning(`The amount must be a whole number from ${mode === 'set' ? 0 : 1} to ${MAX_XP.toLocaleString()}.`).toJSON()] });
  }

  const before = getUserXp(guildId, targetId)?.xp ?? 0;
  const after  = mode === 'set' ? amount : mode === 'take' ? before - amount : before + amount;
  if (mode !== 'take') {
    for (const r of rewardRolesForXp(guildId, after)) {
      if (!await canHandOut(client, guildId, executorId, r.role_id)) {
        return message.reply({ embeds: [Embed.denied(`That would give <@${targetId}> the level ${r.level} role <@&${r.role_id}>, which is at or above your highest role.`).toJSON()] });
      }
    }
  }

  const res  = await adjustXp(client, guildId, targetId, mode, amount);
  const verb = { give: `Gave **${amount.toLocaleString()} XP** to`, take: `Took **${amount.toLocaleString()} XP** from`, set: 'Set the XP of' }[mode];
  const levelText = res.level === res.oldLevel ? `level ${res.level}` : `level ${res.oldLevel} → **${res.level}**`;
  const lines = [
    `${verb} <@${targetId}>${mode === 'set' ? ` to **${res.xp.toLocaleString()} XP**` : ''}.`,
    `${res.before.toLocaleString()} → ${res.xp.toLocaleString()} XP, ${levelText}.`,
  ];
  if (res.roles && (res.roles.given || res.roles.removed)) lines.push(`Level roles: ${res.roles.given} given, ${res.roles.removed} removed.`);
  if (res.roles?.failed) lines.push(`⚠️ ${res.roles.failed} level role change(s) failed. Bloo's role must be above the level roles, with Manage Roles.`);

  await logAction({
    client, guildId, action: 'XP Changed', targetId, executorId,
    reason: `${mode} ${amount} XP: ${res.before} → ${res.xp} (level ${res.oldLevel} → ${res.level})`,
  }).catch(() => {});
  await message.reply({ embeds: [Embed.success(lines.join('\n')).toJSON()] });
}

// ─── syncroles ────────────────────────────────────────────────────────────────
// Gives everyone the level roles their XP has earned and takes away ones it
// hasn't, e.g. members who passed a level before its role was set up.
async function handleSyncRoles(client, message, guildId, executorId) {
  if (!await resolveAccess(client, guildId, executorId, 'xp', Permissions.MANAGE_ROLES)) {
    return message.reply({ embeds: [Embed.denied('Manage Roles or higher required.').toJSON()] });
  }
  for (const r of getRoleRewards(guildId)) {
    if (!await canHandOut(client, guildId, executorId, r.role_id)) {
      return message.reply({ embeds: [Embed.denied(`The level ${r.level} role <@&${r.role_id}> is at or above your highest role, so you can't sync level roles.`).toJSON()] });
    }
  }

  const status   = await message.reply({ embeds: [Embed.info('Checking members\' level roles…').toJSON()] });
  const show     = embed => status?.edit
    ? status.edit({ embeds: [embed.toJSON()] }).catch(() => message.reply({ embeds: [embed.toJSON()] }))
    : message.reply({ embeds: [embed.toJSON()] });
  const progress = res => status?.edit?.({ embeds: [Embed.info(`Checked ${res.checked} of ${res.total} members…`).toJSON()] }).catch(() => {});
  const res = await syncRewardRoles(client, guildId, progress);

  if (res.busy)      return show(Embed.warning('A role sync is already running in this server.'));
  if (res.off)       return show(Embed.warning('Level roles are turned off in this server\'s XP settings.'));
  if (res.noRewards) return show(Embed.info('This server has no level roles set up.'));

  const lines = [
    `Checked **${res.checked}** member(s) at or above the first reward level.`,
    `**${res.changed}** needed changes: ${res.given} role(s) given, ${res.removed} removed.`,
  ];
  if (res.left)   lines.push(`${res.left} member(s) have left the server and were skipped.`);
  if (res.failed) lines.push(`⚠️ ${res.failed} change(s) failed. Bloo's role must be above the level roles, with Manage Roles.`);
  // Not a mod log case: those need one target member, and this covers everyone.
  logger.info(`[XP] syncroles in ${guildId} by ${executorId}: ${res.checked} checked, ${res.changed} changed (+${res.given} / -${res.removed}), ${res.failed} failed`);
  await show(res.failed ? Embed.warning(lines.join('\n')) : Embed.success(lines.join('\n')));
}

// ─── b!xp multiplier / boost / level ──────────────────────────────────────────
// The rest of the dashboard's XP page, by command:
//   b!xp multiplier                          list channel and role multipliers
//   b!xp multiplier <#channel|@role> <0-10>  set one (0 = no XP there)
//   b!xp multiplier <#channel|@role> reset   remove it
//   b!xp boost                               list running boosts
//   b!xp boost <multiplier> <hours> [label]  start a server-wide XP boost
//   b!xp boost end <id>                      end one early
//   b!xp level                               list custom level names
//   b!xp level set <level> <xp> <name>       name a level and set its XP
//   b!xp level remove <level>                back to the default curve
async function handleXpSettings(client, message, sub, args, guildId, executorId, prefix) {
  if (!await resolveAccess(client, guildId, executorId, 'xp', Permissions.BAN_MEMBERS)) {
    return message.reply({ embeds: [Embed.denied('Ban Members or higher required.').toJSON()] });
  }
  const reply = (e) => message.reply({ embeds: [e.toJSON()] });
  try {
    if (sub === 'multiplier' || sub === 'multi') {
      if (!args[0]) {
        const { channels, roles } = listMultipliers(guildId);
        const lines = [
          ...channels.map(c => `<#${c.channel_id}>: **×${c.multiplier}**${c.multiplier === 0 ? ' (no XP)' : ''}`),
          ...roles.map(r => `<@&${r.role_id}>: **×${r.multiplier}**${r.multiplier === 0 ? ' (no XP)' : ''}`),
        ];
        return reply(Embed.info(lines.length ? lines.join('\n') : 'No multipliers. Everyone earns the normal amount everywhere.', 'XP multipliers')
          .setFooter({ text: `${prefix}xp multiplier <#channel|@role> <0-10|reset>` }));
      }
      const ch = args[0].match(/^<#(\d+)>$/)?.[1], role = args[0].match(/^<@&(\d+)>$/)?.[1];
      const kind = ch ? 'channel' : role ? 'role' : null;
      if (!kind || !args[1]) return reply(Embed.warning(`Usage: \`${prefix}xp multiplier <#channel|@role> <0-10|reset>\`. 0 means no XP there, 2 means double.`));
      const target = ch ?? role, label = ch ? `<#${ch}>` : `<@&${role}>`;
      if (['reset', 'remove', 'off', 'none'].includes(args[1].toLowerCase())) {
        return reply(setMultiplier(guildId, kind, target, null)
          ? Embed.success(`${label} earns the normal amount of XP again.`)
          : Embed.info(`${label} didn't have a multiplier.`));
      }
      const m = Number(args[1].replace(/^x/i, ''));
      setMultiplier(guildId, kind, target, m);
      return reply(Embed.success(m === 0 ? `No XP is earned ${kind === 'channel' ? 'in' : 'by members with'} ${label} now.` : `XP ${kind === 'channel' ? 'in' : 'for members with'} ${label} is now **×${m}**.`));
    }

    if (sub === 'boost') {
      if (!args[0]) {
        const boosts = listBoosts(guildId);
        return reply(Embed.info(boosts.length
          ? boosts.map(b => `**#${b.id}** ×${b.multiplier}${b.label ? ` · ${b.label}` : ''} · ends <t:${Math.floor(b.expires_at / 1000)}:R>`).join('\n')
          : 'No XP boost is running.', 'XP boosts').setFooter({ text: `${prefix}xp boost <multiplier> <hours> [label] · ${prefix}xp boost end <id>` }));
      }
      if (args[0].toLowerCase() === 'end') {
        return reply(endBoost(guildId, args[1]) ? Embed.success(`Boost #${args[1]} ended.`) : Embed.warning(`No running boost #${args[1] ?? '?'}.`));
      }
      const m = Number(args[0].replace(/^x/i, '')), hours = Number(args[1]);
      if (!args[1]) return reply(Embed.warning(`Usage: \`${prefix}xp boost <multiplier> <hours> [label]\`, e.g. \`${prefix}xp boost 2 24 Double XP weekend\`.`));
      const id = startBoost(guildId, m, hours, args.slice(2).join(' ') || null, executorId);
      return reply(Embed.success(`Boost #${id} started: **×${m}** XP for everyone for ${hours} hour${hours === 1 ? '' : 's'}, ending <t:${Math.floor((Date.now() + hours * 3_600_000) / 1000)}:R>.`));
    }

    // level / levels
    const action = args[0]?.toLowerCase();
    if (!action || action === 'list') {
      const defs = listLevelDefs(guildId);
      return reply(Embed.info(defs.length
        ? defs.map(d => `**${d.level}.** ${d.name}: ${d.xp_required.toLocaleString()} XP`).join('\n')
        : 'No custom levels. Members level up on the default curve.', 'Custom levels')
        .setFooter({ text: `${prefix}xp level set <level> <xp> <name> · ${prefix}xp level remove <level>` }));
    }
    if (action === 'set') {
      const level = Number(args[1]), xp = Number(String(args[2] ?? '').replace(/,/g, ''));
      if (!args[3]) return reply(Embed.warning(`Usage: \`${prefix}xp level set <level> <xp needed> <name>\`, e.g. \`${prefix}xp level set 5 2500 Regular\`.`));
      setLevelDef(guildId, level, xp, args.slice(3).join(' '));
      return reply(Embed.success(`Level ${level} is now **${args.slice(3).join(' ')}**, reached at ${xp.toLocaleString()} XP.`));
    }
    if (action === 'remove' || action === 'delete') {
      return reply(removeLevelDef(guildId, Number(args[1]))
        ? Embed.success(`Level ${args[1]} removed, along with any reward roles set on it.`)
        : Embed.warning(`There's no custom level ${args[1] ?? '?'}.`));
    }
    return reply(Embed.warning(`Usage: \`${prefix}xp level [list | set <level> <xp> <name> | remove <level>]\``));
  } catch (err) {
    if (err instanceof XpSettingError) return reply(Embed.warning(err.message));
    throw err;
  }
}
