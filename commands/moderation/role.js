// ============================================================
//  commands/moderation/role.js
//
//  Staff role management, add or remove roles from members.
//  Respects Bloo's role hierarchy.
//
//  !role add @user @role [reason]
//  !role remove @user @role [reason]
//  !role info @role           , show role details
//  !role mass add|remove @role <user ids…> [reason]
//  !role mass add|remove @role all [reason]   , every member missing/holding
//                                                the role, paginated fetch,
//                                                same shape as
//                                                !antiraid bulkverify all
//  !role mass add|remove @role role @R1 @R2 [reason]
//                                              , same, but only members who
//                                                hold at least one of @R1/@R2
//
//  Gate: Mod (2)+ by default, configurable per guild
//  !role mass is Server Owner only regardless of that gate (see massRoleChange)
// ============================================================

import { EmbedBuilder }                      from '@fluxerjs/core';
import { Embed, COLORS }                     from '../../config/embeds.js';
import { isBotOwner, isRealOwner } from '../../handlers/staffSystem.js';
import { botCanActOnLive, botCanAssignRoleLive, canActOnLive, memberCanAssignRoleLive } from '../../config/guildPermissions.js';
import { Permissions } from '../../config/guildPermissions.js';
import { resolveAccess } from '../../handlers/commandPermissions.js';
import { logAction } from '../../handlers/modLog.js';
import { createOperation, recordGrant, updateProgress, completeOperation, hasRunningOperation } from '../../handlers/massRoleOps.js';

