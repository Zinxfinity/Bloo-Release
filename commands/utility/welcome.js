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
//  !welcome message off                   , card only, no text outside it
//  !welcome card <on|off>                 , welcome card image
//  !welcome card theme <name>             , one of the rank card themes
//  !welcome card title <text|off>         , big line on the card
//  !welcome card subtitle <text|off>      , smaller line under it
//  !welcome card preview                  , draw it with your avatar
//
//  Placeholders: {user} {name} {username} {server} {count} {ordinal}
// ============================================================

import { EmbedBuilder }      from '@fluxerjs/core';
import { Embed, COLORS }     from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';
import {
  getWelcomeConfig, setWelcomeField, welcomeCardFor,
} from '../../handlers/welcomeSystem.js';
import { WELCOME_CARD_THEMES } from '../../handlers/profileCard.js';
import { saveWelcomeUpload, removeWelcomeUpload, welcomeUploadsEnabled, removeServerCache } from '../../handlers/welcomeBackgrounds.js';
import { CardError } from '../../handlers/cardBackgrounds.js';
import { isRealOwner, isBotOwner } from '../../handlers/staffSystem.js';

const HEX = /^#?[0-9a-f]{6}$/i;
const COLOR_FIELDS = { accent: 'card_accent', title: 'card_title_color', subtitle: 'card_subtitle_color' };

const PLACEHOLDER_HELP = '`{user}` mention · `{name}` display name · `{username}` · `{server}` · `{count}` member count (1,234) · `{ordinal}` (1,234th)';

