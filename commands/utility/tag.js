// ============================================================
//  commands/utility/tag.js
//  Category : Utility  |  Rank 0 read / Rank 2 write
//
//  !tag <name>                 , trigger a tag
//  !tag add <name> <response>  , create/overwrite  (Mod+)
//  !tag remove <name>          , delete            (Mod+)
//  !tag list                   , list all tags
//  !tag info <name>            , show tag details
//  !tag rename <old> <new>     , rename            (Mod+)
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS, Embed } from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';
import { resolveAccess } from '../../handlers/commandPermissions.js';
import { addTag, removeTag, getTag, listTags, renameTag } from '../../handlers/customCommands.js';
import db from '../../db.js';

// Tag names that would collide with this command's own subcommands.
const RESERVED = new Set(['add', 'remove', 'list', 'info', 'rename']);

export default {
  name: 'tag',
  aliases: ['tags', 'customcmd', 'cc'],
  description: 'Custom command shortcuts for your server.',
  usage: '{prefix}tag <name>  |  add <name> <response>  |  remove <name>  |  list',
  category: 'utility',

  requiredPermission: null,
  internalAccess: true, // subcommands gate themselves via resolveAccess

  cooldown: 2,

  async execute({ message, args, prefix, client }) {
    const guildId = message.guildId;
    const userId  = message.author.id;
    const sub     = args[0]?.toLowerCase();

    // ── list ──────────────────────────────────────────────────────────────────
    if (!sub || sub === 'list') {
      const tags = listTags(guildId);
      if (!tags.length) {
        return message.reply({ embeds: [Embed.info('No Tags').setDescription(`No custom tags yet. Use \`${prefix}tag add <name> <response>\` to create one.`).toJSON()] });
      }
      const lines = tags.map(t => `\`${t.name}\`: ${t.uses ?? 0} use${t.uses !== 1 ? 's' : ''}`);
      return message.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.INFO)
          .setTitle(`🏷️  Custom Tags (${tags.length})`)
          .setDescription(lines.join('\n').slice(0, 4000))
          .setFooter({ text: `Use ${prefix}tag <name> to trigger` })
          .toJSON()],
      });
    }

    // ── info ──────────────────────────────────────────────────────────────────
    if (sub === 'info') {
      const name = args[1]?.toLowerCase();
      if (!name) return message.reply(`Usage: \`${prefix}tag info <name>\``);
      const tag = getTag(guildId, name);
      if (!tag) return message.reply({ embeds: [Embed.danger('Not Found').setDescription(`No tag named \`${name}\`.`).toJSON()] });
      return message.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.INFO)
          .setTitle(`🏷️  Tag: ${tag.name}`)
          .addFields(
            { name: 'Response',   value: tag.response.slice(0, 1000), inline: false },
            { name: 'Created by', value: tag.creator_id ? `<@${tag.creator_id}>` : 'Unknown', inline: true },
            { name: 'Uses',       value: String(tag.uses ?? 0), inline: true },
            { name: 'Created',    value: tag.created_at ? `<t:${tag.created_at}:R>` : 'Unknown', inline: true },
          ).toJSON()],
      });
    }

    // ── add ───────────────────────────────────────────────────────────────────
    if (sub === 'add') {
      if (!await resolveAccess(client, guildId, userId, 'tag', Permissions.KICK_MEMBERS)) return message.reply({ embeds: [Embed.denied('Mod or higher required to create tags.').toJSON()] });
      const name     = args[1]?.toLowerCase();
      const response = args.slice(2).join(' ');
      if (!name || !response) return message.reply(`Usage: \`${prefix}tag add <name> <response>\``);
      if (name.length > 32)   return message.reply('Tag name must be 32 characters or fewer.');
      if (response.length > 1000) return message.reply('Tag response must be 1000 characters or fewer.');
      if (RESERVED.has(name) || client.commands.has(name)) return message.reply(`\`${name}\` is a bot command or tag subcommand, pick another name.`);
      addTag(guildId, name, response, userId);
      return message.reply({ embeds: [Embed.success('Tag Created').setDescription(`Tag \`${name}\` saved. Trigger with \`${prefix}${name}\`.`).toJSON()] });
    }

    // ── remove ────────────────────────────────────────────────────────────────
    if (sub === 'remove') {
      if (!await resolveAccess(client, guildId, userId, 'tag', Permissions.KICK_MEMBERS)) return message.reply({ embeds: [Embed.denied('Mod or higher required to remove tags.').toJSON()] });
      const name = args[1]?.toLowerCase();
      if (!name) return message.reply(`Usage: \`${prefix}tag remove <name>\``);
      const removed = removeTag(guildId, name);
      if (!removed) return message.reply({ embeds: [Embed.danger('Not Found').setDescription(`No tag named \`${name}\`.`).toJSON()] });
      return message.reply({ embeds: [Embed.success('Tag Removed').setDescription(`Tag \`${name}\` deleted.`).toJSON()] });
    }

    // ── rename ────────────────────────────────────────────────────────────────
    if (sub === 'rename') {
      if (!await resolveAccess(client, guildId, userId, 'tag', Permissions.KICK_MEMBERS)) return message.reply({ embeds: [Embed.denied('Mod or higher required to rename tags.').toJSON()] });
      const oldName = args[1]?.toLowerCase();
      const newName = args[2]?.toLowerCase();
      if (!oldName || !newName) return message.reply(`Usage: \`${prefix}tag rename <old> <new>\``);
      const tag = getTag(guildId, oldName);
      if (!tag) return message.reply({ embeds: [Embed.danger('Not Found').setDescription(`No tag named \`${oldName}\`.`).toJSON()] });
      if (newName.length > 32) return message.reply('Tag name must be 32 characters or fewer.');
      if (RESERVED.has(newName) || client.commands.has(newName)) return message.reply(`\`${newName}\` is a bot command or tag subcommand, pick another name.`);
      if (!renameTag(guildId, oldName, newName)) return message.reply({ embeds: [Embed.danger('Name Taken').setDescription(`A tag named \`${newName}\` already exists.`).toJSON()] });
      return message.reply({ embeds: [Embed.success('Tag Renamed').setDescription(`\`${oldName}\` → \`${newName}\`.`).toJSON()] });
    }

    // ── direct trigger ────────────────────────────────────────────────────────
    const tag = getTag(guildId, sub);
    if (tag) {
      const response = tag.response
        .replace(/{user}/g,    `<@${userId}>`)
        .replace(/{username}/g, message.author.username ?? userId)
        .replace(/{server}/g,   'this server')
        .replace(/{channel}/g, `<#${message.channelId}>`);
      try {
        db.prepare(`UPDATE custom_commands SET uses = COALESCE(uses, 0) + 1 WHERE guild_id = ? AND trigger = ?`).run(guildId, tag.name);
      } catch { /* uses column may not exist */ }
      return message.send({ content: response, allowedMentions: { parse: ['users'] } }).catch(() => {});
    }

    return message.reply({ embeds: [Embed.danger('Unknown Tag').setDescription(`No tag named \`${sub}\`. Run \`${prefix}tag list\` to see all.`).toJSON()] });
  },
};
