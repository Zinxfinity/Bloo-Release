// ============================================================
//  commands/moderation/rolepersist.js
//  Category : Moderation  |  Requires Kick Members (default)
//
//  Two persistence modes:
//
//  USER mode, pin a specific user's roles. If they leave and
//  rejoin, their snapshot is re-applied.
//    !rolepersist add @user [reason]
//    !rolepersist remove @user
//    !rolepersist list
//    !rolepersist info @user
//
//  ROLE mode, server-wide rule. Anyone who held a tracked role
//  when they left gets it back when they rejoin automatically.
//    !rolepersist role add @role [reason]
//    !rolepersist role remove @role
//    !rolepersist role list
// ============================================================

import { EmbedBuilder }                       from '@fluxerjs/core';
import { COLORS, Embed }                      from '../../config/embeds.js';
import { isRealOwner, isBotOwner } from '../../handlers/staffSystem.js';
import { canActOnLive } from '../../config/guildPermissions.js';
import {
  setPersist, removePersist, getPersist, getAllPersisted,
  setRoleRule, removeRoleRule, getRoleRule, getAllRoleRules,
} from '../../handlers/rolePersist.js';
import { sendModLog } from '../../handlers/modLog.js';
import { Permissions } from '../../config/guildPermissions.js';
import { unixSeconds } from '../../utils/format.js';

function parseUserId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

