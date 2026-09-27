// ============================================================
//  commands/utility/welcome.js
//  Category : Utility  |  Requires Ban Members
//
//  !welcome                               , show current config
//  !welcome channel <#channel|off>        , set welcome channel
//  !welcome message <text>                , set welcome message
//  !welcome goodbye channel <#channel|off>
//  !welcome goodbye message <text>
//  !welcome autorole <@role|off>          , set auto-role on join
//  !welcome test                          , preview welcome message
//
//  Placeholders: {user} {username} {server} {membercount}
// ============================================================

import { EmbedBuilder }      from '@fluxerjs/core';
import { Embed, COLORS }     from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';
import {
  getWelcomeConfig, setWelcomeField,
} from '../../handlers/welcomeSystem.js';

function parseId(arg) {
  return arg?.match(/^[#@&!]+(\d+)>$/)?.[1] ?? (arg?.match(/^\d{17,20}$/) ? arg : null);
}

function onOff(val) { return val ? '✅ Enabled' : '❌ Disabled'; }

export default {
  name: 'welcome',
  aliases: ['goodbye'],
  description: 'Configure welcome/goodbye messages and auto-role.',
  usage: '{prefix}welcome [channel|message|goodbye|autorole|test]',
  category: 'utility',

  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 5,

  async execute({ message, args, prefix, client }) {
    const guildId = message.guildId;
    const cfg = getWelcomeConfig(guildId);
    const sub = args[0]?.toLowerCase();

    // ── Status (no subcommand) ────────────────────────────────────────────
    if (!sub || sub === 'status') {
      const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle('Welcome System: Config')
        .addFields(
          { name: 'Welcome',         value: onOff(cfg.welcome_enabled),                                       inline: true },
          { name: 'Welcome Channel', value: cfg.welcome_channel_id ? `<#${cfg.welcome_channel_id}>` : 'Not set',   inline: true },
          { name: 'Goodbye',         value: onOff(cfg.goodbye_enabled),                                       inline: true },
          { name: 'Goodbye Channel', value: cfg.goodbye_channel_id ? `<#${cfg.goodbye_channel_id}>` : 'Not set',   inline: true },
          { name: 'Auto-Role',       value: cfg.autorole_id ? `<@&${cfg.autorole_id}>` : 'Not set',          inline: true },
          { name: 'DM Welcome',      value: onOff(cfg.dm_enabled),                                            inline: true },
          { name: 'Welcome Message', value: cfg.welcome_message?.slice(0, 200) ?? 'Default',                  inline: false },
          { name: 'Goodbye Message', value: cfg.goodbye_message?.slice(0, 200) ?? 'Default',                  inline: false },
        );
      return message.reply({ embeds: [embed.toJSON()] });
    }

    // ── welcome channel ───────────────────────────────────────────────────
    if (sub === 'channel') {
      const val = args[1]?.toLowerCase();
      if (val === 'off') {
        setWelcomeField(guildId, 'welcome_enabled', 0);
        setWelcomeField(guildId, 'welcome_channel_id', null);
        return message.reply({ embeds: [Embed.success('Welcome messages disabled.').toJSON()] });
      }
      const chId = parseId(args[1]) ?? args[1]?.replace(/\D/g, '');
      if (!chId) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}welcome channel #channel\``).toJSON()] });
      setWelcomeField(guildId, 'welcome_channel_id', chId);
      setWelcomeField(guildId, 'welcome_enabled', 1);
      return message.reply({ embeds: [Embed.success(`Welcome channel set to <#${chId}>.`).toJSON()] });
    }

    // ── welcome message ───────────────────────────────────────────────────
    if (sub === 'message') {
      const text = args.slice(1).join(' ');
      if (!text) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}welcome message <text>\`\nPlaceholders: {user} {username} {server} {membercount}`).toJSON()] });
      setWelcomeField(guildId, 'welcome_message', text);
      return message.reply({ embeds: [Embed.success('Welcome message updated.').toJSON()] });
    }

    // ── goodbye ───────────────────────────────────────────────────────────
    if (sub === 'goodbye') {
      const sub2 = args[1]?.toLowerCase();
      if (sub2 === 'channel') {
        if (args[2]?.toLowerCase() === 'off') {
          setWelcomeField(guildId, 'goodbye_enabled', 0);
          setWelcomeField(guildId, 'goodbye_channel_id', null);
          return message.reply({ embeds: [Embed.success('Goodbye messages disabled.').toJSON()] });
        }
        const chId = parseId(args[2]) ?? args[2]?.replace(/\D/g, '');
        if (!chId) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}welcome goodbye channel #channel\``).toJSON()] });
        setWelcomeField(guildId, 'goodbye_channel_id', chId);
        setWelcomeField(guildId, 'goodbye_enabled', 1);
        return message.reply({ embeds: [Embed.success(`Goodbye channel set to <#${chId}>.`).toJSON()] });
      }
      if (sub2 === 'message') {
        const text = args.slice(2).join(' ');
        if (!text) return message.reply({ embeds: [Embed.warning('Provide a goodbye message.').toJSON()] });
        setWelcomeField(guildId, 'goodbye_message', text);
        return message.reply({ embeds: [Embed.success('Goodbye message updated.').toJSON()] });
      }
      return message.reply({ embeds: [Embed.warning('Subcommands: `channel`, `message`').toJSON()] });
    }

    // ── autorole ──────────────────────────────────────────────────────────
    if (sub === 'autorole') {
      const val = args[1]?.toLowerCase();
      if (val === 'off') {
        setWelcomeField(guildId, 'autorole_id', null);
      setWelcomeField(guildId, 'autorole_enabled', 0);
        return message.reply({ embeds: [Embed.success('Auto-role disabled.').toJSON()] });
      }
      const roleId = parseId(args[1]) ?? args[1]?.replace(/\D/g, '');
      if (!roleId) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}welcome autorole @role\` or \`off\``).toJSON()] });
      setWelcomeField(guildId, 'autorole_id', roleId);
      // The join handler requires autorole_enabled too; setting only the role
      // left autorole looking configured but never applied.
      setWelcomeField(guildId, 'autorole_enabled', 1);
      return message.reply({ embeds: [Embed.success(`Auto-role set to <@&${roleId}>.`).toJSON()] });
    }

    // ── dm ────────────────────────────────────────────────────────────────
    if (sub === 'dm') {
      const sub2 = args[1]?.toLowerCase();
      if (sub2 === 'on') { setWelcomeField(guildId, 'dm_enabled', 1); return message.reply({ embeds: [Embed.success('DM welcome enabled.').toJSON()] }); }
      if (sub2 === 'off') { setWelcomeField(guildId, 'dm_enabled', 0); return message.reply({ embeds: [Embed.success('DM welcome disabled.').toJSON()] }); }
      const text = args.slice(1).join(' ');
      if (text) { setWelcomeField(guildId, 'dm_message', text); return message.reply({ embeds: [Embed.success('DM welcome message updated.').toJSON()] }); }
      return message.reply({ embeds: [Embed.warning('Usage: `welcome dm on|off` or `welcome dm <message>`').toJSON()] });
    }

    // ── test ──────────────────────────────────────────────────────────────
    if (sub === 'test') {
      const { sendWelcome } = await import('../../handlers/welcomeSystem.js');
      await sendWelcome(client, message.member ?? { user: message.author, guild: message.guild, guildId }, { skipAutorole: true });
      return message.reply({ embeds: [Embed.success('Test welcome sent (check configured channels).').toJSON()] });
    }

    await message.reply({ embeds: [Embed.info(`Subcommands: \`channel\`, \`message\`, \`goodbye\`, \`autorole\`, \`dm\`, \`test\``).toJSON()] });
  },
};
