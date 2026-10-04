// ============================================================
//  commands/moderation/shadowban.js
//
//  !shadowban <@user|id> [reason]   , silently block someone from commands
//  !shadowban remove <@user|id>     , lift a shadow ban
//  !shadowban list                  , list current shadow bans in this guild
//
//  The block itself lives in handlers/commandHandler.js, checked right
//  after prefix/command parsing, before every other gate, it silently
//  deletes the trigger message and returns, no denial reply. This file is
//  only the staff-facing management command.
//
//  Restricted to the bot owner only (requiredPermission: 'BOT_OWNER'), not
//  Mod+/Admin, and not overridable per-guild, see commandPermissions.js's
//  BOT_OWNER handling and its guard in commands/utility/permissions.js. A
//  tool this stealthy (no denial message, no visible trace to the target)
//  is exactly the kind of thing a compromised or rogue mod could otherwise
//  abuse against a legitimate member with no way for anyone else to notice.
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed } from '../../config/embeds.js';
import { isBotOwner, isRealOwner } from '../../handlers/staffSystem.js';
import {
  addShadowBan, removeShadowBan, listShadowBans, getShadowBan,
} from '../../handlers/shadowBan.js';

function parseId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

export default {
  name: 'shadowban',
  aliases: [], // not "sb": that's b!starboard, and a two-letter slip shouldn't shadowban anyone
  description: 'Silently block a user from running commands, no denial message, their command messages just vanish. Bot owner only.',
  usage: '{prefix}shadowban <@user|id> [reason] | {prefix}shadowban remove <@user|id> | {prefix}shadowban list',
  category: 'moderation',

  requiredPermission: 'BOT_OWNER',
  cooldown: 3,

  async execute({ message, args, prefix }) {
    const PREFIX     = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId     = message.guildId;
    const executorId  = message.author.id;
    const sub         = args[0]?.toLowerCase();

    // ── !shadowban list ──────────────────────────────────
    if (sub === 'list') {
      const rows = listShadowBans(guildId);
      if (!rows.length) {
        return message.reply({ embeds: [Embed.info('No one is currently shadow-banned in this server.').toJSON()] });
      }
      const lines = rows.map(r => `<@${r.user_id}> (\`${r.user_id}\`), <t:${r.added_at}:R>${r.reason ? `, ${r.reason}` : ''}`);
      return message.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle(`🫥  Shadow-Banned Users (${rows.length})`)
          .setDescription(lines.join('\n'))
          .toJSON()],
      });
    }

    // ── !shadowban remove <@user|id> ─────────────────────
    if (sub === 'remove') {
      const targetId = parseId(args[1]);
      if (!targetId) return message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}shadowban remove <@user|id>\``).toJSON()] });
      const removed = removeShadowBan(guildId, targetId);
      if (!removed) return message.reply({ embeds: [Embed.info(`<@${targetId}> is not shadow-banned.`).toJSON()] });
      return message.reply({ embeds: [Embed.success(`<@${targetId}> is no longer shadow-banned.`).toJSON()] });
    }

    // ── !shadowban <@user|id> [reason] ───────────────────
    const targetId = parseId(args[0]);
    const reason   = args.slice(1).join(' ') || null;
    if (!targetId) {
      return message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}shadowban <@user|id> [reason]\``).toJSON()] });
    }
    if (targetId === executorId) {
      return message.reply({ embeds: [Embed.danger('You cannot shadow-ban yourself.').toJSON()] });
    }
    // Owners are the whole point of the command's authority chain, shadow-
    // banning one would just get silently overridden by nothing (they still
    // have real permission), and inviting a mod to try is a footgun, block
    // it outright with a clear reason instead of a confusing silent no-op.
    if (isBotOwner(targetId) || await isRealOwner(guildId, targetId)) {
      return message.reply({ embeds: [Embed.danger('Cannot shadow-ban the bot owner or this server\'s owner.').toJSON()] });
    }

    const already = getShadowBan(guildId, targetId);
    addShadowBan(guildId, targetId, reason, executorId);

    return message.reply({
      embeds: [Embed.success(already ? 'Shadow Ban Updated' : 'Shadow Ban Applied')
        .setDescription(
          `<@${targetId}> will no longer see any response to their commands.\n` +
          `${reason ? `**Reason:** ${reason}` : '*No reason provided.*'}`
        ).toJSON()],
    });
  },
};
