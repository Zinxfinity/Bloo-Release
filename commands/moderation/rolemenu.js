// ============================================================
//  commands/moderation/rolemenu.js
//  Category : Moderation  |  Access 0  |  Requires Ban Members (default)
//
//  Post a fully customisable role-selection menu driven by
//  reaction buttons on a persistent embed.
//
//  Users react to pick a role, reaction is removed immediately,
//  role is toggled (add if missing, remove if present).
//
//  !rolemenu create <title>           , start a new menu (guided)
//  !rolemenu add <menuId> <@role> <emoji> <description>
//  !rolemenu remove <menuId> <@role>  , remove a role from menu
//  !rolemenu post <menuId> [#channel] , post / repost embed
//  !rolemenu delete <menuId>          , delete menu + embed
//  !rolemenu list                     , list all menus
//  !rolemenu config <menuId> <option> <value>
//     options: title | description | color | maxroles | exclusive
//  !rolemenu status <menuId>          , show full config
//
//  Config options:
//    title      , embed title
//    description, embed description (supports [\n])
//    color      , hex color e.g. #5865F2
//    maxroles   , max roles a user can hold from this menu (0 = unlimited)
//    exclusive  , true/false, if true picking one removes all others
//
//  Gate 1 : accessLevel 0
//  Gate 2 : requiredPermission BAN_MEMBERS, configurable
// ============================================================

import { EmbedBuilder }              from '@fluxerjs/core';
import { Embed, COLORS }                     from '../../config/embeds.js';
import db                                    from '../../db.js';
import { roleGrantBlock } from '../../utils/roleGrant.js';
import { resolveShortcode }                  from '../../config/emojiMap.js';
import { Permissions } from '../../config/guildPermissions.js';
import { emojiRoute } from '../../handlers/reactionRoles.js';
// Schema owner for role_menus / role_menu_entries (see that file's header);
// imported here so the tables exist with every column before this command's
// queries run, whichever process or module touches them first.
import '../../handlers/rolemenus.js';

// ── DB helpers ────────────────────────────────────────────────
function getMenu(id, guildId) {
  return db.prepare(`SELECT * FROM role_menus WHERE id = ? AND guild_id = ?`).get(id, guildId);
}
function getMenuEntries(menuId) {
  return db.prepare(`SELECT * FROM role_menu_entries WHERE menu_id = ? ORDER BY position`).all(menuId);
}
function getMenuByMessage(messageId) {
  return db.prepare(`SELECT * FROM role_menus WHERE message_id = ?`).get(messageId);
}
export { getMenuByMessage, getMenuEntries };

function getAllMenus(guildId) {
  return db.prepare(`SELECT * FROM role_menus WHERE guild_id = ?`).all(guildId);
}

// Convert stored emoji key back to a renderable Fluxer string:
//   "name:id"    → <:name:id>   (standard custom emoji)
//   "a_name:id"  → <a:name:id>  (animated custom emoji, name starts with a_)
//   anything else → raw unicode (already renderable)
function emojiDisplay(stored) {
  const match = stored.match(/^(a_)?(\w+):(\d+)$/);
  if (!match) return stored;
  const animated = match[1] ? 'a' : '';
  return `<${animated}:${match[2]}:${match[3]}>`;
}

// ── Embed builder ─────────────────────────────────────────────
function buildMenuEmbed(menu, entries) {
  const desc = (menu.description || '').replace(/\[\\n\]/g, '\n');
  const entryLines = entries.map(e => `${emojiDisplay(e.emoji)}  <@&${e.role_id}>${e.description ? `: ${e.description}` : ''}`);

  const embed = new EmbedBuilder()
    .setTitle(menu.title)
    .setColor(menu.color ?? 0x5865F2)
    .setDescription(
      (desc ? desc + '\n\n' : '') +
      (entryLines.length ? entryLines.join('\n') : '*No roles configured yet.*')
    );

  const notes = [];
  if (menu.exclusive)          notes.push('Only one role can be held at a time.');
  const maxPicks = menu.max_picks ?? menu.max_roles ?? 0;
  if (maxPicks > 0 && !menu.exclusive) notes.push(`Maximum ${maxPicks} role(s) from this menu.`);

  if (notes.length) embed.setFooter({ text: notes.join(' • ') });
  return embed;
}

