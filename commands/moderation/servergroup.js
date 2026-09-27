// ============================================================
//  commands/moderation/servergroup.js
//  Category : Moderation
//
//  Manage "server groups", named collections of guilds that opt
//  in to share ban/unban syncing (handlers/banSync.js). A ban (or
//  unban) executed in one member guild is replicated to every
//  other guild in the same group, provided both sides have the
//  relevant sync toggle enabled.
//
//  !servergroup create <name>                           , create a group (this guild joins it)
//  !servergroup delete <groupId>                         , delete a group (creator/Bot Owner only)
//  !servergroup add <groupId> [bans=on/off] [unbans=on/off], add this guild to a group
//  !servergroup remove <groupId>                         , remove this guild from a group
//  !servergroup sync <groupId> <bans|unbans> <on|off>    , adjust this guild's toggle
//  !servergroup list                                     , groups this guild belongs to
//  !servergroup listall                                  , all groups, all guilds (Bot Owner only)
//
//  Gate: custom, not requiredPermission-based, `list` is viewable by anyone,
//  `listall` is bot-owner-only, everything else needs Ban Members or higher
//  (configurable per guild via resolveAccess, same mechanism ban.js itself uses).
// ============================================================

import { Embed } from '../../config/embeds.js';
import { resolveAccess } from '../../handlers/commandPermissions.js';
import { isBotOwner } from '../../handlers/staffSystem.js';
import { Permissions } from '../../config/guildPermissions.js';
import {
  createGroup, getGroup, deleteGroup,
  addGuildToGroup, removeGuildFromGroup, setSyncToggle,
  getGroupsForGuild, getGroupMembers, listGroups,
} from '../../handlers/serverGroups.js';
import { SERVER_GROUPS_ENABLED } from '../../handlers/banSync.js';

function parseToggle(str) {
  if (str === undefined) return undefined;
  const lower = str.toLowerCase();
  if (lower === 'on' || lower === 'true' || lower === '1')  return true;
  if (lower === 'off' || lower === 'false' || lower === '0') return false;
  return undefined;
}

function parseFlags(rest) {
  // Accepts `bans=on unbans=off` style flags in any order
  const flags = {};
  for (const arg of rest) {
    const m = arg.match(/^(bans|unbans)=(on|off|true|false|1|0)$/i);
    if (m) flags[m[1].toLowerCase()] = parseToggle(m[2]);
  }
  return flags;
}

