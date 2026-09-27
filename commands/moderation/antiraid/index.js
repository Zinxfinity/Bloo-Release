// ============================================================
//  commands/moderation/antiraid/
//  Category : Moderation  |  Access 0  |  Requires Ban Members (default)
//
//  Configure the captcha verification system for new members.
//  When enabled, new members must complete a challenge before
//  they can access the server. A DM is sent with the link; if
//  DMs are closed, the link is posted in the verify channel.
//
//  !antiraid on                   , enable captcha verification
//  !antiraid off                  , disable captcha verification
//  !antiraid role @Role           , set the role granted after passing
//  !antiraid channel #channel     , post the verify info panel
//  !antiraid mode web             , use hCaptcha web page (default)
//  !antiraid mode dm              , use in-DM image captcha (stays on-platform)
//  !antiraid raid on|off|age|action|log , Raid Mode account-age auto-kick/ban (opt-in)
//  !antiraid status               , view current configuration
//  !antiraid bulkverify all|role  , retroactively grant the verified role
//
//  Split from a single 423-line file: config.js (on/off/role/channel/mode/status),
//  bulkverify.js (the batch-grant operation), helpers.js (shared parsing/DB helpers).
// ============================================================

import { Embed } from '../../../config/embeds.js';
import { handleConfig, CONFIG_SUBCOMMANDS } from './config.js';
import { handleBulkVerify } from './bulkverify.js';
import { Permissions } from '../../../config/guildPermissions.js';

export default {
  name: 'antiraid',
  aliases: ['captcha', 'verification'],
  description: 'Configure captcha verification for new members to block raids and bots.',
  usage: '{prefix}antiraid <on | off | role | channel | mode | raid | status | bulkverify>',
  example: '{prefix}antiraid on\n{prefix}antiraid role @Verified\n{prefix}antiraid bulkverify all\n{prefix}antiraid bulkverify role @Members',
  category: 'moderation',

  requiredPermission: Permissions.BAN_MEMBERS,  // Ban Members, configurable via !permissions
  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;

    if (!guildId) {
      await message.reply({ embeds: [Embed.danger('Server Only').setDescription('This command can only be used inside a server.').toJSON()] }).catch(() => {});
      return;
    }

    const [sub, value] = args;
    const subLower = sub?.toLowerCase();

    const ctx = { message, args, client, prefix, guildId, subLower, value };

    if (CONFIG_SUBCOMMANDS.has(subLower)) return handleConfig(ctx);
    if (subLower === 'bulkverify')        return handleBulkVerify(ctx);

    // ── Help ──────────────────────────────────────────────
    await message.reply({
      embeds: [
        Embed.info('🛡️  Anti-Raid: Captcha System')
          .setDescription('Require new members to complete a captcha challenge before accessing the server.')
          .addFields(
            { name: `\`${PREFIX}antiraid on\``,                 value: 'Enable captcha for new members',                  inline: false },
            { name: `\`${PREFIX}antiraid off\``,                value: 'Disable captcha',                                  inline: false },
            { name: `\`${PREFIX}antiraid role @Role\``,         value: 'Set the role granted after passing verification', inline: false },
            { name: `\`${PREFIX}antiraid channel #channel\``,   value: 'Set verify channel and post the info panel',      inline: false },
            { name: `\`${PREFIX}antiraid mode web\``,            value: 'Use hCaptcha on an external page (default)',      inline: false },
            { name: `\`${PREFIX}antiraid mode dm\``,             value: 'Use in-DM image captcha. Members never leave Fluxer.',  inline: false },
            { name: `\`${PREFIX}antiraid raid\``,                            value: 'Raid Mode: auto-kick/ban accounts younger than a minimum age (off by default)', inline: false },
            { name: `\`${PREFIX}antiraid status\``,                          value: 'View current configuration',                              inline: false },
            { name: `\`${PREFIX}antiraid bulkverify all\``,                    value: 'Grant verified role to all current members',              inline: false },
            { name: `\`${PREFIX}antiraid bulkverify role @Role1 @Role2\``,     value: 'Grant verified role to members holding the given role(s)',  inline: false },
          )
          .setFooter({ text: 'Ban Members+ required by default, configurable via !permissions' })
          .toJSON(),
      ],
    });
  },
};
