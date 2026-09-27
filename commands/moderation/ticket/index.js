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
import { resolveAccess, getCommandConfig } from '../../../handlers/commandPermissions.js';
import { handleConfig, CONFIG_SUBCOMMANDS } from './config.js';
import { handleOptions } from './options.js';
import { handleClose } from './close.js';
import { handleCase } from './case.js';
import { handleBlacklist } from './blacklist.js';
import { handleType } from './type.js';
import { Permissions } from '../../../config/guildPermissions.js';

const STAFF_PERMISSION = Permissions.BAN_MEMBERS;

const PERM_NAMES = new Map([
  [Permissions.KICK_MEMBERS,     'Kick Members'],
  [Permissions.BAN_MEMBERS,      'Ban Members'],
  [Permissions.MANAGE_GUILD,     'Manage Server'],
  [Permissions.MANAGE_MESSAGES,  'Manage Messages'],
  [Permissions.MANAGE_CHANNELS,  'Manage Channels'],
  [Permissions.MANAGE_ROLES,     'Manage Roles'],
  [Permissions.MANAGE_WEBHOOKS,  'Manage Webhooks'],
  [Permissions.MODERATE_MEMBERS, 'Timeout Members'],
  [Permissions.ADMINISTRATOR,    'Administrator'],
]);

function requirementLabel(guildId, commandName, defaultPermission) {
  const cfg = getCommandConfig(guildId, commandName);
  if (cfg?.required_type === 'role' && cfg.required_value) return `<@&${cfg.required_value}>`;
  if (cfg?.required_type === 'permission' && cfg.required_value) return PERM_NAMES.get(BigInt(cfg.required_value)) ?? 'Unknown Permission';
  if (defaultPermission === 'SERVER_OWNER') return 'Server Owner';
  if (defaultPermission === 'BOT_OWNER') return 'Bot Owner';
  if (defaultPermission == null) return 'Everyone';
  return PERM_NAMES.get(defaultPermission) ?? 'Unknown Permission';
}

export default {
  name: 'ticket',
  aliases: ['tickets', 'tk'],
  description: 'Configure the support ticket system: panel, categories, and options.',
  usage: '{prefix}ticket <panel | category | option | status | role | icon | color | blacklist>',

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

    const selfGated = new Set(['close', 'type', 'case', 'blacklist']);
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

    const staffLabel = requirementLabel(guildId, 'ticket', STAFF_PERMISSION);
    await message.reply({ embeds: [Embed.info('🎫 Ticket System')
      .addFields(
        { name: `Config *(${staffLabel})*`,
          value:
            `\`${PREFIX}ticket setup\`: first-time setup guide\n` +
            `\`${PREFIX}ticket channel/category/role/title/description/icon/banner/color\`: configure the panel\n` +
            `\`${PREFIX}ticket option add/remove/list/message\`: manage reaction options\n` +
            `\`${PREFIX}ticket panel\`: post or repost the panel\n` +
            `\`${PREFIX}ticket panel delete\`: delete the current panel\n` +
            `\`${PREFIX}ticket remove\`: remove the panel before relocating\n` +
            `\`${PREFIX}ticket status\`: view current config`,
          inline: false },
        { name: 'General',
          value:
            `\`${PREFIX}ticket close [reason]\`: close this ticket channel\n` +
            `\`${PREFIX}ticket type <keyword>\`: recategorize this ticket (staff only)\n` +
            `\`${PREFIX}ticket blacklist add/remove/list\`: manage the ticket blacklist\n` +
            `\`${PREFIX}ticket case <id>\`: look up a ticket case`,
          inline: false },
      )
      .setFooter({ text: 'Tip: use [\\n] in title/description for line breaks' })
      .toJSON()] });
  },
};