function parseId(arg) {
  return arg?.match(/^[#@&!]+(\d+)>$/)?.[1] ?? (arg?.match(/^\d{17,20}$/) ? arg : null);
}

function onOff(val) { return val ? '✅ Enabled' : '❌ Disabled'; }

export default {
  name: 'welcome',
  aliases: ['goodbye'],
  description: 'Configure welcome/goodbye messages and auto-role.',
  usage: '{prefix}welcome [channel|message|card|goodbye|autorole|dm|test]',
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
          { name: 'Welcome Card',    value: cfg.welcome_card ? `✅ ${WELCOME_CARD_THEMES[cfg.card_theme] ?? 'Bloo'} theme` : '❌ Disabled', inline: true },
          { name: 'Welcome Message', value: cfg.welcome_message?.slice(0, 200) || 'None (card only)',          inline: false },
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
      if (!text) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}welcome message <text>\` or \`off\` for the card only\nPlaceholders: ${PLACEHOLDER_HELP}`).toJSON()] });
      if (text.toLowerCase() === 'off') {
        setWelcomeField(guildId, 'welcome_message', '');
        return message.reply({ embeds: [Embed.success(cfg.welcome_card
          ? 'Welcome message removed. New members get just the card.'
          : `Welcome message removed. Turn on a card with \`${prefix}welcome card on\`, or nothing will be sent.`).toJSON()] });
      }
      setWelcomeField(guildId, 'welcome_message', text);
      return message.reply({ embeds: [Embed.success('Welcome message updated.').toJSON()] });
    }

    // ── welcome card ──────────────────────────────────────────────────────
    if (sub === 'card') {
      const sub2 = args[1]?.toLowerCase();
      const ok = text => message.reply({ embeds: [Embed.success(text).toJSON()] });
      if (sub2 === 'on' || sub2 === 'off') {
        setWelcomeField(guildId, 'welcome_card', sub2 === 'on' ? 1 : 0);
        return ok(sub2 === 'on'
          ? `Welcome card on. \`${prefix}welcome card preview\` shows how it looks.${cfg.welcome_channel_id ? '' : `\nSet a channel too: \`${prefix}welcome channel #channel\``}`
          : 'Welcome card off.');
      }
      if (sub2 === 'theme') {
        const name = args[2]?.toLowerCase();
        if (!WELCOME_CARD_THEMES[name]) {
          return message.reply({ embeds: [Embed.info(`Pick one: ${Object.keys(WELCOME_CARD_THEMES).map(k => `\`${k}\``).join(', ')}\n\`${prefix}card themes\` shows them all.`).toJSON()] });
        }
        setWelcomeField(guildId, 'card_theme', name);
        return ok(`Welcome card theme set to ${WELCOME_CARD_THEMES[name]}.`);
      }
      if (sub2 === 'title' || sub2 === 'subtitle') {
        const text = args.slice(2).join(' ').trim();
        const max = sub2 === 'title' ? 60 : 90;
        if (!text) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}welcome card ${sub2} <text>\` or \`off\`\nPlaceholders: ${PLACEHOLDER_HELP}`).toJSON()] });
        if (text.length > max) return message.reply({ embeds: [Embed.warning(`Keep the ${sub2} under ${max} characters so it fits on the card.`).toJSON()] });
        setWelcomeField(guildId, sub2 === 'title' ? 'card_title' : 'card_subtitle', text.toLowerCase() === 'off' ? '' : text);
        return ok(text.toLowerCase() === 'off' ? `The card's ${sub2} is off.` : `Card ${sub2} updated.`);
      }
      if (sub2 === 'color' || sub2 === 'colour') {
        const which = args[2]?.toLowerCase(), val = args[3]?.toLowerCase();
        if (!COLOR_FIELDS[which] || !val || (val !== 'reset' && !HEX.test(val))) {
          return message.reply({ embeds: [Embed.info(`\`${prefix}welcome card color <accent|title|subtitle> <#hex|reset>\`\nThe accent colours the avatar ring and glow. \`reset\` goes back to the theme's colour.`).toJSON()] });
        }
        const hex = val === 'reset' ? null : `#${val.replace('#', '')}`;
        setWelcomeField(guildId, COLOR_FIELDS[which], hex);
        return ok(hex ? `Card ${which} colour set to \`${hex}\`.` : `Card ${which} colour back to the theme's.`);
      }
      if (sub2 === 'background' || sub2 === 'bg') {
        const mode = args[2]?.toLowerCase();
        const attachment = message.attachments?.first?.() ?? [...(message.attachments?.values?.() ?? [])][0] ?? null;
        const owner = isBotOwner(message.author.id) || await isRealOwner(guildId, message.author.id);
        // Uploading or removing an image: the server owner only.
        if (attachment || mode === 'remove') {
          if (!owner) return message.reply({ embeds: [Embed.warning('Only the server owner can upload or remove a welcome card image. Admins can still use `theme` or `server`.').toJSON()] });
          if (mode === 'remove') {
            const had = removeWelcomeUpload(guildId);
            return ok(had ? 'Custom image removed. The card uses the theme background again.' : 'There was no custom image to remove.');
          }
          try {
            await saveWelcomeUpload(guildId, { url: attachment.url, size: attachment.size }, { by: message.author.id, guildName: message.guild?.name ?? null });
          } catch (err) {
            if (err instanceof CardError) return message.reply({ embeds: [Embed.warning(err.message).toJSON()] });
            throw err;
          }
          return ok(`Custom image saved, and the card now uses it. \`${prefix}welcome card preview\` to see it.`);
        }
        if (mode === 'theme' || mode === 'server') {
          setWelcomeField(guildId, 'card_background', mode);
          if (mode !== 'server') removeServerCache(guildId);
          return ok(mode === 'theme' ? 'The card uses its theme\'s background.' : 'The card uses this server\'s banner, or its icon if there\'s no banner.');
        }
        if (mode === 'custom') {
          if (!owner) return message.reply({ embeds: [Embed.warning('Only the server owner can use a custom image.').toJSON()] });
          const { welcomeBgPath } = await import('../../handlers/welcomeBackgrounds.js');
          const { existsSync } = await import('fs');
          if (!existsSync(welcomeBgPath(guildId))) return message.reply({ embeds: [Embed.info(`Upload one first: \`${prefix}welcome card background\` with an image attached.`).toJSON()] });
          setWelcomeField(guildId, 'card_background', 'custom');
          removeServerCache(guildId);
          return ok('The card uses your custom image again.');
        }
        return message.reply({ embeds: [Embed.info([
          `\`${prefix}welcome card background theme\`: the theme's own background`,
          `\`${prefix}welcome card background server\`: this server's banner (or icon)`,
          `\`${prefix}welcome card background\` with an image attached: your own image (server owner only)${welcomeUploadsEnabled() ? '' : ' · switched off right now'}`,
          `\`${prefix}welcome card background remove\`: delete the custom image (server owner only)`,
          '',
          'Best at 1800×640 (about 3:1), at least 600×200. PNG, JPEG or GIF, up to 8 MB. It\'s cropped to the card\'s shape (wide, about 3:1) and darkened a little so the text stays readable.',
        ].join('\n'), '🖼️ Card background').toJSON()] });
      }
      if (sub2 === 'preview') {
        const fresh = getWelcomeConfig(guildId);
        const member = message.member ?? { user: message.author, guild: message.guild, guildId };
        const guild = message.guild ?? client.guilds?.cache?.get(guildId);
        // b!welcome card preview goodbye shows the goodbye card instead.
        const bye = args[2]?.toLowerCase() === 'goodbye' || args[2]?.toLowerCase() === 'leave';
        const lines = bye ? { title: fresh.goodbye_card_title, subtitle: fresh.goodbye_card_subtitle } : null;
        const buf = await welcomeCardFor(client, member, guild, fresh, 1234, lines);
        if (!buf) return message.reply({ embeds: [Embed.warning('The card couldn\'t be drawn right now.').toJSON()] });
        const on = bye ? fresh.goodbye_card : fresh.welcome_card;
        const hint = on ? undefined : `Preview only: the ${bye ? 'goodbye' : 'welcome'} card is off. \`${prefix}welcome ${bye ? 'goodbye ' : ''}card on\` to use it.`;
        return message.reply({ content: hint, files: [{ name: `${bye ? 'goodbye' : 'welcome'}-preview.png`, data: buf }] });
      }
      return message.reply({ embeds: [Embed.info([
        `\`${prefix}welcome card on\` / \`off\``,
        `\`${prefix}welcome card theme <name>\`: ${Object.keys(WELCOME_CARD_THEMES).join(', ')}`,
        `\`${prefix}welcome card title <text|off>\` (now: ${cfg.card_title || 'off'})`,
        `\`${prefix}welcome card subtitle <text|off>\` (now: ${cfg.card_subtitle || 'off'})`,
        `\`${prefix}welcome card color <accent|title|subtitle> <#hex|reset>\``,
        `\`${prefix}welcome card background <theme|server>\`, or attach an image (server owner only)`,
        `\`${prefix}welcome card preview\` (or \`preview goodbye\` for the leave card)`,
        `\`${prefix}welcome goodbye card on\` to show the card when someone leaves too`,
        '',
        `Placeholders: ${PLACEHOLDER_HELP}`,
        `The welcome message (\`${prefix}welcome message\`) is sent above the card; \`${prefix}welcome message off\` sends the card on its own.`,
      ].join('\n'), '🖼️ Welcome card').toJSON()] });
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
        if (!text) return message.reply({ embeds: [Embed.warning('Provide a goodbye message, or `off` to send just the goodbye card.').toJSON()] });
        setWelcomeField(guildId, 'goodbye_message', text.toLowerCase() === 'off' ? '' : text);
        return message.reply({ embeds: [Embed.success(text.toLowerCase() === 'off' ? 'Goodbye message removed. With a goodbye card on, just the card is sent.' : 'Goodbye message updated.').toJSON()] });
      }
      // A goodbye card: the welcome card's look (theme, colours, background)
      // with its own two lines.
      if (sub2 === 'card') {
        const what = args[2]?.toLowerCase();
        if (what === 'on' || what === 'off') {
          setWelcomeField(guildId, 'goodbye_card', what === 'on' ? 1 : 0);
          return message.reply({ embeds: [Embed.success(what === 'on'
            ? `Goodbye card on. It uses the welcome card's theme, colours and background. \`${prefix}welcome card preview goodbye\` shows it.`
            : 'Goodbye card off.').toJSON()] });
        }
        if (what === 'title' || what === 'subtitle') {
          const text = args.slice(3).join(' ').trim();
          const max = what === 'title' ? 60 : 90;
          if (!text) return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}welcome goodbye card ${what} <text|off>\`\nPlaceholders: ${PLACEHOLDER_HELP}`).toJSON()] });
          if (text.length > max) return message.reply({ embeds: [Embed.warning(`Keep the ${what} under ${max} characters so it fits on the card.`).toJSON()] });
          setWelcomeField(guildId, what === 'title' ? 'goodbye_card_title' : 'goodbye_card_subtitle', text.toLowerCase() === 'off' ? '' : text);
          return message.reply({ embeds: [Embed.success(text.toLowerCase() === 'off' ? `The goodbye card's ${what} is off.` : `Goodbye card ${what} updated.`).toJSON()] });
        }
        return message.reply({ embeds: [Embed.info([
          `\`${prefix}welcome goodbye card on\` / \`off\``,
          `\`${prefix}welcome goodbye card title <text|off>\` (now: ${cfg.goodbye_card_title || 'off'})`,
          `\`${prefix}welcome goodbye card subtitle <text|off>\` (now: ${cfg.goodbye_card_subtitle || 'off'})`,
          `\`${prefix}welcome card preview goodbye\` to see it`,
          '',
          `It shares the welcome card's theme, colours and background. Placeholders: ${PLACEHOLDER_HELP}`,
        ].join('\n'), '👋 Goodbye card').toJSON()] });
      }
      return message.reply({ embeds: [Embed.warning('Subcommands: `channel`, `message`, `card`').toJSON()] });
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

    await message.reply({ embeds: [Embed.info(`Subcommands: \`channel\`, \`message\`, \`card\`, \`goodbye\`, \`autorole\`, \`dm\`, \`test\``).toJSON()] });
  },
};