function parseUserId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}
function parseRoleId(arg) {
  if (!arg) return null;
  return arg.match(/^<@&(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

const MASS_MAX_IDS  = 200;
const MASS_DELAY_MS = 300;

// !role mass add|remove @role <user ids…> [reason]
// Server Owner only, same restriction as !ban mass and the dashboard's own
// Mass Assign Roles page (dashboard/routes/massRoles.js), a bulk role
// change is just as consequential as a bulk ban.
async function massRoleChange({ client, message, args, guildId, executorId }) {
  if (!await resolveAccess(client, guildId, executorId, 'massrole', 'SERVER_OWNER')) {
    return message.reply({ embeds: [Embed.denied('Server Owner only.').toJSON()] }).catch(() => {});
  }

  const [actionArg, roleArg, ...rest] = args;
  const action = actionArg?.toLowerCase();
  if (action !== 'add' && action !== 'remove') {
    return message.reply({ embeds: [Embed.warning('Usage').setDescription(`\`${process.env.PREFIX ?? 'b!'}role mass add|remove @role <user ids…|all> [reason]\``).toJSON()] }).catch(() => {});
  }

  const roleId = parseRoleId(roleArg);
  if (!roleId) {
    return message.reply({ embeds: [Embed.warning('Missing Role').setDescription('Provide the role to mass-assign as the first argument after add/remove.').toJSON()] }).catch(() => {});
  }

  if (rest[0]?.toLowerCase() === 'all') {
    return massRoleChangeAll({ client, message, guildId, executorId, action, roleId, filterRoleIds: [], reasonParts: rest.slice(1) });
  }

  if (rest[0]?.toLowerCase() === 'role') {
    const filterRoleIds = [];
    let cursor = 1;
    while (cursor < rest.length) {
      const fid = parseRoleId(rest[cursor]);
      if (!fid) break;
      filterRoleIds.push(fid);
      cursor++;
    }
    if (!filterRoleIds.length) {
      return message.reply({ embeds: [Embed.warning('No Roles Specified').setDescription(`Mention at least one role to filter by.\n\nExample: \`${process.env.PREFIX ?? 'b!'}role mass ${action} @Role role @Member @Verified\``).toJSON()] }).catch(() => {});
    }
    return massRoleChangeAll({ client, message, guildId, executorId, action, roleId, filterRoleIds, reasonParts: rest.slice(cursor) });
  }

  const ids = [], reasonParts = [];
  for (const arg of rest) {
    const uid = arg.match(/^<@!?(\d+)>$/)?.[1] ?? (/^\d{17,20}$/.test(arg) ? arg : null);
    if (uid) ids.push(uid); else reasonParts.push(arg);
  }
  const reason = reasonParts.join(' ').trim() || `Mass role ${action}`;

  if (!ids.length) {
    return message.reply({ embeds: [Embed.warning('Provide at least one user ID or mention.').toJSON()] }).catch(() => {});
  }
  if (ids.length > MASS_MAX_IDS) {
    return message.reply({ embeds: [Embed.warning(`Maximum ${MASS_MAX_IDS} users per run, provided ${ids.length}.`).toJSON()] }).catch(() => {});
  }

  const roles = await client.rest.get(`/guilds/${guildId}/roles`).catch(() => []);
  const role  = Array.isArray(roles) ? roles.find(r => r.id === roleId) : null;
  if (!role) {
    return message.reply({ embeds: [Embed.danger('Not Found').setDescription('That role does not exist in this server.').toJSON()] }).catch(() => {});
  }

  const botMember = client.user?.id ? await client.rest.get(`/guilds/${guildId}/members/${client.user.id}`).catch(() => null) : null;
  if (botMember && !await botCanAssignRoleLive(client, botMember, guildId, roleId)) {
    return message.reply({ embeds: [Embed.warning('Hierarchy Error').setDescription(`I cannot assign/remove <@&${roleId}> because that role is at or above my highest role in the hierarchy.`).toJSON()] }).catch(() => {});
  }

  const status = await message.reply({ embeds: [Embed.info(`${action === 'add' ? 'Adding' : 'Removing'} <@&${roleId}> for ${ids.length} user(s)…`).toJSON()] }).catch(() => {});
  let ok = 0, fail = 0;
  for (const userId of ids) {
    try {
      if (action === 'add') await client.rest.put(`/guilds/${guildId}/members/${userId}/roles/${roleId}`);
      else await client.rest.delete(`/guilds/${guildId}/members/${userId}/roles/${roleId}`);
      ok++;
    } catch { fail++; }
    await new Promise(resolve => setTimeout(resolve, MASS_DELAY_MS));
  }

  await logAction({
    client, guildId, action: 'Mass Role ' + (action === 'add' ? 'Add' : 'Remove'),
    targetId: ids[0], executorId, reason, extra: `${ok} ${action === 'add' ? 'granted' : 'removed'}, ${fail} failed, role: ${role.name}`,
  }).catch(() => {});

  const resultEmbed = Embed.success(`🪄  Mass Role ${action === 'add' ? 'Add' : 'Remove'} Complete`)
    .addFields(
      { name: '🎭 Role',                                        value: `<@&${roleId}>`, inline: true },
      { name: action === 'add' ? '✅ Granted' : '✅ Removed',    value: `${ok}`,          inline: true },
      { name: '❌ Failed',                                       value: `${fail}`,       inline: true },
      { name: '📋 Reason',                                       value: reason,          inline: false },
    );
  if (status) await status.edit({ embeds: [resultEmbed.toJSON()] }).catch(() => message.reply({ embeds: [resultEmbed.toJSON()] }).catch(() => {}));
  else await message.reply({ embeds: [resultEmbed.toJSON()] }).catch(() => {});
}

// !role mass add|remove @role all [reason]
// Every current member missing (add) or holding (remove) the role, not a
// pasted list. Same paginated-fetch + live-progress-embed shape as
// !antiraid bulkverify all (commands/moderation/antiraid/bulkverify.js),
// which already solves "iterate a server's full member list without a
// Server Members Intent, without blowing past any request-scoped timeout,
// since this runs inside the bot's own event loop, not behind an HTTP
// request." Every grant/removal is recorded per-user via handlers/
// massRoleOps.js, the same log the dashboard's "All members" mode writes
// to, so either surface's runs show up in one shared history regardless of
// who issued it or from where.
async function massRoleChangeAll({ client, message, guildId, executorId, action, roleId, filterRoleIds, reasonParts }) {
  const reason = reasonParts.join(' ').trim() || `Mass role ${action} (all members)`;

  if (hasRunningOperation(guildId)) {
    return message.reply({ embeds: [Embed.warning('Already Running').setDescription('A mass role operation is already in progress for this server. Wait for it to finish before starting another.').toJSON()] }).catch(() => {});
  }

  const roles = await client.rest.get(`/guilds/${guildId}/roles`).catch(() => []);
  const role  = Array.isArray(roles) ? roles.find(r => r.id === roleId) : null;
  if (!role) {
    return message.reply({ embeds: [Embed.danger('Not Found').setDescription('That role does not exist in this server.').toJSON()] }).catch(() => {});
  }

  const botMember = client.user?.id ? await client.rest.get(`/guilds/${guildId}/members/${client.user.id}`).catch(() => null) : null;
  if (botMember && !await botCanAssignRoleLive(client, botMember, guildId, roleId)) {
    return message.reply({ embeds: [Embed.warning('Hierarchy Error').setDescription(`I cannot assign/remove <@&${roleId}> because that role is at or above my highest role in the hierarchy.`).toJSON()] }).catch(() => {});
  }

  const hasFilter = filterRoleIds?.length > 0;
  const status = await message.reply({
    embeds: [Embed.info(`⏳  Mass ${action === 'add' ? 'Add' : 'Remove'} Starting…`)
      .setDescription(
        `Fetching every member ${action === 'add' ? 'missing' : 'holding'} <@&${roleId}>` +
        (hasFilter ? `, among those holding ${filterRoleIds.map(id => `<@&${id}>`).join(', ')}` : '') +
        `. This may take a while on large servers.`
      )
      .setFooter({ text: 'Progress will update every 25 members.' })
      .toJSON()],
  }).catch(() => null);

  // Paginated REST fetch, works without Server Members Intent, same
  // approach as bulkverify.js.
  const candidates = [];
  try {
    let after = '0';
    while (true) {
      const batch = await client.rest.get(`/guilds/${guildId}/members?limit=1000&after=${after}`).catch(() => null);
      if (!Array.isArray(batch) || !batch.length) break;

      for (const m of batch) {
        const userId = m.user?.id ?? m.id;
        if (!userId || m.user?.bot) continue;
        const memberRoles = m.roles ?? [];
        const hasRole = memberRoles.includes(roleId);
        if (action === 'add' && hasRole) continue;
        if (action === 'remove' && !hasRole) continue;
        if (hasFilter && !filterRoleIds.some(fid => memberRoles.includes(fid))) continue;
        candidates.push(userId);
      }

      if (batch.length < 1000) break;
      after = batch[batch.length - 1].user?.id ?? batch[batch.length - 1].id;
    }
  } catch (err) {
    const embed = Embed.danger('Error').setDescription(`Could not fetch member list: ${err.message}`).toJSON();
    if (status) await status.edit({ embeds: [embed] }).catch(() => {});
    return;
  }

  if (!candidates.length) {
    const embed = Embed.success('✅  Nothing to Do').setDescription(`No eligible members found${hasFilter ? ' matching that role filter' : ''}.`).toJSON();
    if (status) await status.edit({ embeds: [embed] }).catch(() => {});
    return;
  }

  const operationId = createOperation({
    guildId, roleId, roleName: role.name, action, mode: hasFilter ? 'filtered' : 'all', filterRoleIds,
    issuedBy: executorId, issuedVia: 'command', reason, total: candidates.length,
  });

  const UPDATE_EVERY = 25;
  let ok = 0, fail = 0;
  const progressEmbed = () => Embed.info(`⏳  Mass ${action === 'add' ? 'Add' : 'Remove'} In Progress`)
    .setDescription(`Processing **${candidates.length}** member(s)…\n\n✅ ${action === 'add' ? 'Granted' : 'Removed'}: **${ok}**\n❌ Failed: **${fail}**\n⏳ Remaining: **${candidates.length - ok - fail}**`)
    .setFooter({ text: 'Do not run other bulk role operations until this completes.' })
    .toJSON();

  for (let i = 0; i < candidates.length; i++) {
    const userId = candidates[i];
    let succeeded = true, errMsg = null;
    try {
      if (action === 'add') await client.rest.put(`/guilds/${guildId}/members/${userId}/roles/${roleId}`);
      else await client.rest.delete(`/guilds/${guildId}/members/${userId}/roles/${roleId}`);
      ok++;
    } catch (err) {
      succeeded = false; errMsg = err.message; fail++;
    }
    recordGrant(operationId, userId, succeeded, errMsg);

    if ((i + 1) % UPDATE_EVERY === 0 || i === candidates.length - 1) {
      updateProgress(operationId, ok, fail);
      if (status) await status.edit({ embeds: [progressEmbed()] }).catch(() => {});
    }
  }

  completeOperation(operationId, { succeeded: ok, failed: fail });

  await logAction({
    client, guildId, action: 'Mass Role ' + (action === 'add' ? 'Add' : 'Remove') + ' (All)',
    // modlog_cases.target_id is NOT NULL and there's no single member here,
    // so the role acted on stands in as the case target.
    targetId: roleId, executorId, reason, extra: `${ok} ${action === 'add' ? 'granted' : 'removed'}, ${fail} failed, role: ${role.name}, ${candidates.length} total`,
  }).catch(() => {});

  const resultEmbed = Embed.success(`🪄  Mass Role ${action === 'add' ? 'Add' : 'Remove'} Complete`)
    .addFields(
      { name: '🎭 Role',                                     value: `<@&${roleId}>`, inline: true },
      { name: action === 'add' ? '✅ Granted' : '✅ Removed', value: `${ok}`,          inline: true },
      { name: '❌ Failed',                                    value: `${fail}`,       inline: true },
      { name: '📋 Reason',                                    value: reason,          inline: false },
    ).toJSON();
  if (status) await status.edit({ embeds: [resultEmbed] }).catch(() => message.reply({ embeds: [resultEmbed] }).catch(() => {}));
  else await message.reply({ embeds: [resultEmbed] }).catch(() => {});
}

export default {
  name: 'role',
  aliases: ['giverole', 'takerole', 'addrole', 'removerole'],
  description: 'Add or remove a role from a member, or mass-assign one across many members at once.',
  usage: '{prefix}role <add|remove> @user @role [reason]\n{prefix}role info @role\n{prefix}role mass <add|remove> @role <user ids…> [reason]\n{prefix}role mass <add|remove> @role all [reason]\n{prefix}role mass <add|remove> @role role <@role…> [reason]',
  category: 'moderation',

  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX     = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId    = message.guildId;
    const authorId   = message.author.id;

    const [sub, userArg, roleArg, ...reasonParts] = args;
    const subLower = sub?.toLowerCase();

    // ── !role info @role ─────────────────────────────────────────
    if (subLower === 'info') {
      const roleId = parseRoleId(userArg);
      if (!roleId) {
        await message.reply({ embeds: [Embed.warning('Missing Role').setDescription(`Usage: \`${PREFIX}role info @role\``).toJSON()] }).catch(() => {});
        return;
      }
      const roles = await client.rest.get(`/guilds/${guildId}/roles`).catch(() => []);
      const role  = Array.isArray(roles) ? roles.find(r => r.id === roleId) : null;
      if (!role) {
        await message.reply({ embeds: [Embed.danger('Not Found').setDescription('That role does not exist in this server.').toJSON()] }).catch(() => {});
        return;
      }
      const color  = role.color ? `#${role.color.toString(16).padStart(6, '0')}` : 'No colour';
      const embed  = new EmbedBuilder()
        .setTitle(`🎭 Role: ${role.name}`)
        .setColor(role.color || 0x5865F2)
        .addFields(
          { name: 'ID',          value: `\`${role.id}\``,                               inline: true },
          { name: 'Colour',      value: color,                                           inline: true },
          { name: 'Position',    value: `${role.position}`,                             inline: true },
          { name: 'Hoisted',     value: role.hoist     ? '✅ Yes' : '❌ No',            inline: true },
          { name: 'Mentionable', value: role.mentionable ? '✅ Yes' : '❌ No',          inline: true },
          { name: 'Managed',     value: role.managed   ? '✅ Yes (bot/integration)' : '❌ No', inline: true },
        )
        .setFooter({ text: `Created via Snowflake: ${role.id}` });
      await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
      return;
    }

    // ── !role mass add|remove @role <user ids…> [reason] ───────────
    if (subLower === 'mass') {
      return massRoleChange({ client, message, args: args.slice(1), guildId, executorId: authorId, prefix: PREFIX });
    }

    // ── !role add / !role remove ─────────────────────────────────
    if (subLower !== 'add' && subLower !== 'remove') {
      await message.reply({ embeds: [
        Embed.info('🎭 Role: Usage')
          .addFields(
            { name: `\`${PREFIX}role add @user @role [reason]\``,    value: 'Give a member a role',   inline: false },
            { name: `\`${PREFIX}role remove @user @role [reason]\``, value: 'Remove a role from a member', inline: false },
            { name: `\`${PREFIX}role info @role\``,                  value: 'Show role details',      inline: false },
            { name: `\`${PREFIX}role mass add|remove @role <user ids…> [reason]\``, value: 'Add or remove a role from a specific list of members, Server Owner only', inline: false },
            { name: `\`${PREFIX}role mass add|remove @role all [reason]\``, value: 'Add or remove a role from every current member missing/holding it, Server Owner only', inline: false },
            { name: `\`${PREFIX}role mass add|remove @role role @R1 @R2… [reason]\``, value: 'Same, but only for members holding at least one of the listed roles, Server Owner only', inline: false },
          )
          .toJSON()
      ] }).catch(() => {});
      return;
    }

    const userId = parseUserId(userArg);
    const roleId = parseRoleId(roleArg);
    const reason = reasonParts.join(' ').trim() || 'No reason provided';

    if (!userId || !roleId) {
      await message.reply({ embeds: [Embed.warning('Missing Arguments').setDescription(`Usage: \`${PREFIX}role ${subLower} @user @role [reason]\``).toJSON()] }).catch(() => {});
      return;
    }

    const guild  = message.guild ?? await client.guilds.fetch(guildId).catch(() => null);
    const target = await client.rest.get(`/guilds/${guildId}/members/${userId}`).catch(() => null);
    if (!target) {
      await message.reply({ embeds: [Embed.danger('Not Found').setDescription('That member is not in this server.').toJSON()] }).catch(() => {});
      return;
    }

    const targetName = target.nick ?? target.user?.username ?? userId;

    // Hierarchy checks: executor must outrank both the target member and the
    // role itself, otherwise a mod could hand out roles above their own.
    const executorIsOwner = isBotOwner(authorId) || await isRealOwner(guildId, authorId);
    if (!executorIsOwner && !(await canActOnLive(client, guildId, authorId, userId))) {
      await message.reply({ embeds: [Embed.denied('Hierarchy Error').setDescription(`You cannot manage roles for **${targetName}** because your highest Fluxer role is not above theirs.`).toJSON()] }).catch(() => {});
      return;
    }
    if (!executorIsOwner && !(await memberCanAssignRoleLive(client, guildId, authorId, roleId))) {
      await message.reply({ embeds: [Embed.denied('Hierarchy Error').setDescription(`You cannot manage <@&${roleId}> because it is at or above your highest role.`).toJSON()] }).catch(() => {});
      return;
    }

    // Bot hierarchy check, Bloo must be able to manage the role
    const botMember = client.user?.id
      ? await client.rest.get(`/guilds/${guildId}/members/${client.user.id}`).catch(() => null)
      : null;
    if (botMember) {
      // For role assignment, Bloo needs to be above the ROLE being given/taken
      // (not above the target member's highest role, those are different things)
      const canAssign = await botCanAssignRoleLive(client, botMember, guildId, roleId);
      if (!canAssign) {
        await message.reply({ embeds: [Embed.warning('Hierarchy Error').setDescription(`I cannot assign/remove <@&${roleId}> because that role is at or above my highest role in the hierarchy.`).toJSON()] }).catch(() => {});
        return;
      }
    }

    if (subLower === 'add') {
      try {
        await client.rest.put(`/guilds/${guildId}/members/${userId}/roles/${roleId}`);
        await message.reply({ embeds: [
          Embed.success('✅ Role Added')
            .addFields(
              { name: '🎯 Member', value: `<@${userId}> (${targetName})`, inline: true },
              { name: '🎭 Role',   value: `<@&${roleId}>`,               inline: true },
              { name: '📋 Reason', value: reason,                        inline: false },
              { name: '👮 By',     value: message.author.username,        inline: true },
            )
            .toJSON()
        ] }).catch(() => {});
      } catch (err) {
        await message.reply({ embeds: [Embed.danger('Failed').setDescription(`Could not add role: ${err.message}`).toJSON()] }).catch(() => {});
      }
    } else {
      try {
        await client.rest.delete(`/guilds/${guildId}/members/${userId}/roles/${roleId}`);
        await message.reply({ embeds: [
          Embed.success('✅ Role Removed')
            .addFields(
              { name: '🎯 Member', value: `<@${userId}> (${targetName})`, inline: true },
              { name: '🎭 Role',   value: `<@&${roleId}>`,               inline: true },
              { name: '📋 Reason', value: reason,                        inline: false },
              { name: '👮 By',     value: message.author.username,        inline: true },
            )
            .toJSON()
        ] }).catch(() => {});
      } catch (err) {
        await message.reply({ embeds: [Embed.danger('Failed').setDescription(`Could not remove role: ${err.message}`).toJSON()] }).catch(() => {});
      }
    }
  },
};