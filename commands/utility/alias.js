// ============================================================
//  commands/utility/alias.js
//  Category : Utility  |  Rank 2 (Mod default)
//
//  !alias set <trigger> <command>  , create alias  (Mod+)
//  !alias remove <trigger>         , delete alias  (Mod+)
//  !alias list                     , list aliases  (Mod+)
//  !alias clear                    , remove all    (Ban Members+)
// ============================================================

import { EmbedBuilder }                from '@fluxerjs/core';
import { COLORS, Embed }               from '../../config/embeds.js';
import { resolveAccess }               from '../../handlers/commandPermissions.js';
import { Permissions } from '../../config/guildPermissions.js';
import {
  setAlias, removeAlias, listAliases, clearAliases,
} from '../../handlers/aliasSystem.js';

export default {
  name: 'alias',
  aliases: ['cmdalias'],
  description: 'Create per-server command aliases by mapping a custom trigger to an existing command.',
  usage: '{prefix}alias set <trigger> <command>\n{prefix}alias remove <trigger>\n{prefix}alias list\n{prefix}alias clear',
  category: 'utility',

  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    const userId  = message.author.id;

    const [sub, aliasArg, ...rest] = args;

    switch (sub?.toLowerCase()) {

      // ── set ────────────────────────────────────────────────────────────────
      case 'set': {
        const target = rest[0];
        if (!aliasArg || !target) {
          return message.reply({
            embeds: [Embed.warning('Usage')
              .setDescription(`\`${PREFIX}alias set <trigger> <command>\`\n\nExample: \`${PREFIX}alias set rm purge\`\n-# The trigger cannot match any existing command name.`)
              .toJSON()],
          }).catch(() => {});
        }
        const err = setAlias(guildId, aliasArg, target, userId, client.commands);
        if (err) {
          return message.reply({ embeds: [Embed.danger('Failed').setDescription(err).toJSON()] }).catch(() => {});
        }
        const canonical = client.commands?.get(target.toLowerCase())?.name ?? target;
        return message.reply({
          embeds: [Embed.success('Alias Created')
            .setDescription(`\`${PREFIX}${aliasArg.toLowerCase()}\` will now run \`${PREFIX}${canonical}\`.`)
            .addFields(
              { name: 'Trigger', value: `\`${PREFIX}${aliasArg.toLowerCase()}\``, inline: true },
              { name: 'Maps to', value: `\`${PREFIX}${canonical}\``,              inline: true },
              { name: 'Set by',  value: `<@${userId}>`,                           inline: true },
            )
            .setFooter({ text: 'All rank checks and cooldowns of the target command still apply.' })
            .toJSON()],
        }).catch(() => {});
      }

      // ── remove ─────────────────────────────────────────────────────────────
      case 'remove':
      case 'delete': {
        if (!aliasArg) {
          return message.reply({ embeds: [Embed.warning('Usage').setDescription(`\`${PREFIX}alias remove <trigger>\``).toJSON()] }).catch(() => {});
        }
        const removed = removeAlias(guildId, aliasArg);
        if (!removed) {
          return message.reply({ embeds: [Embed.info('Not Found').setDescription(`\`${aliasArg.toLowerCase()}\` is not a custom alias on this server.`).toJSON()] }).catch(() => {});
        }
        return message.reply({ embeds: [Embed.success('Alias Removed').setDescription(`\`${PREFIX}${aliasArg.toLowerCase()}\` has been removed.`).toJSON()] }).catch(() => {});
      }

      // ── list ───────────────────────────────────────────────────────────────
      case 'list': {
        const aliases = listAliases(guildId);
        if (!aliases.length) {
          return message.reply({
            embeds: [Embed.info('No Aliases').setDescription(`No custom aliases set.\nUse \`${PREFIX}alias set <trigger> <command>\` to create one.`).toJSON()],
          }).catch(() => {});
        }
        const lines = aliases.map(a => `\`${PREFIX}${a.alias}\` → \`${PREFIX}${a.target}\``);
        return message.reply({
          embeds: [new EmbedBuilder()
            .setTitle('⚡ Custom Aliases')
            .setColor(COLORS.INFO)
            .setDescription(lines.join('\n').slice(0, 4000))
            .setFooter({ text: `${aliases.length} alias${aliases.length === 1 ? '' : 'es'} · All rank checks of the target command still apply` })
            .toJSON()],
        }).catch(() => {});
      }

      // ── clear ──────────────────────────────────────────────────────────────
      case 'clear': {
        if (!await resolveAccess(client, guildId, userId, 'alias', Permissions.BAN_MEMBERS)) {
          return message.reply({ embeds: [Embed.denied('Ban Members or higher required to clear all aliases.').toJSON()] }).catch(() => {});
        }
        const aliases = listAliases(guildId);
        if (!aliases.length) {
          return message.reply({ embeds: [Embed.info('Nothing to Clear').setDescription('No custom aliases are set.').toJSON()] }).catch(() => {});
        }
        clearAliases(guildId);
        return message.reply({ embeds: [Embed.success('Cleared').setDescription(`Removed all ${aliases.length} custom alias${aliases.length === 1 ? '' : 'es'}.`).toJSON()] }).catch(() => {});
      }

      // ── help ───────────────────────────────────────────────────────────────
      default: {
        return message.reply({
          embeds: [new EmbedBuilder()
            .setTitle('⚡ Alias: Reference')
            .setColor(COLORS.INFO)
            .setDescription('Map custom trigger words to existing commands.')
            .addFields(
              { name: `\`${PREFIX}alias set <trigger> <command>\``, value: 'Create or overwrite an alias',      inline: false },
              { name: `\`${PREFIX}alias remove <trigger>\``,        value: 'Remove an alias',                  inline: false },
              { name: `\`${PREFIX}alias list\``,                    value: 'List all aliases for this server', inline: false },
              { name: `\`${PREFIX}alias clear\``,                   value: 'Remove all aliases (Ban Members+)',   inline: false },
              { name: 'Example', value: `\`${PREFIX}alias set rm purge\`\nNow \`${PREFIX}rm 50\` runs the purge command.`, inline: false },
            )
            .setFooter({ text: 'All rank checks and cooldowns of the target command still apply.' })
            .toJSON()],
        }).catch(() => {});
      }
    }
  },
};
