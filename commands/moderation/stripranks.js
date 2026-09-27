// ============================================================
//  commands/moderation/stripranks.js
//  Category : Moderation  |  Requires Ban Members (default)
//
//  Remove all Fluxer roles from a member in one action.
//  !stripranks <@user|id> [--keep <@role>...] [reason]
// ============================================================

import { Embed }                              from '../../config/embeds.js';
import { isRealOwner, isBotOwner }            from '../../handlers/staffSystem.js';
import { canActOnLive, botCanActOnLive }      from '../../config/guildPermissions.js';
import { sendModLog }                         from '../../handlers/modLog.js';
import { alertWatchlist }                     from '../../handlers/watchlist.js';
import { Permissions } from '../../config/guildPermissions.js';

function parseUserId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}
function parseRoleId(arg) {
  if (!arg) return null;
  return arg.match(/^<@&(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

export default {
  name: 'stripranks',
  aliases: ['striproles', 'nuke', 'clearroles'],
  description: 'Remove all roles from a member. Use --keep to preserve specific ones.',
  usage: '{prefix}stripranks @user [--keep @role...] [reason]',
  category: 'moderation',

  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 5,

  async execute({ message, args, client, prefix }) {
    const PREFIX        = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId       = message.guildId;
    const authorIsOwner = isBotOwner(message.author.id) || await isRealOwner(guildId, message.author.id);

    const targetId = parseUserId(args[0]);
    if (!targetId) {
      await message.reply({ embeds: [Embed.warning('Missing User').setDescription(`Usage: \`${PREFIX}stripranks <@user> [--keep <@role>...] [reason]\``).toJSON()] });
      return;
    }

    // Parse --keep and reason
    const keepRoleIds = new Set();
    const reasonParts = [];
    let keepMode = false;
    for (const arg of args.slice(1)) {
      if (arg === '--keep') { keepMode = true; continue; }
      const roleId = parseRoleId(arg);
      if (keepMode && roleId) { keepRoleIds.add(roleId); }
      else { keepMode = false; reasonParts.push(arg); }
    }
    const reason = reasonParts.join(' ') || 'No reason provided';

    const member = await client.rest.get(`/guilds/${guildId}/members/${targetId}`).catch(() => null);
    if (!member) {
      await message.reply({ embeds: [Embed.danger('Not Found').setDescription('That user is not in this server.').toJSON()] }).catch(() => {});
      return;
    }
    if (targetId === message.author.id) {
      await message.reply({ embeds: [Embed.danger('Invalid Target').setDescription('You cannot strip your own roles.').toJSON()] }).catch(() => {});
      return;
    }

    if (!authorIsOwner && !(await canActOnLive(client, guildId, message.author.id, targetId))) {
      await message.reply({ embeds: [Embed.danger('Cannot Modify').setDescription(`<@${targetId}> holds a Fluxer role position equal to or above yours.`).toJSON()] }).catch(() => {});
      return;
    }

    // Check bot can act. Executor-vs-target hierarchy was already checked
    // above (with the owner exemption); re-running canActOnLive here without
    // that exemption would block an owner who just correctly passed it.
    const canBot = await botCanActOnLive(client, guildId, targetId);
    if (!canBot) {
      await message.reply({ embeds: [Embed.denied('higher role in the Fluxer hierarchy').toJSON()] }).catch(() => {});
      return;
    }

    const memberRoles = (member.roles ?? []).filter(id => id !== guildId && !keepRoleIds.has(id));
    if (!memberRoles.length) {
      await message.reply({ embeds: [Embed.info('No Roles').setDescription('This member has no removable roles.').toJSON()] }).catch(() => {});
      return;
    }

    const status = await message.reply({
      embeds: [Embed.info('Stripping Roles…').setDescription(`Removing ${memberRoles.length} role(s) from <@${targetId}>…`).toJSON()],
    });

    let removed = 0, failed = 0;
    for (const roleId of memberRoles) {
      const ok = await client.rest.delete(`/guilds/${guildId}/members/${targetId}/roles/${roleId}`)
        .then(() => true).catch(() => false);
      if (ok) removed++; else failed++;
    }

    await sendModLog(client, guildId, {
      action: 'Roles Stripped', targetId,
      executorId: message.author.id, reason,
    });
    await alertWatchlist(client, guildId, targetId, `Roles Stripped (${removed} removed)`, reason);

    await status?.edit({
      embeds: [
        Embed.success('🧹  Roles Stripped')
          .setDescription(`Removed **${removed}** role(s) from <@${targetId}>.${failed ? `\n⚠️ ${failed} role(s) could not be removed (hierarchy).` : ''}`)
          .addFields(
            { name: '🎯 User',   value: `<@${targetId}>`,           inline: true },
            { name: '🗑️ Removed', value: `${removed}`,              inline: true },
            { name: '📋 Reason', value: reason,                     inline: false },
            { name: '👮 By',     value: `<@${message.author.id}>`, inline: true },
            ...(keepRoleIds.size ? [{ name: '✅ Kept', value: [...keepRoleIds].map(id => `<@&${id}>`).join(' '), inline: false }] : []),
          ).toJSON(),
      ],
    });
  },
};
