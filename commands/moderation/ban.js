// ============================================================
//  commands/moderation/ban.js , fully implemented
// ============================================================

import { EmbedBuilder }       from '@fluxerjs/core';
import { Embed, COLORS }      from '../../config/embeds.js';
import { isRealOwner, isBotOwner, getMemberPermissionBitsLive } from '../../handlers/staffSystem.js';
import { resolveAccess }      from '../../handlers/commandPermissions.js';
import { logAction }          from '../../handlers/modLog.js';
import { canActOnLive, botCanActOnLive, Permissions } from '../../config/guildPermissions.js';
import {
  getBanConfig, setBanConfigField, needsApproval, banNeedsApproval, hasBanPermission, approvalWhere, recordBan,
  isLockedOut, getLockout, clearLockout, listLockouts,
  hasBanOverride, setBanOverride, clearBanOverride, listBanOverrides,
  createApprovalRequest, setApprovalMessage, listPendingApprovals,
  getApproval, resolveApproval, performBanAction,
} from '../../handlers/banSystem.js';
import { isPermissionError, notifyOwnerPermError } from '../../handlers/permissionGuard.js';
import { syncBanAcrossGroup } from '../../handlers/banSync.js';
import { clearPendingTempbans } from '../../handlers/warnSystem.js';

function parseId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

async function resolveUser(client, userId) {
  try { return await client.rest.get(`/users/${userId}`); } catch { return null; }
}

function userTag(u) { return u?.username ?? u?.tag ?? 'Unknown'; }

const APPROVAL_PERM_NAMES = new Map([
  [Permissions.KICK_MEMBERS, 'Kick Members'],
  [Permissions.BAN_MEMBERS,  'Ban Members'],
  [Permissions.MANAGE_GUILD, 'Manage Guild'],
  [Permissions.ADMINISTRATOR, 'Administrator'],
]);
function approvalPermLabel(bit) { return APPROVAL_PERM_NAMES.get(bit) ?? `Permission ${bit}`; }

async function postApprovalEmbed(client, guildId, approvalId, cfg, targetTag, executorTag, reason, targetId) {
  const ch = cfg.approval_channel;
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setColor(COLORS.WARNING)
    .setTitle('\u{1F528}  Ban Approval Required')
    .addFields(
      { name: '\u{1F3AF} Target',       value: `${targetTag} (\`${targetId}\`)`,  inline: true  },
      { name: '\u{1F46E} Requested by', value: executorTag,                          inline: true  },
      { name: '\u{1F4CB} Reason',       value: reason,                               inline: false },
      { name: '\u26A1 Approval ID',     value: `#${approvalId}`,                     inline: true  },
    )
    .setFooter({ text: `React \u2705 to approve \u274C to deny  |  Or use !ban approve/deny ${approvalId}` })
    .setTimestamp();
  try {
    const msg = await client.rest.post(`/channels/${ch}/messages`, { body: { embeds: [embed.toJSON()] } });
    if (msg?.id) {
      setApprovalMessage(approvalId, msg.id, ch);
      for (const emoji of ['\u2705', '\u274C']) {
        await client.rest.put(`/channels/${ch}/messages/${msg.id}/reactions/${encodeURIComponent(emoji)}/@me`).catch(() => {});
      }
    }
  } catch {}
}

async function executeBan(client, guildId, targetId, executorId, reason, deleteDays = 1) {
  await performBanAction(client.rest, guildId, targetId, reason, 'ban', deleteDays);
  await logAction({ client, guildId, action: 'Member Banned', targetId, executorId, reason }).catch(() => {});
  const guildName = client.guilds?.cache?.get(guildId)?.name ?? guildId;
  syncBanAcrossGroup(client, guildId, targetId, reason, guildName).catch(() => {});
}

// Replays the actual action an approval was queued for. 'soft' is a
// put-then-immediately-unban, not a real ban, so it can't go through
// executeBan like the others, everything else is a real ban differing
// only in how long messages are purged.
async function executeBanAction(client, guildId, targetId, executorId, reason, actionType, durationS = null, deleteDays = null) {
  const { action } = await performBanAction(client.rest, guildId, targetId, reason, actionType, deleteDays, durationS);
  await logAction({ client, guildId, action, targetId, executorId, reason }).catch(() => {});
  if (action === 'Member Banned') {
    const guildName = client.guilds?.cache?.get(guildId)?.name ?? guildId;
    syncBanAcrossGroup(client, guildId, targetId, reason, guildName).catch(() => {});
  }
}

