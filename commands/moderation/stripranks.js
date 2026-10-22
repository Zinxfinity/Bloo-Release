// ============================================================
//  commands/moderation/stripranks.js
//  Category : Moderation  |  Requires Ban Members (default)
//
//  Remove all Fluxer roles from a member in one action.
//  !stripranks <@user|id> [--keep <@role>...] [reason]
// ============================================================

import { Embed }                              from '../../config/embeds.js';
import { isRealOwner, isBotOwner }            from '../../handlers/staffSystem.js';
import { stripMemberRoles, StripRanksError } from '../../handlers/stripRanks.js';
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

    // Checks, removal, mod log and watchlist alert are shared with the
    // dashboard's Actions page (handlers/stripRanks.js).
    let status = null, result;
    try {
      result = await stripMemberRoles(client, guildId, {
        targetId, executorId: message.author.id, executorIsOwner: authorIsOwner,
        keep: [...keepRoleIds], reason,
        onStart: async n => {
          status = await message.reply({
            embeds: [Embed.info('Stripping Roles…').setDescription(`Removing ${n} role(s) from <@${targetId}>…`).toJSON()],
          });
        },
      });
    } catch (err) {
      if (!(err instanceof StripRanksError)) throw err;
      await message.reply({ embeds: [Embed.warning('Cannot Strip Roles').setDescription(err.message).toJSON()] }).catch(() => {});
      return;
    }
    const { removed, failed } = result;

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
