// ============================================================
//  commands/moderation/reactionrole.js
//  Category : Moderation  |  Access 0 (EVERYONE)  |  Rank 6 (Server Owner default)
//
//  Manage reaction role mappings, add, remove, clear, list.
//  Checks bot has MANAGE_ROLES and its role is above the target
//  role in the hierarchy before saving any mapping.
//
//  !rr add <messageId> <emoji> <@role>       , add / overwrite a mapping
//  !rr remove <messageId> <emoji>            , remove one emoji mapping
//  !rr clear <messageId>                     , remove all mappings on a message
//  !rr relink <oldMessageId> <newMessageId>  , move all mappings to a different message
//  !rr list [messageId]                      , list guild or message mappings
//
//  Gate 1 : accessLevel 0    , Everyone bot access
//  Gate 2 : requiredPermission BAN_MEMBERS, configurable per guild
// ============================================================

import { Embed }                             from '../../config/embeds.js';
import { roleGrantBlock } from '../../utils/roleGrant.js';
import { resolveShortcode }                  from '../../config/emojiMap.js';
import {
  Permissions,
  hasGuildPermission,
  botCanAssignRoleLive,
} from '../../config/guildPermissions.js';
import {
  addReactionRole,
  removeReactionRole,
  clearReactionRoles,
  getMappings,
  getAllForGuild,
  relinkMessage,
} from '../../handlers/reactionRoles.js';

function normaliseEmoji(raw) {
  const custom = raw.match(/^<a?:(\w+):(\d+)>$/);
  if (custom) return `${custom[1]}:${custom[2]}`;
  // resolveShortcode converts :shortcode: → unicode (or passes raw unicode
  // through unchanged) and strips FE0F, that's already the final stored key
  // format. canonicalEmoji()/emojiKey() expects an emoji OBJECT ({name, id})
  // from the Fluxer reaction event, not a string, so it must not wrap a
  // string here, passing one in always resolved to '' (no .name property),
  // which is why every unicode reaction-role mapping was silently unusable.
  return resolveShortcode(raw);
}

function isCustomEmoji(emoji) {
  return /^\w+:\d+$/.test(emoji);
}

async function resolveEmoji(client, emoji, guildId) {
  if (isCustomEmoji(emoji)) return await client.resolveEmoji(emoji, guildId);
  return emoji;
}

async function fetchTargetMessage(client, messageId, hintChannelId) {
  // Try the hint channel first (the channel where the command was run), then
  // fall back to a direct REST fetch using the guild's text channels from API.
  // This is best-effort, reaction roles still function from DB if this fails.
  const tryChannel = async (channelId) => {
    try {
      return await client.rest.get(`/channels/${channelId}/messages/${messageId}`);
    } catch { return null; }
  };

  if (hintChannelId) {
    const msg = await tryChannel(hintChannelId);
    if (msg) return msg;
  }
  return null;
}

async function addReaction(client, target, emoji, guildId) {
  try {
    // msg.react() is broken in FluxerJS, use REST PUT directly
    // Custom emoji stored as "name:id", encode as "name:id"
    // Unicode emoji, encode the raw character
    let emojiKey;
    if (isCustomEmoji(emoji)) {
      emojiKey = encodeURIComponent(emoji); // already "name:id"
    } else {
      const resolved = resolveEmoji(client, emoji, guildId);
      const raw = typeof resolved === 'string' ? resolved : emoji;
      emojiKey = encodeURIComponent(raw.replace(/\uFE0F/g, ''));
    }
    await client.rest.put(
      `/channels/${target.channel_id ?? target.channelId}/messages/${target.id}/reactions/${emojiKey}/@me`
    );
  } catch (err) {
    console.warn(`[RR] Could not react to message ${target.id}: ${err.message}`);
  }
}