// Shared "queue for approval, or run it now" gate for single-target ban
// subcommands (soft/hard). Previously only plain !ban ever checked
// needsApproval at all, softBan/hardBan/massBan executed immediately
// regardless of a guild's require_approval setting, a real bypass of a
// safety control an admin explicitly turned on.
async function banOrQueue(client, message, guildId, executorId, targetId, reason, actionType) {
  const executorIsOwner = isBotOwner(executorId) || await isRealOwner(guildId, executorId);
  // Server approval mode (softban/hardban): Ban Members holders are trusted.
  if (needsApproval(guildId, executorId, executorIsOwner) && !(await hasBanPermission(client.rest, guildId, executorId))) {
    const targetUser = await resolveUser(client, targetId);
    const cfg = getBanConfig(guildId);
    const id  = createApprovalRequest({ guildId, targetId, targetTag: userTag(targetUser), executorId, executorTag: message.author.username, reason, actionType });
    await postApprovalEmbed(client, guildId, id, cfg, userTag(targetUser), message.author.username, reason, targetId);
    return { queued: true, id, cfg };
  }
  await executeBanAction(client, guildId, targetId, executorId, reason, actionType);
  return { queued: false };
}

// Plain ban and hard ban share this: same permission rule (Kick Members,
// approval unless Ban Members), same rank check when the target is still a
// member, works on anyone who already left. Hard ban only differs in keeping
// the person's messages (deleteDays 0).
async function standardBan(client, message, args, guildId, executorId, { deleteDays = 1 } = {}) {
  const executorIsOwner = isBotOwner(executorId) || await isRealOwner(guildId, executorId);
  if (isLockedOut(guildId, executorId)) {
    const l = getLockout(guildId, executorId);
    return message.reply({ embeds: [Embed.danger('\u{1F512}  Ban Access Locked').setDescription(`You have been locked out.\n**Reason:** ${l.reason}\nExpires: <t:${l.expires_at}:R>`).toJSON()] });
  }
  const targetId = parseId(args[0]);
  const reason   = args.slice(1).join(' ') || 'No reason provided';
  if (!targetId) return message.reply({ embeds: [Embed.warning('Provide a user mention or ID.').toJSON()] });
  if (targetId === executorId) return message.reply({ embeds: [Embed.danger('You cannot ban yourself.').toJSON()] });

  // Rank only applies while the target is a member; someone who already
  // left (or never joined) can be banned by ID either way.
  const targetIsMember = await client.rest.get(`/guilds/${guildId}/members/${targetId}`).catch(() => null);
  if (targetIsMember) {
    if (!executorIsOwner && !(await canActOnLive(client, guildId, executorId, targetId))) {
      return message.reply({ embeds: [Embed.denied('Cannot ban someone with equal or higher Fluxer role position.').toJSON()] });
    }
    const canAct = await botCanActOnLive(client, guildId, targetId);
    if (!canAct) return message.reply({ embeds: [Embed.danger('My role is not above that member in the Fluxer hierarchy.').toJSON()] });
  }

  if (await banNeedsApproval(client.rest, guildId, executorId, executorIsOwner)) {
    const targetUser = await resolveUser(client, targetId);
    const cfg = getBanConfig(guildId);
    const id  = createApprovalRequest({ guildId, targetId, targetTag: userTag(targetUser), executorId, executorTag: message.author.username, reason, deleteDays });
    await postApprovalEmbed(client, guildId, id, cfg, userTag(targetUser), message.author.username, reason, targetId);
    return message.reply({ embeds: [Embed.warning('\u23F3  Ban Queued for Approval').setDescription(`Ban of **${userTag(targetUser)}** is waiting for approval ${approvalWhere(guildId)}.\nApproval ID: **#${id}**`).toJSON()] });
  }

  try {
    await executeBan(client, guildId, targetId, executorId, reason, deleteDays);
  } catch (err) {
    if (isPermissionError(err)) await notifyOwnerPermError(client, guildId, 'ban', `Could not ban <@${targetId}>: ${err.message}`);
    return message.reply({ embeds: [Embed.danger('Ban failed. Check permissions and role position.').toJSON()] });
  }

  const { count, limit, exceeded } = recordBan(guildId, executorId);
  const limitNote = limit > 0 ? ` (${count}/${limit} in window)` : '';
  await message.reply({ embeds: [Embed.success('\u{1F528}  Member Banned').addFields({ name: 'User', value: `<@${targetId}>`, inline: true }, { name: 'By', value: `<@${executorId}>`, inline: true }, { name: 'Reason', value: reason, inline: false }).setFooter({ text: `Bans this window${limitNote}` }).toJSON()] });

  if (exceeded) {
    const l = getLockout(guildId, executorId);
    await message.reply({ embeds: [Embed.danger('\u{1F512}  You Have Been Locked Out').setDescription(`Exceeded ban limit. Locked out until <t:${l.expires_at}:R>.`).toJSON()] });
  }
}