export default {
  name: 'servergroup',
  aliases: ['sgroup', 'bansync'],
  description: 'Create/manage server groups for cross-server ban syncing.',
  usage: '{prefix}servergroup <create | delete | add | remove | sync | list | listall> [args]',
  category: 'moderation',

  requiredPermission: null, // custom gate below, per subcommand
  internalAccess: true, // subcommands gate themselves via resolveAccess
  hidden: !SERVER_GROUPS_ENABLED,

  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    const userId  = message.author.id;

    if (!SERVER_GROUPS_ENABLED && !isBotOwner(userId)) {
      await message.reply({ embeds: [Embed.info('Cross-server ban syncing is currently disabled.', 'Server Groups Disabled').toJSON()] }).catch(() => {});
      return;
    }

    if (!guildId) {
      await message.reply({ embeds: [Embed.danger('This command can only be used inside a server.', 'Server Only').toJSON()] }).catch(() => {});
      return;
    }

    const [sub, ...rest] = args;
    const subLower = sub?.toLowerCase();

    // ── !servergroup list, viewable by anyone, no gate ───────────────────────
    if (subLower === 'list') {
      const groups = getGroupsForGuild(guildId);
      if (!groups.length) {
        await message.reply({ embeds: [Embed.info("This server isn't in any server group yet.", 'No Server Groups').toJSON()] }).catch(() => {});
        return;
      }
      const embed = Embed.info(`🔗  Server Groups for this Guild (${groups.length})`);
      for (const g of groups) {
        embed.addFields({
          name:  `${g.name}  \`${g.id}\``,
          value: `Bans: ${g.sync_bans ? '✅ sync' : '❌ off'} · Unbans: ${g.sync_unbans ? '✅ sync' : '❌ off'}`,
          inline: false,
        });
      }
      await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
      return;
    }

    // ── !servergroup listall, Bot Owner only ─────────────────────────────────
    if (subLower === 'listall') {
      if (!isBotOwner(userId)) {
        await message.reply({ embeds: [Embed.denied('Bot Owner only.').toJSON()] }).catch(() => {});
        return;
      }
      const all = listGroups();
      if (!all.length) {
        await message.reply({ embeds: [Embed.info('No server groups exist yet.', 'No Server Groups').toJSON()] }).catch(() => {});
        return;
      }
      const embed = Embed.info(`🔗  All Server Groups (${all.length})`);
      for (const g of all) {
        const memberCount = getGroupMembers(g.id).length;
        embed.addFields({ name: `${g.name}  \`${g.id}\``, value: `${memberCount} guild(s) · created by <@${g.created_by}>`, inline: false });
      }
      await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
      return;
    }

    // ── Gate: Ban Members or higher for all management actions below ────────
    if (!(await resolveAccess(client, guildId, userId, 'servergroup', Permissions.BAN_MEMBERS))) {
      await message.reply({ embeds: [Embed.denied('Ban Members or higher required.').toJSON()] }).catch(() => {});
      return;
    }

    // ── !servergroup create <name> ────────────────────────────
    if (subLower === 'create') {
      const name = rest.join(' ').trim();
      if (!name) { await message.reply(`> ❌ Usage: \`${PREFIX}servergroup create <name>\``); return; }
      const groupId = createGroup(name, userId);
      addGuildToGroup(groupId, guildId, userId, { syncBans: true, syncUnbans: true });
      await message.reply({ embeds: [Embed.success('Server Group Created')
        .setDescription(`Group **${name}** created (\`${groupId}\`), this server has been added as its first member.\n\nOther server owners/moderators can join with:\n\`${PREFIX}servergroup add ${groupId}\``)
        .toJSON()] });
      return;
    }

    // ── !servergroup delete <groupId> ─────────────────────────
    if (subLower === 'delete') {
      const groupId = rest[0];
      const group   = groupId ? getGroup(groupId) : null;
      if (!group) { await message.reply(`> ❌ Usage: \`${PREFIX}servergroup delete <groupId>\`, group not found.`); return; }
      if (group.created_by !== userId && !isBotOwner(userId)) {
        await message.reply(`> ❌ Only the group's creator or a Bot Owner can delete it.`); return;
      }
      deleteGroup(groupId);
      await message.reply(`> ✅ Server group **${group.name}** deleted.`);
      return;
    }

    // ── !servergroup add <groupId> [bans=on/off] [unbans=on/off] ─
    if (subLower === 'add') {
      const groupId = rest[0];
      const group   = groupId ? getGroup(groupId) : null;
      if (!group) { await message.reply(`> ❌ Usage: \`${PREFIX}servergroup add <groupId> [bans=on/off] [unbans=on/off]\`, group not found.`); return; }
      const flags = parseFlags(rest.slice(1));
      addGuildToGroup(groupId, guildId, userId, {
        syncBans:   flags.bans   ?? true,
        syncUnbans: flags.unbans ?? true,
      });
      await message.reply({ embeds: [Embed.success('Guild Added to Server Group')
        .setDescription(`This server has joined **${group.name}**.\n\nBans: ${(flags.bans ?? true) ? '✅ syncing' : '❌ off'} · Unbans: ${(flags.unbans ?? true) ? '✅ syncing' : '❌ off'}`)
        .toJSON()] });
      return;
    }

    // ── !servergroup remove <groupId> ─────────────────────────
    if (subLower === 'remove') {
      const groupId = rest[0];
      const group   = groupId ? getGroup(groupId) : null;
      if (!group) { await message.reply(`> ❌ Usage: \`${PREFIX}servergroup remove <groupId>\`, group not found.`); return; }
      const removed = removeGuildFromGroup(groupId, guildId);
      await message.reply(removed
        ? `> ✅ This server has left **${group.name}**.`
        : `> ❌ This server isn't a member of **${group.name}**.`);
      return;
    }

    // ── !servergroup sync <groupId> <bans|unbans> <on|off> ────
    if (subLower === 'sync') {
      const groupId  = rest[0];
      const fieldArg = rest[1]?.toLowerCase();
      const valueArg = rest[2];
      const field    = fieldArg === 'bans' ? 'sync_bans' : fieldArg === 'unbans' ? 'sync_unbans' : null;
      const value    = parseToggle(valueArg);
      const group    = groupId ? getGroup(groupId) : null;
      if (!group || !field || value === undefined) {
        await message.reply(`> ❌ Usage: \`${PREFIX}servergroup sync <groupId> <bans|unbans> <on|off>\``);
        return;
      }
      const updated = setSyncToggle(groupId, guildId, field, value);
      await message.reply(updated
        ? `> ✅ ${fieldArg} sync ${value ? 'enabled' : 'disabled'} for this server in **${group.name}**.`
        : `> ❌ This server isn't a member of **${group.name}**, join it first with \`${PREFIX}servergroup add ${groupId}\`.`);
      return;
    }

    // ── Help fallback ──────────────────────────────────────────
    await message.reply({ embeds: [Embed.info('🔗  Server Group Commands')
      .setDescription('Manage cross-server ban syncing.')
      .addFields(
        { name: `\`${PREFIX}servergroup create <name>\``, value: 'Create a group (this server joins it)', inline: false },
        { name: `\`${PREFIX}servergroup add <groupId> [bans=on/off] [unbans=on/off]\``, value: 'Add this server to a group', inline: false },
        { name: `\`${PREFIX}servergroup remove <groupId>\``, value: 'Remove this server from a group', inline: false },
        { name: `\`${PREFIX}servergroup sync <groupId> <bans|unbans> <on|off>\``, value: "Adjust this server's sync toggle", inline: false },
        { name: `\`${PREFIX}servergroup delete <groupId>\``, value: 'Delete a group (creator/Bot Owner only)', inline: false },
        { name: `\`${PREFIX}servergroup list\``, value: 'List groups this server belongs to', inline: false },
        { name: `\`${PREFIX}servergroup listall\``, value: 'List all groups (Bot Owner only)', inline: false },
      )
      .toJSON()] });
  },
};
