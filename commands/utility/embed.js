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
import {
  createEmbedMessage, updateEmbedMessage, publishEmbedMessage, deleteEmbedMessage,
  getEmbedMessage, listEmbedMessages, EmbedMessageError,
} from '../../handlers/embedMessages.js';

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
  description: 'Post an embed and edit it later. Saved embeds are also on the dashboard\'s Embed Messages page.',
  usage: '{prefix}embed [colour] <title> ;; <description> [>> #channel]\n{prefix}embed list\n{prefix}embed edit <id> <title|description|colour|image|thumbnail|footer|author|link|text|timestamp> <value|off>\n{prefix}embed field <id> add <name> ;; <value>\n{prefix}embed post <id> [#channel]\n{prefix}embed delete <id> [keep]',
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

    // ── Saved embeds: list / edit / field / post / delete ──────
    // Only when the second word is a number (or the word is "list" alone),
    // so a title like "Edit history ;; ..." still posts as an embed.
    const sub = args[0]?.toLowerCase();
    const numbered = /^\d+$/.test(args[1] ?? '');
    if ((sub === 'list' && args.length === 1) || (['edit', 'field', 'post', 'repost', 'delete', 'remove'].includes(sub) && numbered)) {
      return handleSaved(message, client, PREFIX, guildId, sub, args.slice(1));
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

    // ── 5. Save and post ───────────────────────────────────────
    // Saved (handlers/embedMessages.js), so it can be edited later from
    // here or the dashboard's Embed Messages page and the post updates.
    let id;
    try {
      id = createEmbedMessage(guildId, { title, description, color, timestamp: true }, message.author.id);
      await publishEmbedMessage(client, guildId, id, targetChannelId);
    } catch (err) {
      if (id) deleteEmbedMessage(client, guildId, id, { keepPost: true }).catch(() => {});
      await message.reply({ embeds: [Embed.danger('Send Failed').setDescription(err instanceof EmbedMessageError ? err.message : `Could not post to <#${targetChannelId}>: ${err.message}`).toJSON()] }).catch(() => {});
      return;
    }

    // Tell the author its number. In the same channel the note clears itself
    // after a few seconds so the embed is left on its own.
    const note = await message.reply({
      embeds: [Embed.success(`Posted${targetChannelId !== message.channelId ? ` in <#${targetChannelId}>` : ''} as embed **#${id}**. Change it any time with \`${PREFIX}embed edit ${id} …\` or on the dashboard's Embed Messages page.`).toJSON()],
    }).catch(() => null);
    if (note?.id && targetChannelId === message.channelId) {
      setTimeout(() => client.rest.delete(`/channels/${message.channelId}/messages/${note.id}`).catch(() => {}), 8000);
    }
  },
};

// ── Saved embeds ─────────────────────────────────────────────
const EDIT_PARTS = {
  title: 'title', description: 'description', desc: 'description', text: 'content', content: 'content',
  colour: 'color', color: 'color', image: 'image_url', thumbnail: 'thumbnail_url', thumb: 'thumbnail_url',
  footer: 'footer', author: 'author_name', link: 'url', url: 'url', timestamp: 'timestamp',
};

async function handleSaved(message, client, PREFIX, guildId, sub, rest) {
  const reply = e => message.reply({ embeds: [e.toJSON()] }).catch(() => {});
  try {
    if (sub === 'list') {
      const list = listEmbedMessages(guildId);
      if (!list.length) return reply(Embed.info(`No saved embeds yet. Post one with \`${PREFIX}embed Title ;; Text\`.`, 'Embed Messages'));
      const lines = list.slice(0, 25).map(m => `**#${m.id}** ${m.title ? m.title.slice(0, 60) : '*(no title)*'}${m.channel_id ? ` · <#${m.channel_id}>` : ' · not posted'}`);
      return reply(Embed.info(lines.join('\n') + (list.length > 25 ? `\n…and ${list.length - 25} more on the dashboard.` : ''), 'Embed Messages'));
    }

    const id = Number(rest[0]);
    if (sub === 'delete' || sub === 'remove') {
      const keepPost = rest[1]?.toLowerCase() === 'keep';
      await deleteEmbedMessage(client, guildId, id, { keepPost });
      return reply(Embed.success(`Embed #${id} deleted${keepPost ? '. The posted message was left up.' : ', along with its posted message.'}`));
    }

    if (sub === 'post' || sub === 'repost') {
      const ch = rest[1] ? (rest[1].match(/^<#(\d+)>$/)?.[1] ?? (/^\d{15,25}$/.test(rest[1]) ? rest[1] : null)) : null;
      if (rest[1] && !ch) return reply(Embed.warning(`Usage: \`${PREFIX}embed post ${id} [#channel]\``));
      if (ch && !await isChannelInGuild(client, guildId, ch)) return reply(Embed.danger('That channel is not in this server.'));
      const r = await publishEmbedMessage(client, guildId, id, ch);
      return reply(Embed.success(r.edited ? `Embed #${id} updated in <#${r.channelId}>.` : `Embed #${id} posted in <#${r.channelId}>.`));
    }

    if (sub === 'edit') {
      const part = EDIT_PARTS[rest[1]?.toLowerCase()];
      const raw = rest.slice(2).join(' ').trim();
      if (!part || (!raw && part !== 'timestamp')) {
        return reply(Embed.warning(`Usage: \`${PREFIX}embed edit ${id} <part> <new value | off>\`\nParts: ${Object.keys(EDIT_PARTS).filter((k, i, a) => a.findIndex(x => EDIT_PARTS[x] === EDIT_PARTS[k]) === i).map(k => `\`${k}\``).join(' ')}`));
      }
      let value = raw.toLowerCase() === 'off' ? null : parseNewlines(raw);
      if (part === 'color' && value != null) {
        value = parseColor(value);
        if (value === null) return reply(Embed.warning(`Use a colour name like \`[gold]\` or a hex code like \`#F1C40F\`.`));
      }
      if (part === 'timestamp') value = !['off', 'no', 'false'].includes(raw.toLowerCase());
      updateEmbedMessage(guildId, id, { [part]: value });
      return refreshAfterEdit(message, client, guildId, id, reply);
    }

    if (sub === 'field') {
      const m = getEmbedMessage(guildId, id);
      if (!m) return reply(Embed.warning(`No embed message #${id} in this server.`));
      const action = rest[1]?.toLowerCase();
      let fields = m.fields;
      if (action === 'add' || action === 'addinline') {
        const text = parseNewlines(rest.slice(2).join(' '));
        const sep = text.indexOf(';;');
        if (sep === -1) return reply(Embed.warning(`Usage: \`${PREFIX}embed field ${id} add Name ;; Value\` (\`addinline\` for side by side)`));
        fields = [...fields, { name: text.slice(0, sep).trim(), value: text.slice(sep + 2).trim(), inline: action === 'addinline' }];
      } else if (action === 'remove') {
        const n = Number(rest[2]);
        if (!Number.isInteger(n) || n < 1 || n > fields.length) return reply(Embed.warning(`Give the field's number, 1 to ${fields.length || 1}.`));
        fields = fields.filter((_, i) => i !== n - 1);
      } else if (action === 'clear') {
        fields = [];
      } else {
        return reply(Embed.warning(`Usage: \`${PREFIX}embed field ${id} add Name ;; Value\`, \`remove <number>\` or \`clear\``));
      }
      updateEmbedMessage(guildId, id, { fields });
      return refreshAfterEdit(message, client, guildId, id, reply);
    }
  } catch (err) {
    if (err instanceof EmbedMessageError) return reply(Embed.warning(err.message));
    throw err;
  }
}

// After an edit, updates the posted message (if there is one).
async function refreshAfterEdit(message, client, guildId, id, reply) {
  const m = getEmbedMessage(guildId, id);
  if (!m.message_id) return reply(Embed.success(`Embed #${id} saved. It isn't posted yet: \`${process.env.PREFIX || 'b!'}embed post ${id} #channel\`.`));
  const r = await publishEmbedMessage(client, guildId, id);
  return reply(Embed.success(r.edited ? `Embed #${id} updated in <#${r.channelId}>.` : `The old post was gone, so embed #${id} was posted again in <#${r.channelId}>.`));
}

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
    }, {
      name:  'Editing later',
      value:
        `Every embed is saved with a number, so you can change it and the posted message updates.\n` +
        `\`${prefix}embed list\` · \`${prefix}embed edit 3 image https://…\` · \`${prefix}embed edit 3 footer off\`\n` +
        `\`${prefix}embed field 3 add Name ;; Value\` · \`${prefix}embed post 3 #channel\` · \`${prefix}embed delete 3\`\n` +
        `-# Or build them on the dashboard: Community → Embed Messages.`,
      inline: false,
    });
}