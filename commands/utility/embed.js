// ============================================================
//  commands/utility/embed.js
//  Category : Utility  |  Access 0  |  Requires Kick Members (default)
//
//  Post a custom embed to any channel.
//
//  Usage:
//    !embed [colour] <title> ;; <description>
//    !embed [colour] <title> ;; <description> >> #channel
//
//  Separator:  ;;  splits title from description
//  Channel:    >>  at the end targets a different channel
//
//  Colour presets (case-insensitive, brackets optional):
//    [red]      #ED4245    [green]    #57F287
//    [blue]     #5865F2    [yellow]   #FEE75C
//    [purple]   #9B59B6    [pink]     #EB459E
//    [orange]   #E67E22    [white]    #FFFFFF
//    [black]    #23272A    [grey]     #4F545C
//    [teal]     #1ABC9C    [gold]     #F1C40F
//    [blurple]  #5865F2    [cyan]     #00FFFF
//    [mod]      #EB459E    [success]  #57F287
//    [warn]     #FEE75C    [danger]   #ED4245
//
//  Colour can also be a hex code: #FF5733 or FF5733
//
//  Newlines:
//    Use \n anywhere in the title or description to insert a line break.
//    Multiple \n in a row (e.g. \n\n\n) produce multiple blank lines.
//
//  Examples:
//    !embed [red] Server Rules ;; Follow all rules or face consequences.
//    !embed [gold] Announcement ;; Big news today! >> #announcements
//    !embed Welcome to the server! ;; Please read #rules before chatting.
//    !embed [blue] Info ;; Line one\nLine two\n\nAfter a blank line.
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed }        from '../../config/embeds.js';
import { checkCommandAccess, getCommandConfig } from '../../handlers/commandPermissions.js';
import { Permissions } from '../../config/guildPermissions.js';
import { isChannelInGuild } from '../../utils/channelGuard.js';

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

// ── Colour preset map ─────────────────────────────────────────
const PRESETS = {
  red:      0xED4245,
  green:    0x57F287,
  blue:     0x5865F2,
  yellow:   0xFEE75C,
  purple:   0x9B59B6,
  pink:     0xEB459E,
  orange:   0xE67E22,
  white:    0xFFFFFF,
  black:    0x23272A,
  grey:     0x4F545C,
  gray:     0x4F545C,
  teal:     0x1ABC9C,
  gold:     0xF1C40F,
  blurple:  0x5865F2,
  cyan:     0x00FFFF,
  mod:      0xEB459E,
  success:  0x57F287,
  warn:     0xFEE75C,
  warning:  0xFEE75C,
  danger:   0xED4245,
  error:    0xED4245,
  info:     0x5865F2,
};

const PRESET_NAMES = Object.keys(PRESETS)
  .filter((k, i, a) => a.findIndex(x => PRESETS[x] === PRESETS[k]) === i) // unique colours
  .map(k => `\`[${k}]\``);