async function removeReaction(client, target, emoji, guildId) {
  try {
    let emojiKey;
    if (isCustomEmoji(emoji)) {
      emojiKey = encodeURIComponent(emoji);
    } else {
      const resolved = await resolveEmoji(client, emoji, guildId);
      const raw = typeof resolved === 'string' ? resolved : emoji;
      emojiKey = encodeURIComponent(raw.replace(/️/g, ''));
    }
    await client.rest.delete(
      `/channels/${target.channel_id ?? target.channelId}/messages/${target.id}/reactions/${emojiKey}/@me`
    );
  } catch (err) {
    console.warn(`[RR] Could not remove reaction ${emoji} from ${target.id}: ${err.message}`);
  }
}

export default {
  name: 'rr',
  aliases: ['reactionrole'],
  description: 'Add, remove, or list reaction role mappings on a message.',
  usage: '{prefix}rr <add | remove | clear | list> [args]',
  category: 'moderation',

  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX    = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId   = message.guildId;
    const channelId = message.channelId;

    if (!guildId) {
      await message.reply({ embeds: [Embed.danger('Server Only').setDescription('Reaction roles can only be configured inside a server.').toJSON()] }).catch(() => {});
      return;
    }

    // Always fetch fresh, cached guild has stale role positions.
    // guilds.fetch() throws (rather than returning null) on a missing guild.
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      await message.reply({ embeds: [Embed.danger('Server Error').setDescription('Could not resolve this server.').toJSON()] }).catch(() => {});
      return;
    }

    const [sub, ...rest] = args;

    switch (sub?.toLowerCase()) {

      // ── !rr add <messageId> <emoji> <@role> ──────────
      case 'add': {
        const [messageId, rawEmoji, roleArg] = rest;
        const roleId = roleArg?.replace(/\D/g, '');

        if (!messageId || !rawEmoji || !roleId) {
          await message.reply({
            embeds: [
              Embed.warning('Incorrect Usage')
                .setDescription(`Usage: \`${PREFIX}rr add <messageId> <emoji> <@role>\``)
                .addFields({ name: 'Example', value: `\`${PREFIX}rr add 1234567890 ✅ @Member\``, inline: false })
                .toJSON(),
            ],
          });
          return;
        }

        // Bot permission check.
        // fetchMember() makes a REST call that can 403 even when the bot has
        // admin, fail open in that case rather than crashing the command.
        let botMember = null;
        try {
          botMember = await client.rest.get(`/guilds/${guildId}/members/${client.user.id}`);
        } catch (err) {
          if (err?.statusCode !== 403 && err?.code !== 'MISSING_PERMISSIONS') throw err;
        }
        if (botMember && !hasGuildPermission(botMember, guild, Permissions.MANAGE_ROLES)) {
          await message.reply({
            embeds: [
              Embed.danger('Missing Permission')
                .setDescription('The bot is missing the **Manage Roles** permission.\n\nPlease grant it in Server Settings and try again.')
                .toJSON(),
            ],
          });
          return;
        }

        const grantBlock = await roleGrantBlock(client, guildId, message.author.id, roleId);
        if (grantBlock) {
          await message.reply({ embeds: [Embed.denied(grantBlock).toJSON()] }).catch(() => {});
          return;
        }

        // Bot role hierarchy check (live API, not from cache).
        // Skip if botMember couldn't be fetched (admin case, trust the server config).
        if (botMember && !await botCanAssignRoleLive(client, botMember, guildId, roleId)) {
          await message.reply({
            embeds: [
              Embed.danger('Role Hierarchy Error')
                .setDescription(
                  `<@&${roleId}> is at or above the bot's highest role, so it cannot assign it.\n\n` +
                  'Move the bot\'s role **above** this role in **Server Settings → Roles** and try again.'
                )
                .toJSON(),
            ],
          });
          return;
        }

        const emoji = normaliseEmoji(rawEmoji);

        // Custom emoji must belong to this server
        if (isCustomEmoji(emoji)) {
          let guildEmojis = [];
          try { guildEmojis = await client.rest.get(`/guilds/${guildId}/emojis`); } catch { /* deny if fetch fails */ }
          const emojiId = emoji.split(':')[1];
          if (!guildEmojis.some(e => e.id === emojiId)) {
            await message.reply({
              embeds: [
                Embed.danger('Emoji Not Accessible')
                  .setDescription(`The bot cannot use **${rawEmoji}**. Custom emoji must belong to this server.`)
                  .toJSON(),
              ],
            });
            return;
          }
        }

        addReactionRole(guildId, messageId, emoji, roleId);

        const target = await fetchTargetMessage(client, messageId, message.channelId);
        if (target) await addReaction(client, target, emoji, guildId);

        await message.reply({
          embeds: [
            Embed.success('Reaction Role Added')
              .setDescription(`Users who react with **${rawEmoji}** will receive <@&${roleId}>.`)
              .addFields(
                { name: '💬  Message ID', value: `\`${messageId}\``,         inline: true },
                { name: '🎭  Emoji',      value: rawEmoji,                    inline: true },
                { name: '🏷️  Role',       value: `<@&${roleId}>`,            inline: true },
              )
              .toJSON(),
          ],
        });
        break;
      }

      // ── !rr remove <messageId> <emoji> ──────────────
      case 'remove': {
        const [messageId, rawEmoji] = rest;
        if (!messageId || !rawEmoji) {
          await message.reply({ embeds: [Embed.warning('Missing Arguments').setDescription(`Usage: \`${PREFIX}rr remove <messageId> <emoji>\``).toJSON()] }).catch(() => {});
          return;
        }

        const emoji = normaliseEmoji(rawEmoji);
        removeReactionRole(guildId, messageId, emoji);

        const target = await fetchTargetMessage(client, messageId, message.channelId);
        if (target) await removeReaction(client, target, emoji, guildId);

        await message.reply({
          embeds: [
            Embed.success('Reaction Role Removed')
              .setDescription(`The **${rawEmoji}** mapping has been removed from message \`${messageId}\`.`)
              .toJSON(),
          ],
        });
        break;
      }

      // ── !rr clear <messageId> ────────────────────────
      case 'clear': {
        const [messageId] = rest;
        if (!messageId) {
          await message.reply({ embeds: [Embed.warning('Missing Message ID').setDescription(`Usage: \`${PREFIX}rr clear <messageId>\``).toJSON()] }).catch(() => {});
          return;
        }

        const existing = getMappings(guildId, messageId);
        if (!existing.length) {
          await message.reply({ embeds: [Embed.info('No Mappings').setDescription(`No reaction roles are configured on message \`${messageId}\`.`).toJSON()] }).catch(() => {});
          return;
        }

        clearReactionRoles(guildId, messageId);

        const target = await fetchTargetMessage(client, messageId, message.channelId);
        if (target) {
          await Promise.allSettled(existing.map(r => removeReaction(client, target, r.emoji, guildId)));
        }

        await message.reply({
          embeds: [
            Embed.success('Reaction Roles Cleared')
              .setDescription(`Removed **${existing.length}** reaction role mapping(s) from message \`${messageId}\`.`)
              .toJSON(),
          ],
        });
        break;
      }

      // ── !rr relink <oldMessageId> <newMessageId> ─────
      // Moves every mapping onto a different message, e.g. the original got
      // reposted or moved and the old ID is now dead. Run this in the same
      // channel as the new message so its reactions get re-added, same
      // best-effort caveat as add/remove/clear above.
      case 'relink':
      case 'move': {
        const [oldMessageId, newMessageId] = rest;
        if (!oldMessageId || !newMessageId) {
          await message.reply({ embeds: [Embed.warning('Missing Arguments').setDescription(`Usage: \`${PREFIX}rr relink <oldMessageId> <newMessageId>\``).toJSON()] }).catch(() => {});
          return;
        }

        const existing = getMappings(guildId, oldMessageId);
        if (!existing.length) {
          await message.reply({ embeds: [Embed.info('No Mappings').setDescription(`No reaction roles are configured on message \`${oldMessageId}\`.`).toJSON()] }).catch(() => {});
          return;
        }

        const conflict = getMappings(guildId, newMessageId);
        if (conflict.length) {
          await message.reply({ embeds: [Embed.warning('Message Already In Use').setDescription(`Message \`${newMessageId}\` already has its own reaction role mapping(s). Clear them first with \`${PREFIX}rr clear ${newMessageId}\` if you want to merge.`).toJSON()] }).catch(() => {});
          return;
        }

        relinkMessage(guildId, oldMessageId, newMessageId);

        const target = await fetchTargetMessage(client, newMessageId, message.channelId);
        if (target) {
          await Promise.allSettled(existing.map(r => addReaction(client, target, r.emoji, guildId)));
        }

        await message.reply({
          embeds: [
            Embed.success('Reaction Roles Moved')
              .setDescription(
                `Moved **${existing.length}** mapping(s) from \`${oldMessageId}\` to \`${newMessageId}\`.` +
                (target ? '' : `\n\n⚠️ Couldn't find that message in this channel to re-add reactions. Run this command in the channel the new message is in, or add them manually.`)
              )
              .toJSON(),
          ],
        });
        break;
      }

      // ── !rr list [messageId] ─────────────────────────
      case 'list': {
        const [messageId] = rest;

        if (messageId) {
          const rows = getMappings(guildId, messageId);
          if (!rows.length) {
            await message.reply({ embeds: [Embed.info('No Mappings').setDescription(`No reaction roles configured on message \`${messageId}\`.`).toJSON()] }).catch(() => {});
            return;
          }

          const embed = Embed.info(`🎭  Reaction Roles: \`${messageId}\``)
            .setDescription(`${rows.length} mapping(s) on this message.`);

          for (const r of rows) {
            embed.addFields({ name: r.emoji, value: `<@&${r.role_id}>`, inline: true });
          }

          await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});

        } else {
          const rows = getAllForGuild(guildId);
          if (!rows.length) {
            await message.reply({ embeds: [Embed.info('No Reaction Roles').setDescription(`No reaction roles configured in this server yet.\n\nUse \`${PREFIX}rr add <messageId> <emoji> <@role>\` to add one.`).toJSON()] }).catch(() => {});
            return;
          }

          const grouped = {};
          for (const row of rows) {
            (grouped[row.message_id] ??= []).push({ emoji: row.emoji, roleId: row.role_id });
          }

          const embed = Embed.info(`🎭  Reaction Roles: ${rows.length} total`)
            .setDescription(`${Object.keys(grouped).length} message(s) with mappings.`);

          for (const [msgId, mappings] of Object.entries(grouped)) {
            embed.addFields({
              name:  `Message \`${msgId}\``,
              value: mappings.map(m => `${m.emoji} → <@&${m.roleId}>`).join('\n'),
              inline: false,
            });
          }

          await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
        }
        break;
      }

      // ── default: show reference ───────────────────────
      default:
        await message.reply({
          embeds: [
            Embed.info('🎭  Reaction Roles: Reference')
              .setDescription('Map emoji reactions to roles. Users react to gain the role, unreact to lose it.')
              .addFields(
                { name: `\`${PREFIX}rr add <messageId> <emoji> <@role>\``,  value: 'Add or overwrite a reaction → role mapping', inline: false },
                { name: `\`${PREFIX}rr remove <messageId> <emoji>\``,        value: 'Remove one mapping from a message',          inline: false },
                { name: `\`${PREFIX}rr clear <messageId>\``,                 value: 'Remove all mappings from a message',         inline: false },
                { name: `\`${PREFIX}rr relink <oldMsgId> <newMsgId>\``,      value: 'Move all mappings to a different message',   inline: false },
                { name: `\`${PREFIX}rr list [messageId]\``,                  value: 'List all guild mappings or one message',     inline: false },
              )
              .toJSON(),
          ],
        });
    }
  },
};