// ── Helpers ───────────────────────────────────────────────────
// Normalise emoji to the same format emojiKey() produces in reactionAdd.js:
//   Custom  → "name:id"   (strips <a?:name:id> wrapper)
//   Unicode → raw char with U+FE0F stripped
// This ensures DB values always match what the reaction event emits.
function normaliseEmoji(raw) {
  // a_ prefix kept for animated emoji, the same key emojiKey() builds from a
  // reaction (matching itself is by emoji ID, see handlers/reactionRoles.js).
  const custom = raw.match(/^<(a?):(\w+):(\d+)>$/);
  if (custom) return `${custom[1] ? 'a_' : ''}${custom[2]}:${custom[3]}`;
  // canonicalEmoji()/emojiKey() expects an emoji OBJECT ({name, id}) from the
  // Fluxer reaction event, not a string, passing resolveShortcode's string
  // result through it always resolved to '' (no .name property on a string),
  // which is why every unicode role-menu mapping was silently unusable.
  return resolveShortcode(raw);
}

function parseRoleId(arg) {
  if (!arg) return null;
  return arg.match(/^<@&(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}
function hexToInt(hex) {
  const n = parseInt(hex.replace(/^#/, ''), 16);
  return isNaN(n) ? null : n;
}

export default {
  name: 'rolemenu',
  aliases: ['rmenu', 'rm'],
  description: 'Create and manage reaction role menus where members pick their own roles.',
  usage: '{prefix}rolemenu <create | add | remove | list | config | post | delete | status> [args]',
  category: 'moderation',

  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    if (!guildId) return;

    const [sub, ...rest] = args;

    switch (sub?.toLowerCase()) {

      // ── create <title> ───────────────────────────────────────
      case 'create': {
        const title = rest.join(' ').trim() || 'Role Menu';
        const result = db.prepare(`
          INSERT INTO role_menus (guild_id, title) VALUES (?, ?)
        `).run(guildId, title);
        const id = result.lastInsertRowid;
        await message.reply({
          embeds: [Embed.success('Role Menu Created')
            .setDescription(
              `Menu **#${id}** created with title **${title}**.\n\n` +
              `**Next steps:**\n` +
              `\`${PREFIX}rolemenu add ${id} <@role> <emoji> [description]\`: add roles\n` +
              `\`${PREFIX}rolemenu config ${id} <option> <value>\`: customise\n` +
              `\`${PREFIX}rolemenu post ${id} [#channel]\`: post the menu`
            )
            .toJSON()],
        });
        break;
      }

      // ── add <menuId> <@role> <emoji> [description] ───────────
      case 'add': {
        const [menuIdStr, roleArg, emoji, ...descParts] = rest;
        const menuId = parseInt(menuIdStr, 10);
        if (isNaN(menuId)) { await message.reply(`❌ Usage: \`${PREFIX}rolemenu add <menuId> <@role> <emoji> [description]\``); return; }

        const menu = getMenu(menuId, guildId);
        if (!menu) { await message.reply({ embeds: [Embed.warning('Not Found').setDescription(`No menu with ID \`${menuId}\` in this server.`).toJSON()] }); return; }

        const roleId = parseRoleId(roleArg);
        if (!roleId) { await message.reply(`❌ Provide a valid role mention or ID.`); return; }
        if (!emoji)  { await message.reply(`❌ Provide an emoji for this role.`); return; }
        const grantBlock = await roleGrantBlock(client, guildId, message.author.id, roleId);
        if (grantBlock) { await message.reply({ embeds: [Embed.denied(grantBlock).toJSON()] }).catch(() => {}); return; }

        const entries = getMenuEntries(menuId);
        if (entries.length >= 20) { await message.reply({ embeds: [Embed.warning('Max Entries').setDescription('A menu can have at most **20** roles.').toJSON()] }); return; }

        const normEmoji = normaliseEmoji(emoji);
        if (entries.find(e => e.emoji === normEmoji)) { await message.reply(`❌ That emoji is already used in this menu.`); return; }

        const description = descParts.join(' ').trim();
        // label is NOT NULL on a fresh install (handlers/rolemenus.js owns
        // that table too, its own embed builder shows it as bold text);
        // without it, entries created here render blank there.
        db.prepare(`
          INSERT OR REPLACE INTO role_menu_entries (menu_id, guild_id, role_id, emoji, label, description, position)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(menuId, guildId, roleId, normEmoji, `<@&${roleId}>`, description, entries.length);

        await message.reply({ embeds: [Embed.success('Entry Added').setDescription(`${emoji} <@&${roleId}>${description ? `: ${description}` : ''} added to menu **#${menuId}**.\nRun \`${PREFIX}rolemenu post ${menuId}\` to repost.`).toJSON()] }).catch(() => {});
        break;
      }

      // ── remove <menuId> <@role> ──────────────────────────────
      case 'remove': {
        const [menuIdStr, roleArg] = rest;
        const menuId = parseInt(menuIdStr, 10);
        const menu   = getMenu(menuId, guildId);
        if (!menu) { await message.reply({ embeds: [Embed.warning('Not Found').setDescription(`Menu \`${menuId}\` not found.`).toJSON()] }); return; }

        const roleId = parseRoleId(roleArg);
        if (!roleId) { await message.reply(`❌ Provide a valid role.`); return; }

        const result = db.prepare(`DELETE FROM role_menu_entries WHERE menu_id = ? AND role_id = ?`).run(menuId, roleId);
        if (!result.changes) { await message.reply({ embeds: [Embed.warning('Not Found').setDescription(`That role is not in menu **#${menuId}**.`).toJSON()] }); return; }

        await message.reply({ embeds: [Embed.success('Entry Removed').setDescription(`<@&${roleId}> removed from menu **#${menuId}**.\nRun \`${PREFIX}rolemenu post ${menuId}\` to repost.`).toJSON()] }).catch(() => {});
        break;
      }

      // ── config <menuId> <option> <value> ─────────────────────
      case 'edit':   // alias for config
      case 'config': {
        const [menuIdStr, option, ...valParts] = rest;
        const menuId = parseInt(menuIdStr, 10);
        const menu   = getMenu(menuId, guildId);
        if (!menu) { await message.reply({ embeds: [Embed.warning('Not Found').setDescription(`Menu \`${menuId}\` not found.`).toJSON()] }); return; }

        const value = valParts.join(' ').trim();
        if (!option || !value) {
          await message.reply({ embeds: [Embed.info('Config Options').setDescription([
            `\`title <text>\`: embed title`,
            `\`description <text>\`: embed description (use [\\n] for newlines)`,
            `\`color <#hex>\`: embed accent color`,
            `\`maxroles <n>\`: max roles per user (0 = unlimited)`,
            `\`exclusive <true|false>\`: picking one removes others`,
          ].join('\n')).toJSON()] });
          return;
        }

        switch (option.toLowerCase()) {
          case 'title':
            db.prepare(`UPDATE role_menus SET title = ? WHERE id = ?`).run(value.slice(0, 100), menuId);
            await message.reply(`✅ Title updated.`).catch(() => {});
            break;
          case 'description':
            db.prepare(`UPDATE role_menus SET description = ? WHERE id = ?`).run(value.slice(0, 2000), menuId);
            await message.reply(`✅ Description updated.`).catch(() => {});
            break;
          case 'color': {
            const color = hexToInt(value);
            if (color === null) { await message.reply(`❌ Invalid hex color. Example: \`#5865F2\``); return; }
            db.prepare(`UPDATE role_menus SET color = ? WHERE id = ?`).run(color, menuId);
            await message.reply(`✅ Color updated.`).catch(() => {});
            break;
          }
          case 'maxroles': {
            const n = parseInt(value, 10);
            if (isNaN(n) || n < 0) { await message.reply(`❌ Provide a number ≥ 0. (0 = unlimited)`); return; }
            // max_picks, not max_roles, is what events/guild/reactionAdd.js's
            // limit enforcement actually reads. Writing only max_roles (as
            // this used to) meant the limit displayed as configured but was
            // never applied, keep both in sync.
            db.prepare(`UPDATE role_menus SET max_roles = ?, max_picks = ? WHERE id = ?`).run(n, n, menuId);
            await message.reply(`✅ Max roles set to **${n === 0 ? 'unlimited' : n}**.`).catch(() => {});
            break;
          }
          case 'exclusive': {
            const v = value.toLowerCase();
            if (!['true', 'false', '1', '0'].includes(v)) { await message.reply(`❌ Use \`true\` or \`false\`.`); return; }
            db.prepare(`UPDATE role_menus SET exclusive = ? WHERE id = ?`).run(v === 'true' || v === '1' ? 1 : 0, menuId);
            await message.reply(`✅ Exclusive mode **${v === 'true' || v === '1' ? 'enabled' : 'disabled'}**.`).catch(() => {});
            break;
          }
          default:
            await message.reply(`❌ Unknown option \`${option}\`. Valid: \`title\` \`description\` \`color\` \`maxroles\` \`exclusive\``).catch(() => {});
        }
        break;
      }

      // ── post <menuId> [#channel] ─────────────────────────────
      case 'post': {
        const [menuIdStr, channelArg] = rest;
        const menuId = parseInt(menuIdStr, 10);
        const menu   = getMenu(menuId, guildId);
        if (!menu) { await message.reply({ embeds: [Embed.warning('Not Found').setDescription(`Menu \`${menuId}\` not found.`).toJSON()] }); return; }

        const entries = getMenuEntries(menuId);
        if (!entries.length) { await message.reply({ embeds: [Embed.warning('No Entries').setDescription(`Add roles first with \`${PREFIX}rolemenu add ${menuId} <@role> <emoji>\`.`).toJSON()] }); return; }

        // Resolve channel
        const channelId = channelArg?.match(/^<#(\d+)>$/)?.[1] ?? channelArg ?? menu.channel_id ?? message.channelId;

        // Delete old message if exists
        if (menu.message_id && menu.channel_id) {
          try { await client.rest.delete(`/channels/${menu.channel_id}/messages/${menu.message_id}`); } catch { /* gone */ }
        }

        const embed = buildMenuEmbed(menu, entries);
        let msg;
        try {
          // Raw REST, not client.channels.fetch() + channel.send(): confirmed
          // in production that pattern fails with "channel.send is not a
          // function" for at least one channel type on v2.0.1's SDK.
          msg = await client.rest.post(`/channels/${channelId}/messages`, { body: { embeds: [embed.toJSON()] } });
        } catch (err) {
          await message.reply({ embeds: [Embed.danger('Send Failed').setDescription(`Could not post menu in <#${channelId}>: ${err.message}`).toJSON()] }).catch(() => {});
          return;
        }

        // Add reactions via REST PUT, msg.react() is broken in FluxerJS.
        // Stored format: "name:id" for custom emoji, raw unicode for standard emoji.
        const reactFailed = [];
        for (const entry of entries) {
          try {
            const emojiKey = emojiRoute(entry.emoji);
            await client.rest.put(
              `/channels/${msg.channelId ?? msg.channel_id}/messages/${msg.id}/reactions/${emojiKey}/@me`
            );
          } catch (err) {
            console.warn(`[RM] react failed for menu #${menuId} emoji ${entry.emoji}: ${err.message}`);
            reactFailed.push(entry.emoji);
          }
        }

        db.prepare(`UPDATE role_menus SET channel_id = ?, message_id = ? WHERE id = ?`).run(channelId, msg.id, menuId);

        const successDesc = `Menu **#${menuId}** posted in <#${channelId}>.\nMessage ID: \`${msg.id}\`` +
          (reactFailed.length
            ? `\n\n⚠️ ${reactFailed.length} reaction(s) failed, bot may lack access to: ${reactFailed.join(', ')}`
            : '');
        if (reactFailed.length) console.warn(`[RM] react failures for menu #${menuId}: ${reactFailed.join(', ')}`);
        await message.reply({ embeds: [Embed.success('Role Menu Posted').setDescription(successDesc).toJSON()] }).catch(() => {});
        break;
      }

      // ── delete <menuId> ──────────────────────────────────────
      case 'delete': {
        const menuId = parseInt(rest[0], 10);
        const menu   = getMenu(menuId, guildId);
        if (!menu) { await message.reply({ embeds: [Embed.warning('Not Found').setDescription(`Menu \`${menuId}\` not found.`).toJSON()] }); return; }

        if (menu.message_id && menu.channel_id) {
          try { await client.rest.delete(`/channels/${menu.channel_id}/messages/${menu.message_id}`); } catch { /* gone */ }
        }

        db.prepare(`DELETE FROM role_menu_entries WHERE menu_id = ?`).run(menuId);
        db.prepare(`DELETE FROM role_menus WHERE id = ?`).run(menuId);
        await message.reply({ embeds: [Embed.success('Menu Deleted').setDescription(`Menu **#${menuId}** and all its entries have been deleted.`).toJSON()] }).catch(() => {});
        break;
      }

      // ── list ─────────────────────────────────────────────────
      case 'list': {
        const menus = getAllMenus(guildId);
        if (!menus.length) { await message.reply({ embeds: [Embed.info('No Menus').setDescription(`No role menus yet. Create one with \`${PREFIX}rolemenu create <title>\`.`).toJSON()] }); return; }
        const lines = menus.map(m => {
          const entries = getMenuEntries(m.id);
          const posted  = m.message_id ? `📌 <#${m.channel_id}>` : '📭 Not posted';
          return `**#${m.id}**: ${m.title} (${entries.length} roles) ${posted}`;
        });
        await message.reply({ embeds: [new EmbedBuilder().setTitle('🎭  Role Menus').setColor(COLORS.INFO).setDescription(lines.join('\n')).toJSON()] }).catch(() => {});
        break;
      }

      // ── status <menuId> ──────────────────────────────────────
      case 'status': {
        const menuId = parseInt(rest[0], 10);
        const menu   = getMenu(menuId, guildId);
        if (!menu) { await message.reply({ embeds: [Embed.warning('Not Found').setDescription(`Menu \`${menuId}\` not found.`).toJSON()] }); return; }

        const entries = getMenuEntries(menuId);
        const embed   = new EmbedBuilder()
          .setTitle(`🎭  Menu #${menuId}: ${menu.title}`)
          .setColor(menu.color ?? 0x5865F2)
          .addFields(
            { name: 'Color',      value: `#${(menu.color ?? 0x5865F2).toString(16).padStart(6, '0')}`, inline: true },
            { name: 'Max Roles',  value: (menu.max_picks ?? menu.max_roles ?? 0) === 0 ? 'Unlimited' : `${menu.max_picks ?? menu.max_roles}`, inline: true },
            { name: 'Exclusive',  value: menu.exclusive ? 'Yes' : 'No',                            inline: true },
            { name: 'Channel',    value: menu.channel_id ? `<#${menu.channel_id}>` : 'Not posted', inline: true },
            { name: 'Message ID', value: menu.message_id ? `\`${menu.message_id}\`` : 'N/A',       inline: true },
            { name: `Entries (${entries.length})`,
              value: entries.length
                ? entries.map(e => `${emojiDisplay(e.emoji)} <@&${e.role_id}>${e.description ? `: ${e.description}` : ''}`).join('\n')
                : 'None',
              inline: false },
          );
        if (menu.description) embed.setDescription(menu.description.replace(/\[\\n\]/g, '\n').slice(0, 200));
        await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
        break;
      }

      default:
        await message.reply({ embeds: [Embed.info('🎭  Role Menu: Usage').setDescription([
          `\`${PREFIX}rolemenu create <title>\`: create a new menu`,
          `\`${PREFIX}rolemenu add <id> <@role> <emoji> [desc]\`: add a role`,
          `\`${PREFIX}rolemenu remove <id> <@role>\`: remove a role`,
          `\`${PREFIX}rolemenu config <id> <option> <value>\`: configure`,
          `\`${PREFIX}rolemenu post <id> [#channel]\`: post / repost`,
          `\`${PREFIX}rolemenu delete <id>\`: delete menu`,
          `\`${PREFIX}rolemenu list\`: list all menus`,
          `\`${PREFIX}rolemenu status <id>\`: show full config`,
        ].join('\n')).toJSON()] });
    }
  },
};