// ─── !dash add/remove/list, !dash role add/remove ─────────────────────────────
// Manage dashboard access grants, per person or per role (up to three roles
// per tier). Dashboard access never follows Fluxer permissions: a user has
// zero dashboard access unless the Server Owner (or an existing co_owner-tier
// holder) grants it here, to them or to a role they hold. Only the Server
// Owner can tie a role to co_owner. Gate is custom, NOT routed through
// requiredPermission/checkCommandAccess, dashboard-grant authority is a
// separate axis from bot command permissions entirely.

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import { isRealOwner, isBotOwner } from '../../handlers/staffSystem.js';
import db from '../../db.js';
import {
  ensureDashAccessSchema, getDashTier, grantDashTier, revokeDashTier,
  listDashGrants, isValidTier, DASH_TIERS,
  listRoleGrants, grantRoleTier, revokeRoleTier, canManageRoleTier, MAX_ROLES_PER_TIER, findBotRoles,
} from '../../config/dashAccess.js';
import { fitLines } from '../../utils/format.js';

const parseRoleId = arg => arg?.match(/^<@&(\d+)>$/)?.[1] ?? (arg?.match(/^\d{17,20}$/) ? arg : null);

ensureDashAccessSchema(db);

function parseUserId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

async function canManageGrants(guildId, userId) {
  if (isBotOwner(userId)) return true;
  if (await isRealOwner(guildId, userId)) return true;
  return (await getDashTier(db, guildId, userId)) === 'co_owner';
}