async function softBan(client, message, args, guildId, executorId) {
  // Own override key, not 'ban': that key is what the top-level !ban
  // dispatch itself is gated on, sharing it meant a guild loosening plain
  // !ban silently loosened every subcommand below identically.
  if (!await resolveAccess(client, guildId, executorId, 'softban', Permissions.KICK_MEMBERS)) {
    return message.reply({ embeds: [Embed.denied('Kick Members or higher required.').toJSON()] });
  }
  const executorIsOwner = isBotOwner(executorId) || await isRealOwner(guildId, executorId);
  const targetId = parseId(args[0]);
  const reason   = args.slice(1).join(' ') || 'Softban: message purge';
  if (!targetId) return message.reply({ embeds: [Embed.warning('Provide a user to softban.').toJSON()] });

  // See standardBan's identical guard above: hierarchy only applies when
  // the target is actually a member.
  const targetIsMember = await client.rest.get(`/guilds/${guildId}/members/${targetId}`).catch(() => null);
  if (targetIsMember) {
    if (!executorIsOwner && !(await canActOnLive(client, guildId, executorId, targetId))) return message.reply({ embeds: [Embed.denied('Cannot softban equal/higher Fluxer role position.').toJSON()] });
    const canAct = await botCanActOnLive(client, guildId, targetId);
    if (!canAct) return message.reply({ embeds: [Embed.danger('My role is not above that member.').toJSON()] });
  }
  try {
    const result = await banOrQueue(client, message, guildId, executorId, targetId, reason, 'soft');
    if (result.queued) {
      return message.reply({ embeds: [Embed.warning('⏳  Softban Queued for Approval').setDescription(`Softban of <@${targetId}> pending approval in <#${result.cfg.approval_channel}>.\nApproval ID: **#${result.id}**`).toJSON()] });
    }
    await message.reply({ embeds: [Embed.success('\u{1F9F9}  Softban Applied').addFields({ name: 'User', value: `<@${targetId}>`, inline: true }, { name: 'Reason', value: reason, inline: false }).toJSON()] });
  } catch (err) {
    if (isPermissionError(err)) await notifyOwnerPermError(client, guildId, 'softban', `Could not softban <@${targetId}>: ${err.message}`);
    await message.reply({ embeds: [Embed.danger('Softban failed.').toJSON()] });
  }
}

async function hardBan(client, message, args, guildId, executorId) {
  // Kept as its own permission key so servers can still set it separately.
  if (!await resolveAccess(client, guildId, executorId, 'hardban', Permissions.KICK_MEMBERS)) {
    return message.reply({ embeds: [Embed.denied('Kick Members or higher required.').toJSON()] });
  }
  return standardBan(client, message, args, guildId, executorId, { deleteDays: 0 });
}

