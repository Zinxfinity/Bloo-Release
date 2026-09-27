// ============================================================
//  commands/moderation/autorole.js
//  Category : Moderation  |  Requires Ban Members (default)
//
//  !autorole             , show current config
//  !autorole @Role       , set auto-role
//  !autorole off         , disable
//  !autorole bots on|off , also assign to bots
// ============================================================

import { Embed }                              from '../../config/embeds.js';
import db                                     from '../../db.js';
import { roleGrantBlock } from '../../utils/roleGrant.js';
import { Permissions } from '../../config/guildPermissions.js';

function parseRoleId(arg) {
  if (!arg) return null;
  return arg.match(/^<@&(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

function getAutorole(guildId) {
  return db.prepare(`
    SELECT autorole_id, autorole_enabled, autorole_bot FROM welcome_config WHERE guild_id = ?
  `).get(guildId) ?? { autorole_id: null, autorole_enabled: 0, autorole_bot: 0 };
}

function upsertAutorole(guildId, fields) {
  db.prepare(`
    INSERT INTO welcome_config (guild_id, autorole_id, autorole_enabled, autorole_bot)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      autorole_id      = excluded.autorole_id,
      autorole_enabled = excluded.autorole_enabled,
      autorole_bot     = excluded.autorole_bot
  `).run(guildId, fields.autorole_id ?? null, fields.autorole_enabled ?? 0, fields.autorole_bot ?? 0);
}

export default {
  name: 'autorole',
  aliases: ['joinrole'],
  description: 'Automatically assign a role when a member joins.',
  usage: '{prefix}autorole [@Role | off | bots <on|off>]',
  category: 'moderation',

  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    if (!guildId) { await message.reply({ embeds: [Embed.danger('Server only.').toJSON()] }).catch(() => {}); return; }

    const cfg = getAutorole(guildId);

    if (!args[0]) {
      await message.reply({
        embeds: [Embed.info('🎭  Auto-Role: Status')
          .addFields(
            { name: 'Status',         value: cfg.autorole_enabled ? '✅ Enabled' : '❌ Disabled',              inline: true },
            { name: 'Role',           value: cfg.autorole_id ? `<@&${cfg.autorole_id}>` : '❌ Not set',         inline: true },
            { name: 'Apply to Bots',  value: cfg.autorole_bot ? '✅ Yes' : '❌ No',                            inline: true },
          )
          .setFooter({ text: `${PREFIX}autorole @Role to set  |  ${PREFIX}autorole off to disable` })
          .toJSON()],
      });
      return;
    }

    if (args[0].toLowerCase() === 'off') {
      upsertAutorole(guildId, { ...cfg, autorole_enabled: 0 });
      await message.reply({ embeds: [Embed.warning('Auto-Role Disabled').setDescription('New members will no longer be auto-assigned a role.').toJSON()] }).catch(() => {});
      return;
    }

    if (args[0].toLowerCase() === 'bots') {
      const toggle = args[1]?.toLowerCase();
      if (toggle !== 'on' && toggle !== 'off') {
        await message.reply({ embeds: [Embed.warning('Usage').setDescription(`\`${PREFIX}autorole bots on|off\``).toJSON()] }).catch(() => {});
        return;
      }
      upsertAutorole(guildId, { ...cfg, autorole_bot: toggle === 'on' ? 1 : 0 });
      await message.reply({ embeds: [Embed.success(`Auto-Role Bots ${toggle === 'on' ? 'Enabled' : 'Disabled'}`).toJSON()] }).catch(() => {});
      return;
    }

    const roleId = parseRoleId(args[0]);
    if (!roleId) {
      await message.reply({ embeds: [Embed.warning('Invalid Role').setDescription(`Mention a role or provide its ID.\nUsage: \`${PREFIX}autorole @Role\``).toJSON()] }).catch(() => {});
      return;
    }

    const grantBlock = await roleGrantBlock(client, guildId, message.author.id, roleId);
    if (grantBlock) {
      await message.reply({ embeds: [Embed.denied(grantBlock).toJSON()] }).catch(() => {});
      return;
    }

    upsertAutorole(guildId, { autorole_id: roleId, autorole_enabled: 1, autorole_bot: cfg.autorole_bot });
    await message.reply({
      embeds: [Embed.success('✅  Auto-Role Set')
        .addFields(
          { name: 'Role',          value: `<@&${roleId}>`,                                                     inline: true },
          { name: 'Apply to Bots', value: cfg.autorole_bot ? 'Yes' : `No. Use \`${PREFIX}autorole bots on\` to change`, inline: false },
        ).toJSON()],
    });
  },
};