function parseRoleId(arg) {
  if (!arg) return null;
  return arg.match(/^<@&(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

export default {
  name: 'rolepersist',
  aliases: ['persistrole', 'rp'],
  description: 'Persist roles across leave/rejoin. Pin a specific user\'s roles, or set a server rule so anyone with a given role (e.g. @Muted) always gets it back.',
  usage: '{prefix}rolepersist add @user [reason]\n{prefix}rolepersist remove @user\n{prefix}rolepersist list\n{prefix}rolepersist info @user\n{prefix}rolepersist role add @role [reason]\n{prefix}rolepersist role remove @role\n{prefix}rolepersist role list',
  category: 'moderation',

  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX        = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId       = message.guildId;
    const authorIsOwner = isBotOwner(message.author.id) || await isRealOwner(guildId, message.author.id);

    const [sub, ...rest] = args;

    // ── !rolepersist role <add|remove|list> ───────────────────
    if (sub?.toLowerCase() === 'role') {
      const [roleSub, ...roleRest] = rest;

      switch (roleSub?.toLowerCase()) {

        case 'add': {
          const roleId = parseRoleId(roleRest[0]);
          if (!roleId) {
            await message.reply({ embeds: [Embed.warning('Missing Role').setDescription(`Usage: \`${PREFIX}rolepersist role add <@role> [reason]\``).toJSON()] }).catch(() => {});
            return;
          }

          const reason = roleRest.slice(1).join(' ') || 'No reason provided';
          setRoleRule(guildId, roleId, reason, message.author.id);

          await sendModLog(client, guildId, {
            action: 'Role Rule Added', color: 'orange',
            target: `<@&${roleId}> (\`${roleId}\`)`, targetId: roleId,
            executorId: message.author.id,
            executor: message.author.username,
            reason,
          });

          await message.reply({
            embeds: [
              Embed.success('🔒  Role Persist Rule Added')
                .setDescription(
                  `Anyone who leaves with <@&${roleId}> will automatically get it back when they rejoin.\n\n` +
                  `-# This applies to future leaves. Members who already left won't be affected unless they had a snapshot.`
                )
                .addFields(
                  { name: '🎭 Role',    value: `<@&${roleId}>`, inline: true  },
                  { name: '📋 Reason',  value: reason,           inline: false },
                )
                .toJSON(),
            ],
          });
          break;
        }

        case 'remove': {
          const roleId = parseRoleId(roleRest[0]);
          if (!roleId) {
            await message.reply({ embeds: [Embed.warning('Missing Role').setDescription(`Usage: \`${PREFIX}rolepersist role remove <@role>\``).toJSON()] }).catch(() => {});
            return;
          }

          const rule = getRoleRule(guildId, roleId);
          if (!rule) {
            await message.reply({ embeds: [Embed.info('No Rule').setDescription(`<@&${roleId}> doesn't have a persist rule.`).toJSON()] }).catch(() => {});
            return;
          }

          removeRoleRule(guildId, roleId);

          await message.reply({
            embeds: [Embed.success('🔓  Role Rule Removed').setDescription(`<@&${roleId}> will no longer be auto-reapplied on rejoin.`).toJSON()],
          });
          break;
        }

        case 'list': {
          const rules = getAllRoleRules(guildId);
          if (!rules.length) {
            await message.reply({
              embeds: [
                Embed.info('No Role Rules')
                  .setDescription(
                    `No server-wide role persist rules set.\n\n` +
                    `Add one with \`${PREFIX}rolepersist role add @role\`, for example:\n` +
                    `\`${PREFIX}rolepersist role add @Muted\`: anyone who leaves while muted gets it back on rejoin.`
                  )
                  .toJSON(),
              ],
            });
            return;
          }

          const embed = new EmbedBuilder()
            .setTitle('🔒  Role Persist Rules')
            .setColor(COLORS.SUCCESS)
            // Listed in the description, not as field names: a field name
            // shows <@&id> as raw text instead of the role.
            // set_by/set_at, not added_by/added_at; older rows hold milliseconds.
            .setDescription([
              'Anyone who leaves with these roles will get them back when they rejoin.',
              '',
              ...rules.map(rule =>
                `<@&${rule.role_id}>\n-# Added by ${rule.set_by ? `<@${rule.set_by}>` : 'unknown'} <t:${unixSeconds(rule.set_at)}:R>${rule.reason ? `, ${rule.reason}` : ''}`),
            ].join('\n').slice(0, 4000))
            .setFooter({ text: `${rules.length} rule${rules.length === 1 ? '' : 's'}` });

          await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
          break;
        }

        default:
          await message.reply({
            embeds: [
              Embed.info('🎭  Role Persist: Role Rules')
                .setDescription('Set a server-wide rule so anyone who leaves with a given role gets it back on rejoin.')
                .addFields(
                  { name: `\`${PREFIX}rolepersist role add <@role> [reason]\``, value: 'Track a role, e.g. @Muted',        inline: false },
                  { name: `\`${PREFIX}rolepersist role remove <@role>\``,        value: 'Stop tracking a role',             inline: false },
                  { name: `\`${PREFIX}rolepersist role list\``,                  value: 'Show all active role rules',       inline: false },
                )
                .toJSON(),
            ],
          });
      }
      return;
    }

    // ── User persist subcommands ───────────────────────────────
    switch (sub?.toLowerCase()) {

      case 'add': {
        const targetId = parseUserId(rest[0]);
        if (!targetId) {
          await message.reply({ embeds: [Embed.warning('Missing User').setDescription(`Usage: \`${PREFIX}rolepersist add <@user> [reason]\``).toJSON()] }).catch(() => {});
          return;
        }

        const guild  = message.guild ?? await client.guilds.fetch(guildId).catch(() => null);
        const member = await client.rest.get(`/guilds/${guildId}/members/${targetId}`).catch(() => null);
        if (!member) {
          await message.reply({ embeds: [Embed.danger('Not Found').setDescription('That user is not in this server.').toJSON()] }).catch(() => {});
          return;
        }

        if (!authorIsOwner && !(await canActOnLive(client, guildId, message.author.id, targetId))) {
          await message.reply({ embeds: [Embed.danger('Cannot Modify').setDescription(`You can't persist roles for someone at or above your Fluxer role position.`).toJSON()] }).catch(() => {});
          return;
        }

        // Capture all current roles except @everyone
        // v1.3: member.roles is GuildMemberRoleManager, use .roleIds (readonly string[]).
        // v1.2.2: was a plain string[]. Support both shapes.
        const _mr = member.roles;
        const roleIds = [
          ...(Array.isArray(_mr?.roleIds)
            ? _mr.roleIds
            : _mr instanceof Map
              ? _mr.keys()
              : Array.isArray(_mr) ? _mr : [])
        ].map(r => r.id ?? r).filter(id => id !== guildId);

        if (!roleIds.length) {
          await message.reply({ embeds: [Embed.warning('No Roles').setDescription('This user has no roles to persist (excluding @everyone).').toJSON()] }).catch(() => {});
          return;
        }

        const reason = rest.slice(1).join(' ') || 'No reason provided';
        setPersist(guildId, targetId, roleIds, reason, message.author.id);

        const targetName = member.displayName ?? member.user?.username ?? targetId;

        await sendModLog(client, guildId, {
          action: 'Role Persist Enabled', color: 'orange',
          target: `${targetName} (\`${targetId}\`)`, targetId,
          executorId: message.author.id,
          executor: message.author.username,
          reason,
          fields: [{ name: 'Roles', value: roleIds.map(id => `<@&${id}>`).join(' ') || 'None' }],
        });

        await message.reply({
          embeds: [
            Embed.success('🔒  User Role Persist Enabled')
              .setDescription(`**${targetName}**'s current roles will be re-applied if they leave and rejoin.`)
              .addFields(
                { name: '🎯 User',              value: `<@${targetId}>`,                        inline: true  },
                { name: `🎭 Roles (${roleIds.length})`, value: roleIds.map(id => `<@&${id}>`).join(' ') || 'None', inline: false },
                { name: '📋 Reason',            value: reason,                                  inline: false },
              )
              .toJSON(),
          ],
        });
        break;
      }

      case 'remove': {
        const targetId = parseUserId(rest[0]);
        if (!targetId) {
          await message.reply({ embeds: [Embed.warning('Missing User').setDescription(`Usage: \`${PREFIX}rolepersist remove <@user>\``).toJSON()] }).catch(() => {});
          return;
        }

        const entry = getPersist(guildId, targetId);
        if (!entry) {
          await message.reply({ embeds: [Embed.info('Not Persisted').setDescription(`<@${targetId}> doesn't have a persisted role snapshot.`).toJSON()] }).catch(() => {});
          return;
        }

        removePersist(guildId, targetId);

        await sendModLog(client, guildId, {
          action: 'Role Persist Removed', color: 'green',
          target: `<@${targetId}> (\`${targetId}\`)`, targetId,
          executorId: message.author.id,
          executor: message.author.username,
          reason: 'User persist cleared',
        });

        await message.reply({
          embeds: [Embed.success('🔓  User Persist Removed').setDescription(`Persisted role snapshot cleared for <@${targetId}>.`).toJSON()],
        });
        break;
      }

      case 'list': {
        const rows  = getAllPersisted(guildId);
        const rules = getAllRoleRules(guildId);

        if (!rows.length && !rules.length) {
          await message.reply({
            embeds: [
              Embed.info('Nothing Persisted')
                .setDescription(
                  `No role persist is configured for this server.\n\n` +
                  `**User persist**: pin a specific user's roles:\n\`${PREFIX}rolepersist add @user\`\n\n` +
                  `**Role rules**: auto-reapply a role for anyone who leaves with it:\n\`${PREFIX}rolepersist role add @Muted\``
                )
                .toJSON(),
            ],
          });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle('🔒  Role Persist: Overview')
          .setColor(COLORS.SUCCESS);

        if (rules.length) {
          embed.addFields({
            name: `📋 Role Rules (${rules.length})`,
            value: rules.map(r => `<@&${r.role_id}>: ${r.reason}`).join('\n'),
            inline: false,
          });
        }

        if (rows.length) {
          embed.addFields({
            name: `👤 Pinned Users (${rows.length})`,
            value: rows.slice(0, 15).map(r =>
              `<@${r.user_id}>: ${r.roleIds.length} role(s), ${r.reason ?? 'no reason'}`
            ).join('\n') + (rows.length > 15 ? `\n-# …and ${rows.length - 15} more` : ''),
            inline: false,
          });
        }

        embed.setFooter({ text: `${rules.length} role rule(s) · ${rows.length} pinned user(s)` });
        await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
        break;
      }

      case 'info': {
        const targetId = parseUserId(rest[0]);
        if (!targetId) {
          await message.reply({ embeds: [Embed.warning('Missing User').setDescription(`Usage: \`${PREFIX}rolepersist info <@user>\``).toJSON()] }).catch(() => {});
          return;
        }

        const entry = getPersist(guildId, targetId);
        if (!entry) {
          await message.reply({ embeds: [Embed.info('Not Persisted').setDescription(`<@${targetId}> has no persisted role snapshot.`).toJSON()] }).catch(() => {});
          return;
        }

        await message.reply({
          embeds: [
            Embed.info('🔒  User Persist Info')
              .addFields(
                { name: '👤 User',     value: `<@${targetId}>`,                                             inline: true  },
                // role_persist_snapshots stores captured_at (unix seconds); reason/added_by are only
                // set for manually-added snapshots, auto-captures on leave have neither.
                { name: '📅 Snapshot', value: `<t:${entry.captured_at}:R>`,                                inline: true  },
                { name: '👮 Added By', value: entry.added_by ? `<@${entry.added_by}>` : 'Automatic (left server)', inline: true  },
                { name: '📋 Reason',   value: entry.reason ?? 'No reason provided',                          inline: false },
                { name: `🎭 Roles (${entry.roleIds.length})`,
                  value: entry.roleIds.map(id => `<@&${id}>`).join(' ') || 'None',                          inline: false },
              )
              .toJSON(),
          ],
        });
        break;
      }

      default:
        await message.reply({
          embeds: [
            Embed.info('🔒  Role Persist: Reference')
              .setDescription('Two modes: pin a specific user\'s roles, or set a server-wide rule for a role.')
              .addFields(
                { name: '👤  User Persist', value:
                  `\`${PREFIX}rolepersist add @user [reason]\`: pin their current roles\n` +
                  `\`${PREFIX}rolepersist remove @user\`: clear their snapshot\n` +
                  `\`${PREFIX}rolepersist info @user\`: view their snapshot`,
                  inline: false },
                { name: '🎭  Role Rules', value:
                  `\`${PREFIX}rolepersist role add @role [reason]\`: anyone who leaves with this role gets it back\n` +
                  `\`${PREFIX}rolepersist role remove @role\`: stop tracking a role\n` +
                  `\`${PREFIX}rolepersist role list\`: show all rules`,
                  inline: false },
                { name: '📋  Combined', value:
                  `\`${PREFIX}rolepersist list\`: show both role rules and pinned users`,
                  inline: false },
              )
              .toJSON(),
          ],
        });
    }
  },
};