async function massBan(client, message, args, guildId, executorId) {
  if (!await resolveAccess(client, guildId, executorId, 'massban', 'SERVER_OWNER')) {
    return message.reply({ embeds: [Embed.denied('Server Owner only.').toJSON()] });
  }
  const ids = [], reasonParts = [];
  for (const arg of args) { if (/^\d{17,20}$/.test(arg)) ids.push(arg); else reasonParts.push(arg); }
  const reason = reasonParts.join(' ') || 'Mass ban';
  if (!ids.length) return message.reply({ embeds: [Embed.warning('Provide at least one user ID.').toJSON()] });

  const executorIsOwner = isBotOwner(executorId) || await isRealOwner(guildId, executorId);
  if (needsApproval(guildId, executorId, executorIsOwner)) {
    // No bulk-approval flow exists (ban_approvals is one row per target),
    // so this queues one approval per target instead of executing
    // immediately. Closes the same require_approval bypass fixed for
    // soft/hard ban above, at the cost of N approval embeds for N targets.
    const cfg = getBanConfig(guildId);
    const queuedIds = [];
    for (const targetId of ids) {
      const targetUser = await resolveUser(client, targetId);
      const approvalId = createApprovalRequest({ guildId, targetId, targetTag: userTag(targetUser), executorId, executorTag: message.author.username, reason, actionType: 'mass' });
      await postApprovalEmbed(client, guildId, approvalId, cfg, userTag(targetUser), message.author.username, reason, targetId);
      queuedIds.push(approvalId);
    }
    return message.reply({ embeds: [Embed.warning('⏳  Mass Ban Queued for Approval').setDescription(`${ids.length} ban(s) pending approval in <#${cfg.approval_channel}>.\nApproval IDs: **${queuedIds.map(i => `#${i}`).join(', ')}**`).toJSON()] });
  }

  const status = await message.reply({ embeds: [Embed.info(`Banning ${ids.length} user(s)…`).toJSON()] });
  const guildName = client.guilds?.cache?.get(guildId)?.name ?? guildId;
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      await client.rest.put(`/guilds/${guildId}/bans/${id}`, { body: { delete_message_seconds: 86400 } });
      clearPendingTempbans(guildId, id);
      ok++;
      syncBanAcrossGroup(client, guildId, id, reason, guildName).catch(() => {});
    }
    catch { fail++; }
  }
  await logAction({ client, guildId, action: 'Mass Ban', targetId: ids[0], executorId, reason, extra: `${ok} banned, ${fail} failed` }).catch(() => {});
  await status.edit({ embeds: [Embed.success('\u{1F528}  Mass Ban Complete').addFields({ name: '\u2705 Banned', value: `${ok}`, inline: true }, { name: '\u274C Failed', value: `${fail}`, inline: true }, { name: 'Reason', value: reason, inline: false }).toJSON()] });
}

async function banConfig(client, message, args, guildId, executorId) {
  if (!await resolveAccess(client, guildId, executorId, 'banconfig', Permissions.BAN_MEMBERS)) {
    return message.reply({ embeds: [Embed.denied('Ban Members or higher required.').toJSON()] });
  }
  const cfg = getBanConfig(guildId);
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === 'status') {
    return message.reply({ embeds: [new EmbedBuilder().setColor(COLORS.INFO).setTitle('\u{1F528}  Ban Config').addFields(
      { name: 'Approval Required', value: cfg.require_approval ? '\u2705 Yes' : '\u274C No', inline: true },
      { name: 'Approval Channel',  value: cfg.approval_channel ? `<#${cfg.approval_channel}>` : 'Not set', inline: true },
      { name: 'Min Approver Permission', value: approvalPermLabel(BigInt(cfg.approval_min_permission ?? '4')), inline: true },
      { name: 'Ban Limit',         value: cfg.ban_limit > 0 ? `${cfg.ban_limit} per ${cfg.window_hours}h` : 'No limit', inline: true },
      { name: 'Lockout Duration',  value: `${cfg.lockout_duration_h}h`, inline: true },
      { name: 'Log Channel',       value: cfg.log_channel ? `<#${cfg.log_channel}>` : 'None', inline: true },
    ).toJSON()] });
  }
  if (sub === 'approval') {
    const val = args[1]?.toLowerCase();
    if (val !== 'on' && val !== 'off') return message.reply({ embeds: [Embed.warning('Usage: `ban config approval on|off`').toJSON()] });
    setBanConfigField(guildId, 'require_approval', val === 'on' ? 1 : 0);
    return message.reply({ embeds: [Embed.success(`Ban approval ${val === 'on' ? 'enabled' : 'disabled'}.`).toJSON()] });
  }
  if (sub === 'channel') {
    if (args[1]?.toLowerCase() === 'off') { setBanConfigField(guildId, 'approval_channel', null); return message.reply({ embeds: [Embed.success('Approval channel cleared.').toJSON()] }); }
    const chId = args[1]?.replace(/\D/g, '');
    if (!chId) return message.reply({ embeds: [Embed.warning('Usage: `ban config channel #channel|off`').toJSON()] });
    setBanConfigField(guildId, 'approval_channel', chId);
    return message.reply({ embeds: [Embed.success(`Approval channel set to <#${chId}>.`).toJSON()] });
  }
  if (sub === 'limit') {
    const n = parseInt(args[1], 10);
    if (isNaN(n) || n < 0) return message.reply({ embeds: [Embed.warning('Usage: `ban config limit <n> [hours]`').toJSON()] });
    setBanConfigField(guildId, 'ban_limit', n);
    const hours = parseInt(args[2], 10);
    if (!isNaN(hours) && hours > 0) setBanConfigField(guildId, 'window_hours', hours);
    return message.reply({ embeds: [Embed.success(`Ban limit: ${n === 0 ? 'unlimited' : `${n} per ${hours || cfg.window_hours}h`}.`).toJSON()] });
  }
  if (sub === 'lockout') {
    const h = parseInt(args[1], 10);
    if (isNaN(h) || h < 1) return message.reply({ embeds: [Embed.warning('Usage: `ban config lockout <hours>`').toJSON()] });
    setBanConfigField(guildId, 'lockout_duration_h', h);
    return message.reply({ embeds: [Embed.success(`Lockout duration: ${h}h.`).toJSON()] });
  }
  if (sub === 'minperm') {
    const name = args[1]?.toLowerCase();
    const map  = { kick: Permissions.KICK_MEMBERS, ban: Permissions.BAN_MEMBERS, manage: Permissions.MANAGE_GUILD, admin: Permissions.ADMINISTRATOR };
    const flag = map[name];
    if (!flag) return message.reply({ embeds: [Embed.warning('Usage: `ban config minperm <kick|ban|manage|admin>`').toJSON()] });
    setBanConfigField(guildId, 'approval_min_permission', String(flag));
    return message.reply({ embeds: [Embed.success(`Min approver permission: ${approvalPermLabel(flag)}.`).toJSON()] });
  }
  if (sub === 'log') {
    if (args[1]?.toLowerCase() === 'off') { setBanConfigField(guildId, 'log_channel', null); return message.reply({ embeds: [Embed.success('Log channel cleared.').toJSON()] }); }
    const chId = args[1]?.replace(/\D/g, '');
    if (!chId) return message.reply({ embeds: [Embed.warning('Usage: `ban config log #channel|off`').toJSON()] });
    setBanConfigField(guildId, 'log_channel', chId);
    return message.reply({ embeds: [Embed.success(`Log channel: <#${chId}>.`).toJSON()] });
  }
  await message.reply({ embeds: [Embed.info('Subcommands: `approval`, `channel`, `limit`, `lockout`, `minperm`, `log`').toJSON()] });
}

async function banOverride(client, message, args, guildId, executorId) {
  if (!await resolveAccess(client, guildId, executorId, 'banoverride', Permissions.BAN_MEMBERS)) {
    return message.reply({ embeds: [Embed.denied('Ban Members or higher required.').toJSON()] });
  }
  const targetId = parseId(args[0]);
  if (!targetId) {
    const overrides = listBanOverrides(guildId);
    if (!overrides.length) return message.reply({ embeds: [Embed.info('No ban overrides set.').toJSON()] });
    const lines = overrides.map(o => `<@${o.user_id}>, set by <@${o.set_by}> <t:${o.set_at}:R>`);
    return message.reply({ embeds: [Embed.info('Ban Overrides').setDescription(lines.join('\n')).toJSON()] });
  }
  const action = args[1]?.toLowerCase() ?? 'add';
  if (action === 'remove') { clearBanOverride(guildId, targetId); return message.reply({ embeds: [Embed.success(`Override removed for <@${targetId}>.`).toJSON()] }); }
  setBanOverride(guildId, targetId, executorId);
  return message.reply({ embeds: [Embed.success(`Override granted to <@${targetId}>.`).toJSON()] });
}

async function banUnlock(client, message, args, guildId, executorId) {
  if (!await resolveAccess(client, guildId, executorId, 'banunlock', Permissions.BAN_MEMBERS)) {
    return message.reply({ embeds: [Embed.denied('Ban Members or higher required.').toJSON()] });
  }
  const targetId = parseId(args[0]);
  if (!targetId) {
    const lockouts = listLockouts(guildId);
    if (!lockouts.length) return message.reply({ embeds: [Embed.info('No active lockouts.').toJSON()] });
    const lines = lockouts.map(l => `<@${l.user_id}>, ${l.reason}, expires <t:${l.expires_at}:R>`);
    return message.reply({ embeds: [Embed.warning('Active Ban Lockouts').setDescription(lines.join('\n')).toJSON()] });
  }
  const l = getLockout(guildId, targetId);
  if (!l) return message.reply({ embeds: [Embed.info(`<@${targetId}> is not locked out.`).toJSON()] });
  clearLockout(guildId, targetId);
  return message.reply({ embeds: [Embed.success(`Lockout cleared for <@${targetId}>.`).toJSON()] });
}

async function banPending(client, message, args, guildId, executorId) {
  if (!await resolveAccess(client, guildId, executorId, 'banpending', Permissions.KICK_MEMBERS)) {
    return message.reply({ embeds: [Embed.denied('Kick Members or higher required.').toJSON()] });
  }
  const pending = listPendingApprovals(guildId);
  if (!pending.length) return message.reply({ embeds: [Embed.info('No pending ban approvals.').toJSON()] });
  const lines = pending.map(p => `**#${p.id}**: ${p.target_tag} (\`${p.target_id}\`) by ${p.executor_tag}: *${p.reason.slice(0, 60)}*`);
  return message.reply({ embeds: [Embed.warning(`Pending Approvals (${pending.length})`).setDescription(lines.join('\n')).setFooter({ text: 'React on approval embed, or use !ban approve/deny <id>' }).toJSON()] });
}

async function approveOrDeny(client, message, args, guildId, executorId, action) {
  const cfg          = getBanConfig(guildId);
  const requiredFlag = BigInt(cfg.approval_min_permission ?? '4');
  const isOwner      = isBotOwner(executorId) || await isRealOwner(guildId, executorId);
  const bits         = isOwner ? 0n : await getMemberPermissionBitsLive(client, guildId, executorId);
  const hasPerm      = isOwner || (bits & Permissions.ADMINISTRATOR) !== 0n || (bits & requiredFlag) !== 0n;
  if (!hasPerm) {
    return message.reply({ embeds: [Embed.denied(`${approvalPermLabel(requiredFlag)} required.`).toJSON()] });
  }
  const id = parseInt(args[0], 10);
  if (isNaN(id)) return message.reply({ embeds: [Embed.warning(`Usage: \`!ban ${action} <approval-id>\``).toJSON()] });
  const approval = getApproval(id);
  if (!approval || approval.guild_id !== guildId) return message.reply({ embeds: [Embed.danger(`Approval #${id} not found.`).toJSON()] });
  if (approval.status !== 'pending') return message.reply({ embeds: [Embed.warning(`Approval #${id} is already **${approval.status}**.`).toJSON()] });
  if (approval.executor_id === executorId) return message.reply({ embeds: [Embed.danger('You cannot approve your own ban request.').toJSON()] });
  resolveApproval(id, action === 'approve' ? 'approved' : 'denied', executorId);
  if (action === 'approve') {
    const actionType = approval.action_type ?? 'ban';
    try {
      await executeBanAction(client, guildId, approval.target_id, executorId, `Approved (req by ${approval.executor_tag}): ${approval.reason}`, actionType, approval.duration_s, approval.delete_days);
      // Matches pre-existing behavior: only plain !ban ever fed the rolling
      // ban-limit counter, soft/hard/mass never did even before they had
      // an approval gate at all.
      if (actionType === 'ban' || actionType === 'temp') recordBan(guildId, approval.executor_id);
      return message.reply({ embeds: [Embed.success(`\u2705  Approval #${id} approved. **${approval.target_tag}** banned.`).toJSON()] });
    } catch { return message.reply({ embeds: [Embed.danger('Approval recorded but ban call failed.').toJSON()] }); }
  }
  return message.reply({ embeds: [Embed.warning(`\u274C  Approval #${id} denied. **${approval.target_tag}** was NOT banned.`).toJSON()] });
}

export default {
  name: 'ban',
  aliases: ['b'],
  description: 'Ban a member. Subcommands: soft, hard, mass, config, override, unlock, pending, approve, deny.',
  usage: '{prefix}ban <@user|id|sub> [args]',
  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const guildId    = message.guildId;
    const executorId = message.author.id;
    const sub        = args[0]?.toLowerCase();
    if (sub === 'soft')     return softBan      (client, message, args.slice(1), guildId, executorId);
    if (sub === 'hard')     return hardBan      (client, message, args.slice(1), guildId, executorId);
    if (sub === 'mass')     return massBan      (client, message, args.slice(1), guildId, executorId);
    if (sub === 'config')   return banConfig    (client, message, args.slice(1), guildId, executorId);
    if (sub === 'override') return banOverride  (client, message, args.slice(1), guildId, executorId);
    if (sub === 'unlock')   return banUnlock    (client, message, args.slice(1), guildId, executorId);
    if (sub === 'pending')  return banPending   (client, message, args.slice(1), guildId, executorId);
    if (sub === 'approve')  return approveOrDeny(client, message, args.slice(1), guildId, executorId, 'approve');
    if (sub === 'deny')     return approveOrDeny(client, message, args.slice(1), guildId, executorId, 'deny');
    return standardBan(client, message, args, guildId, executorId);
  },
};