export default {
  name: 'dash',
  aliases: ['dashboard', 'dashaccess'],
  description: 'Manage who can access this server\'s dashboard.',
  usage: '{prefix}dash <add|remove|list> [@user] [viewer|mod|admin|co_owner]\n{prefix}dash role <add|remove> <@role> [viewer|mod|admin|co_owner]',
  requiredPermission: null, // custom gate below, not permission-bit based
  internalAccess: true, // subcommands gate themselves via resolveAccess

  cooldown: 3,

  async execute({ message, args, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    const userId  = message.author.id;

    if (!guildId) {
      return message.reply({ embeds: [Embed.danger('This command can only be used inside a server.').toJSON()] });
    }

    if (!(await canManageGrants(guildId, userId))) {
      return message.reply({
        embeds: [Embed.denied('Only the Server Owner or a Co-Owner-tier holder can manage dashboard access.').toJSON()],
      });
    }

    const [sub, targetArg, tierArg] = args;

    if (!sub || sub.toLowerCase() === 'list') {
      const grants = listDashGrants(db, guildId);
      const roleGrants = listRoleGrants(db, guildId);
      if (!grants.length && roleGrants.length) {
        return message.reply({ embeds: [new EmbedBuilder().setColor(COLORS.INFO).setTitle('Dashboard Access Grants')
          .setDescription(`**Roles**\n${roleGrants.map(g => `<@&${g.role_id}>: **${g.tier}**`).join('\n')}\n\nNo personal grants.`).toJSON()] });
      }
      if (!grants.length) {
        return message.reply({
          embeds: [Embed.info('No Dashboard Grants')
            .setDescription(`No one has been explicitly granted dashboard access yet.\n\nUse \`${PREFIX}dash add @user <viewer|mod|admin|co_owner>\` to grant access.`)
            .toJSON()],
        });
      }
      const lines = grants.map(g => `<@${g.user_id}>: **${g.tier}** (granted by <@${g.granted_by}> <t:${g.granted_at}:R>)`);
      const roleLines = roleGrants.map(g => `<@&${g.role_id}>: **${g.tier}**`);
      return message.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.INFO)
          .setTitle('Dashboard Access Grants')
          .setDescription(fitLines([...(roleLines.length ? ['**Roles**', ...roleLines, '', '**People**'] : []), ...lines]))
          .setFooter({ text: `${grants.length} grant(s)` })
          .toJSON()],
      });
    }

    if (sub.toLowerCase() === 'role' || sub.toLowerCase() === 'roles') {
      const [, action, roleArg, roleTierArg] = args;
      const act = action?.toLowerCase();
      const roleId = parseRoleId(roleArg);
      if (!['add', 'remove'].includes(act) || !roleId) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}dash role add <@role> <viewer|mod|admin|co_owner>\` or \`${PREFIX}dash role remove <@role>\`. Up to ${MAX_ROLES_PER_TIER} roles per tier.`).toJSON()] });
      }
      if (act === 'remove') {
        if (!(await canManageRoleTier(db, guildId, userId, null, roleId))) {
          return message.reply({ embeds: [Embed.denied('Only the Server Owner can remove a Co-Owner role.').toJSON()] });
        }
        const removed = revokeRoleTier(db, guildId, roleId);
        return message.reply({ embeds: [(removed ? Embed.success(`<@&${roleId}> no longer gives dashboard access.`) : Embed.info(`<@&${roleId}> wasn't giving dashboard access.`)).toJSON()] });
      }
      const roleTier = roleTierArg?.toLowerCase();
      if (!isValidTier(roleTier)) {
        return message.reply({ embeds: [Embed.warning(`Invalid tier. Valid tiers: ${DASH_TIERS.join(', ')}`).toJSON()] });
      }
      if (!(await canManageRoleTier(db, guildId, userId, roleTier, roleId))) {
        return message.reply({ embeds: [Embed.denied('Only the Server Owner can tie a role to Co-Owner access.').toJSON()] });
      }
      const botName = (await findBotRoles(guildId)).get(roleId);
      if (botName) {
        return message.reply({ embeds: [Embed.warning(`<@&${roleId}> belongs to the bot ${botName}, so it can't be given dashboard access.`).toJSON()] });
      }
      try {
        grantRoleTier(db, guildId, roleId, roleTier, userId);
      } catch (e) {
        return message.reply({ embeds: [Embed.warning(e.message).toJSON()] });
      }
      return message.reply({ embeds: [Embed.success(`Everyone with <@&${roleId}> now has **${roleTier}** dashboard access.${roleTier === 'co_owner' ? '\nAnyone who can hand out this role on Fluxer can now hand out full dashboard control.' : ''}`).toJSON()] });
    }

    if (sub.toLowerCase() === 'add') {
      const targetId = parseUserId(targetArg);
      if (!targetId) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}dash add <@user> <viewer|mod|admin|co_owner>\``).toJSON()] });
      }
      const tier = tierArg?.toLowerCase();
      if (!isValidTier(tier)) {
        return message.reply({ embeds: [Embed.warning(`Invalid tier. Valid tiers: ${DASH_TIERS.join(', ')}`).toJSON()] });
      }
      grantDashTier(db, guildId, targetId, tier, userId);
      return message.reply({ embeds: [Embed.success(`<@${targetId}> now has **${tier}** dashboard access.`).toJSON()] });
    }

    if (sub.toLowerCase() === 'remove') {
      const targetId = parseUserId(targetArg);
      if (!targetId) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}dash remove <@user>\``).toJSON()] });
      }
      const removed = revokeDashTier(db, guildId, targetId);
      if (!removed) {
        return message.reply({ embeds: [Embed.info(`<@${targetId}> doesn't have an explicit dashboard grant.`).toJSON()] });
      }
      return message.reply({ embeds: [Embed.success(`Dashboard access revoked for <@${targetId}>.`).toJSON()] });
    }

    return message.reply({
      embeds: [Embed.info('Dashboard Access')
        .setDescription(
          `\`${PREFIX}dash add <@user> <viewer|mod|admin|co_owner>\`: grant a tier\n` +
          `\`${PREFIX}dash remove <@user>\`: revoke a grant\n` +
          `\`${PREFIX}dash role add <@role> <tier>\`: give a tier to everyone with a role (up to ${MAX_ROLES_PER_TIER} per tier)\n` +
          `\`${PREFIX}dash role remove <@role>\`: stop a role giving access\n` +
          `\`${PREFIX}dash list\`: show all current grants`
        ).toJSON()],
    });
  },
};
