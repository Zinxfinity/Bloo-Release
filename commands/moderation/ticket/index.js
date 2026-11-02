// ============================================================
//  commands/moderation/ticket/
//
//  Configuration (Ban Members+):
//  !ticket setup                         , guided first-time setup info
//  !ticket channel <#channel>            , where the panel is posted
//  !ticket category <id|name>            , Fluxer category for ticket channels
//  !ticket role <@role>                  , support role that sees all tickets
//  !ticket title <text>                  , embed title
//  !ticket description <text>            , embed description
//  !ticket icon <url>                    , embed thumbnail icon URL
//  !ticket color <hex>                   , embed color (e.g. #5865F2)
//  !ticket option add <emoji> <label>    , add a reaction option (max 5)
//  !ticket option remove <emoji>         , remove a reaction option
//  !ticket option list                   , list current options
//  !ticket option toggle <emoji>         , turn a category on/off (stays visible, blocks new tickets)
//  !ticket option disabledmessage <emoji> <text> , message DM'd while a category is off
//  !ticket remove                        , delete the panel (use before relocating)
//  !ticket panel                         , post/repost the panel embed
//  !ticket status                        , show full config
//
//  Public (open to all, auth checked internally):
//  !ticket close [reason]                , close the current ticket channel
//  !ticket type <keyword>                , recategorize this ticket to an existing category (staff only)
//  !ticket allow|deny <attach|embed|react> , change what this ticket's opener can do (staff only)
//
//  Opener permissions (Ban Members+):
//  !ticket perms [<permission> <on|off>] , what ticket openers can do by default
//
//  Blacklist (bypasses the outer gate; blocks blacklisting staff members):
//  !ticket blacklist add <@user> [reason] , blacklist a user from opening tickets
//  !ticket blacklist remove <@user>       , remove a user from the blacklist
//  !ticket blacklist list                 , list all blacklisted users
//
//  Lookup (Ban Members+ by default, configurable):
//  !ticket case <id>                     , look up a ticket by case ID
//  !ticket case setperm <permission>      , set minimum permission for case lookup (Server Owner/Bot Owner only)
//
//  Split from a single 796-line file into one file per subcommand group:
//  config.js (panel setup/appearance), options.js, close.js, case.js, blacklist.js.
// ============================================================

import { Embed } from '../../../config/embeds.js';
import { resolveAccess, requirementLabel } from '../../../handlers/commandPermissions.js';
import { handleConfig, CONFIG_SUBCOMMANDS } from './config.js';
import { handleOptions } from './options.js';
import { handleClose } from './close.js';
import { handleCase } from './case.js';
import { handleBlacklist } from './blacklist.js';
import { handleType } from './type.js';
import { handlePerms, handleAllowDeny } from './perms.js';
import { handleReopen } from './reopen.js';
import { Permissions } from '../../../config/guildPermissions.js';

const STAFF_PERMISSION = Permissions.BAN_MEMBERS;


export default {
  name: 'ticket',
  aliases: ['tickets', 'tk'],
  description: 'Let members open private support tickets. Run {prefix}ticket on its own for every ticket command.',
  usage: '{prefix}ticket  (every ticket command)\n{prefix}ticket setup\n{prefix}ticket close [reason]',

  // Open at the command level so a ticket opener can run `!ticket close` in
  // their own ticket. Every other subcommand is gated below (config) or
  // inside its own handler (type/case/blacklist), with the same per-guild
  // override applied via resolveAccess.
  requiredPermission: null,
  internalAccess: true,

  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId    = message.guildId;

    const [sub, ...rest] = args;
    const subCmd = sub?.toLowerCase();

    const selfGated = new Set(['close', 'type', 'case', 'blacklist', 'allow', 'deny']);
    if (!selfGated.has(subCmd)) {
      if (!await resolveAccess(client, guildId, message.author.id, 'ticket', STAFF_PERMISSION)) {
        const req = requirementLabel(guildId, 'ticket', STAFF_PERMISSION);
        await message.reply({
          embeds: [Embed.denied(`Requires: ${req}`).toJSON()],
        });
        return;
      }
    }

    const ctx = { message, args, client, prefix, guildId, subCmd, rest };

    if (CONFIG_SUBCOMMANDS.has(subCmd)) return handleConfig(ctx);
    if (subCmd === 'option')            return handleOptions(ctx);
    if (subCmd === 'close')             return handleClose(ctx);
    if (subCmd === 'type')              return handleType(ctx);
    if (subCmd === 'case')              return handleCase(ctx);
    if (subCmd === 'blacklist')         return handleBlacklist(ctx);
    if (subCmd === 'perms' || subCmd === 'permissions') return handlePerms(ctx);
    if (subCmd === 'allow' || subCmd === 'deny')         return handleAllowDeny(ctx);
    if (subCmd === 'reopen')            return handleReopen(ctx);

    const staffLabel = requirementLabel(guildId, 'ticket', STAFF_PERMISSION);
    // Grouped by what someone is trying to do. b!ticket remove still works
    // (same as panel delete) but isn't listed twice.
    const P = PREFIX;
    await message.reply({ embeds: [Embed.info('Members open a private ticket from a panel, and your support team answers there.', '🎫 Tickets')
      .addFields(
        { name: `1. Set it up *(${staffLabel})*`,
          value:
            `\`${P}ticket setup\` walks you through everything below\n` +
            `\`${P}ticket role @Support\` who answers tickets\n` +
            `\`${P}ticket category <category id>\` where new tickets open\n` +
            `\`${P}ticket channel #support\` where the panel goes\n` +
            `\`${P}ticket option add 🐛 Bug Report\` add a ticket type (also \`option list\`, \`option remove\`, and \`option message\` for its first message)\n` +
            `\`${P}ticket panel\` post the panel members click · \`${P}ticket panel delete\` take it down`,
          inline: false },
        { name: `2. Change how it works *(${staffLabel})*`,
          value:
            `\`${P}ticket title\` / \`description\` / \`icon\` / \`banner\` / \`color\` how the panel looks (type \`[\\n]\` for a new line)\n` +
            `\`${P}ticket closeemoji ❌\` the emoji that closes a ticket when someone reacts with it\n` +
            `\`${P}ticket delay 10\` seconds before a closed ticket's channel is deleted\n` +
            `\`${P}ticket openerclose on|off\` whether members can close their own tickets\n` +
            `\`${P}ticket perms\` whether members can attach files, embed links or react in their tickets\n` +
            `\`${P}ticket status\` see every setting`,
          inline: false },
        { name: '3. Inside a ticket',
          value:
            `\`${P}ticket close [reason]\` close it: the support role and staff, plus the member who opened it unless \`openerclose\` is off\n` +
            `\`${P}ticket type <keyword>\` move it to a different ticket type *(staff)*\n` +
            `\`${P}ticket allow attach\` / \`deny attach\` let this ticket's member send files, or stop them (also \`embed\`, \`react\`) *(staff)*`,
          inline: false },
        { name: '4. Past tickets and blocking *(staff)*',
          value:
            `\`${P}ticket case <id>\` look up a ticket\n` +
            `\`${P}ticket reopen <id>\` reopen a closed ticket in a new channel\n` +
            `\`${P}ticket blacklist add @user\` stop someone opening tickets (also \`remove\`, \`list\`)`,
          inline: false },
      )
      .setFooter({ text: 'Everything here is also on the dashboard: Community → Tickets.' })
      .toJSON()] });
  },
};
