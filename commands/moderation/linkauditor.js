// ============================================================
//  commands/moderation/linkauditor.js
//
//  !linkauditor              , show current status
//  !linkauditor on|off       , enable/disable
//
//  Scoped v1: links only (archived to web.archive.org), no file
//  re-hosting yet. Applies to non-staff members only, see
//  handlers/linkAuditor.js for the full behavior.
//
//  Requires Ban Members
// ============================================================

import { Embed } from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';
import { getLinkAuditorConfig, setLinkAuditorEnabled } from '../../handlers/linkAuditor.js';

export default {
  name: 'linkauditor',
  aliases: ['linkaudit'],
  description: 'Enable or disable automatic link archiving for non-staff members.',
  usage: '{prefix}linkauditor [on|off]',
  category: 'moderation',

  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    const sub = args[0]?.toLowerCase();

    if (sub === 'on' || sub === 'off') {
      setLinkAuditorEnabled(guildId, sub === 'on');
      await message.reply({
        embeds: [Embed.success(`Link Auditor ${sub === 'on' ? 'enabled' : 'disabled'}.`).toJSON()],
      }).catch(() => {});
      return;
    }

    const config = getLinkAuditorConfig(guildId);
    await message.reply({
      embeds: [Embed.info(
        `**Status:** ${config.enabled ? '✅ Enabled' : '❌ Disabled'}\n\n` +
        `When enabled, any link posted by a non-staff member is archived to web.archive.org, the original message is removed, and it's reposted with the archived link (noting who originally posted it). Staff are always exempt.\n\n` +
        `Use \`${PREFIX}linkauditor on\` or \`${PREFIX}linkauditor off\` to change this.`,
        'Link Auditor'
      ).toJSON()],
    }).catch(() => {});
  },
};