function parseColor(input) {
  if (!input) return null;
  const lower = input.replace(/[\[\]]/g, '').toLowerCase().trim();
  if (PRESETS[lower] !== undefined) return PRESETS[lower];
  // Hex code, #RRGGBB or RRGGBB
  const hex = lower.replace(/^#/, '');
  if (/^[0-9a-f]{6}$/.test(hex)) return parseInt(hex, 16);
  return null;
}

// ── Newline parsing ───────────────────────────────────────────
// Converts literal \n sequences (including runs like \n\n\n) into real newlines.
function parseNewlines(str) {
  return str.replace(/\\n/g, '\n');
}

export default {
  name: 'embed',
  aliases: ['say', 'embedsay'],
  description: 'Post a custom embed to a channel.',
  usage: '{prefix}embed [colour] <title> ;; <description> [>> #channel]',
  category: 'utility',
  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 5,

  async execute({ message, args, client, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;

    if (!guildId) {
      await message.reply({ embeds: [Embed.danger('Server Only').setDescription('This command can only be used inside a server.').toJSON()] }).catch(() => {});
      return;
    }

    if (!checkCommandAccess(guildId, message.author.id, 'embed', this.requiredPermission).allowed) {
      const req = requirementLabel(guildId, 'embed', this.requiredPermission);
      await message.reply({ embeds: [Embed.denied(`Requires: ${req}`).toJSON()] }).catch(() => {});
      return;
    }

    // Rejoin args into full input string for parsing
    let input = args.join(' ').trim();

    if (!input) {
      await message.reply({ embeds: [buildHelp(PREFIX).toJSON()] }).catch(() => {});
      return;
    }

    // ── 1. Extract target channel ( >> #channel at the end ) ───
    let targetChannelId = message.channelId;
    const channelMatch  = input.match(/\s*>>\s*(<#(\d+)>|(\d{17,20}))\s*$/);
    if (channelMatch) {
      targetChannelId = channelMatch[2] ?? channelMatch[3];
      input = input.slice(0, channelMatch.index).trimEnd();
      if (!await isChannelInGuild(client, message.guildId, targetChannelId)) {
        await message.reply({ embeds: [Embed.danger('Invalid Channel').setDescription('That channel is not in this server.').toJSON()] }).catch(() => {});
        return;
      }
    }

    // ── 2. Extract colour preset ( [colour] or #hex at start ) ─
    let color = 0x5865F2; // default blurple
    const colorMatch = input.match(/^\s*(\[[^\]]+\]|#?[0-9a-fA-F]{6})\s+/);
    if (colorMatch) {
      const parsed = parseColor(colorMatch[1]);
      if (parsed !== null) {
        color = parsed;
        input = input.slice(colorMatch[0].length).trimStart();
      }
      // If not a valid colour token, treat it as part of the title
    }

    // ── 3. Split title ;; description ──────────────────────────
    const sepIdx = input.indexOf(';;');
    if (sepIdx === -1) {
      await message.reply({
        embeds: [
          Embed.warning('Missing Separator')
            .setDescription(
              `Use \`;;\` to separate the title from the description.\n\n` +
              `**Example:**\n\`${PREFIX}embed [gold] My Title ;; My description here.\``
            )
            .toJSON(),
        ],
      });
      return;
    }

    const title       = input.slice(0, sepIdx).trim();
    const description = parseNewlines(input.slice(sepIdx + 2).trim());

    if (!title) {
      await message.reply({ embeds: [Embed.warning('Missing Title').setDescription(`The title cannot be empty. Put text before \`;;\`.`).toJSON()] }).catch(() => {});
      return;
    }
    if (!description) {
      await message.reply({ embeds: [Embed.warning('Missing Description').setDescription(`The description cannot be empty. Put text after \`;;\`.`).toJSON()] }).catch(() => {});
      return;
    }
    if (title.length > 256) {
      await message.reply({ embeds: [Embed.warning('Title Too Long').setDescription('Titles must be 256 characters or fewer.').toJSON()] }).catch(() => {});
      return;
    }
    if (description.length > 4000) {
      await message.reply({ embeds: [Embed.warning('Description Too Long').setDescription('Descriptions must be 4000 characters or fewer.').toJSON()] }).catch(() => {});
      return;
    }

    // ── 5. Build and send ──────────────────────────────────────
    const builtEmbed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(description)
      .setTimestamp();

    try {
      // Raw REST, not client.channels.fetch() + channel.send(): confirmed
      // in production that pattern fails with "channel.send is not a
      // function" for at least one channel type on v2.0.1's SDK.
      await client.rest.post(`/channels/${targetChannelId}/messages`, { body: { embeds: [builtEmbed.toJSON()] } });
    } catch (err) {
      await message.reply({ embeds: [Embed.danger('Send Failed').setDescription(`Could not post to <#${targetChannelId}>: ${err.message}`).toJSON()] }).catch(() => {});
      return;
    }

    // Confirm to the author if they posted to a different channel
    if (targetChannelId !== message.channelId) {
      await message.reply({
        embeds: [
          Embed.success('Embed Posted')
            .setDescription(`Your embed was posted to <#${targetChannelId}>.`)
            .toJSON(),
        ],
      });
    }
    // If same channel, the command message is auto-deleted by commandHandler,
    // confirmation would just be noise.
  },
};

// ── Help embed ────────────────────────────────────────────────
function buildHelp(prefix) {
  return Embed.info('📋  Embed: Usage')
    .setDescription(
      `**Separator:** Use \`;;\` between title and description.\n` +
      `**Channel:** Append \`>> #channel\` to post elsewhere.\n` +
      `**Newlines:** Use \`\\n\` anywhere to drop to a new line (e.g. \`\\n\\n\` for a blank line).\n\n` +
      `**Examples:**\n` +
      `\`${prefix}embed [red] Alert ;; Something important happened.\`\n` +
      `\`${prefix}embed [gold] Announcement ;; Big news! >> #announcements\`\n` +
      `\`${prefix}embed Rules ;; Please be respectful.\`\n` +
      `\`${prefix}embed #E67E22 Custom Colour ;; Orange via hex code.\`\n` +
      `\`${prefix}embed [blue] Info ;; Line one\\nLine two\\n\\nAfter a blank line.\``
    )
    .addFields({
      name:  'Colour Presets',
      value: PRESET_NAMES.slice(0, 18).join(' ') + '\n-# Or use any hex code: `#FF5733`',
      inline: false,
    });
}