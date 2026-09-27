// ============================================================
//  commands/moderation/wordfilter.js
//
//  !wordfilter add <word> [word2] [word3]…  , add words
//  !wordfilter remove <word>                , remove one word
//  !wordfilter list                         , show all words
//  !wordfilter clear                        , remove all words
//  !wordfilter config                       , show config
//  !wordfilter set <option> <value>         , change settings
//    options: scan-messages, scan-edited, scan-deleted,
//             scan-names, action, silent, log
//
//  Requires Ban Members
// ============================================================

import { EmbedBuilder }                      from '@fluxerjs/core';
import { COLORS, Embed }                     from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';
import {
  getWordFilterConfig as getWordConfig, setWordFilterField as updateWordConfig,
  addWord, removeWord, clearWords, listWords as getWords,
} from '../../handlers/wordFilter.js';

export default {
  name: 'wordfilter',
  aliases: ['wf', 'blacklist', 'wordblacklist'],
  description: 'Manage the word blacklist to block specific words and phrases in messages and member names.',
  usage: '{prefix}wordfilter <add|remove|list|clear|config|set> [args]',
  category: 'moderation',

  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;

    const [sub, ...rest] = args;

    switch (sub?.toLowerCase()) {

      // ── add ──────────────────────────────────────────────
      case 'add': {
        if (!rest.length) {
          await message.reply({ embeds: [Embed.warning('Missing Words').setDescription(`Usage: \`${PREFIX}wordfilter add <word> [word2] [word3]…\``).toJSON()] });
          return;
        }
        const added = [], skipped = [];
        for (const w of rest) {
          if (w.length < 2)          { skipped.push(`\`${w}\` (too short)`); continue; }
          if (w.length > 100)        { skipped.push(`\`${w}\` (too long)`);  continue; }
          const ok = addWord(guildId, w, message.author.id);
          if (ok) added.push(`\`${w.toLowerCase()}\``);
          else    skipped.push(`\`${w}\` (already exists)`);
        }
        const lines = [];
        if (added.length)   lines.push(`✅ Added: ${added.join(', ')}`);
        if (skipped.length) lines.push(`⏭️ Skipped: ${skipped.join(', ')}`);
        const total = getWords(guildId).length;
        await message.reply({ embeds: [Embed.success('Word Filter Updated').setDescription(lines.join('\n')).setFooter({ text: `${total} word${total === 1 ? '' : 's'} blacklisted` }).toJSON()] });
        break;
      }

      // ── remove ────────────────────────────────────────────
      case 'remove': {
        const word = rest.join(' ').trim();
        if (!word) {
          await message.reply({ embeds: [Embed.warning('Missing Word').setDescription(`Usage: \`${PREFIX}wordfilter remove <word>\``).toJSON()] });
          return;
        }
        const ok = removeWord(guildId, word);
        if (ok) await message.reply({ embeds: [Embed.success('Word Removed').setDescription(`\`${word.toLowerCase()}\` removed from the blacklist.`).toJSON()] });
        else    await message.reply({ embeds: [Embed.info('Not Found').setDescription(`\`${word.toLowerCase()}\` wasn't on the blacklist.`).toJSON()] });
        break;
      }

      // ── list ──────────────────────────────────────────────
      case 'list': {
        const words = getWords(guildId);
        if (!words.length) {
          await message.reply({ embeds: [Embed.info('No Words').setDescription('No words are blacklisted yet. Use `!wordfilter add` to add some.').toJSON()] });
          return;
        }
        const chunks = [];
        let chunk = [];
        let len   = 0;
        for (const w of words) {
          const entry = `\`${w}\``;
          if (len + entry.length > 900) { chunks.push(chunk.join(' ')); chunk = []; len = 0; }
          chunk.push(entry); len += entry.length + 1;
        }
        if (chunk.length) chunks.push(chunk.join(' '));
        const embed = new EmbedBuilder()
          .setTitle('🚫 Blacklisted Words')
          .setColor(COLORS.DANGER ?? 0xf87171)
          .setFooter({ text: `${words.length} word${words.length === 1 ? '' : 's'} total` });
        chunks.forEach((c, i) => embed.addFields({ name: i === 0 ? 'Words' : '\u200b', value: c, inline: false }));
        await message.reply({ embeds: [embed.toJSON()] });
        break;
      }

      // ── clear ─────────────────────────────────────────────
      case 'clear': {
        const count = clearWords(guildId);
        await message.reply({ embeds: [Embed.success('Blacklist Cleared').setDescription(`Removed ${count} word${count === 1 ? '' : 's'} from the blacklist.`).toJSON()] });
        break;
      }

      // ── config ────────────────────────────────────────────
      case 'config': {
        const cfg = getWordConfig(guildId);
        const words = getWords(guildId);
        const embed = new EmbedBuilder()
          .setTitle('🚫 Word Filter Config')
          .setColor(COLORS.INFO ?? 0x60a5fa)
          .addFields(
            { name: 'Enabled',          value: cfg.enabled        ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Scan Sent',         value: cfg.scan_messages  ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Scan Edited',       value: cfg.scan_edited    ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Scan Deleted',      value: cfg.scan_deleted   ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Scan Names',        value: cfg.scan_names     ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Silent Mode',       value: cfg.silent         ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Action',            value: `\`${cfg.action}\``,                    inline: true },
            { name: 'Log Channel',       value: cfg.log_channel_id ? `<#${cfg.log_channel_id}>` : '*Not set*', inline: true },
            { name: 'Words Blacklisted', value: `${words.length}`, inline: true },
          );
        await message.reply({ embeds: [embed.toJSON()] });
        break;
      }

      // ── set ───────────────────────────────────────────────
      case 'set': {
        const [option, ...valParts] = rest;
        const val = valParts.join(' ').trim();

        const boolMap = { on: 1, off: 0, yes: 1, no: 0, true: 1, false: 0, '1': 1, '0': 0 };
        const parseBool = v => boolMap[v?.toLowerCase()];

        switch (option?.toLowerCase()) {
          case 'enabled':        { const b = parseBool(val); if (b == null) break; updateWordConfig(guildId, 'enabled', b); await message.reply({ embeds: [Embed.success('Updated').setDescription(`Word filter ${b ? 'enabled' : 'disabled'}.`).toJSON()] }); return; }
          case 'scan-messages':  { const b = parseBool(val); if (b == null) break; updateWordConfig(guildId, 'scan_messages', b); await message.reply({ embeds: [Embed.success('Updated').setDescription(`Sent message scanning ${b ? 'on' : 'off'}.`).toJSON()] }); return; }
          case 'scan-edited':    { const b = parseBool(val); if (b == null) break; updateWordConfig(guildId, 'scan_edited', b); await message.reply({ embeds: [Embed.success('Updated').setDescription(`Edited message scanning ${b ? 'on' : 'off'}.`).toJSON()] }); return; }
          case 'scan-deleted':   { const b = parseBool(val); if (b == null) break; updateWordConfig(guildId, 'scan_deleted', b); await message.reply({ embeds: [Embed.success('Updated').setDescription(`Deleted message scanning ${b ? 'on' : 'off'}.`).toJSON()] }); return; }
          case 'scan-names':     { const b = parseBool(val); if (b == null) break; updateWordConfig(guildId, 'scan_names', b); await message.reply({ embeds: [Embed.success('Updated').setDescription(`Name scanning ${b ? 'on' : 'off'}.`).toJSON()] }); return; }
          case 'silent':         { const b = parseBool(val); if (b == null) break; updateWordConfig(guildId, 'silent', b); await message.reply({ embeds: [Embed.success('Updated').setDescription(`Silent mode ${b ? 'on (no warning message)' : 'off'}.`).toJSON()] }); return; }
          case 'action': {
            if (!['delete','warn','mute'].includes(val)) {
              await message.reply({ embeds: [Embed.warning('Invalid Action').setDescription('Valid actions: `delete` `warn` `mute`').toJSON()] }); return;
            }
            updateWordConfig(guildId, 'action', val);
            await message.reply({ embeds: [Embed.success('Updated').setDescription(`Action set to \`${val}\`.`).toJSON()] });
            return;
          }
          case 'log': {
            const chId = val.replace(/[<#>]/g, '') || null;
            updateWordConfig(guildId, 'log_channel_id', chId);
            await message.reply({ embeds: [Embed.success('Updated').setDescription(chId ? `Log channel set to <#${chId}>.` : 'Log channel cleared.').toJSON()] });
            return;
          }
        }
        await message.reply({ embeds: [Embed.warning('Invalid Option').setDescription(
          `Valid options:\n\`enabled\` \`scan-messages\` \`scan-edited\` \`scan-deleted\` \`scan-names\` \`silent\` \`action\` \`log\``
        ).toJSON()] });
        break;
      }

      // ── default ───────────────────────────────────────────
      default: {
        const words = getWords(guildId);
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle('🚫 Word Filter: Reference')
          .setColor(COLORS.INFO ?? 0x60a5fa)
          .addFields(
            { name: `\`${PREFIX}wordfilter add <word> [word2]…\``, value: 'Add one or more blacklisted words', inline: false },
            { name: `\`${PREFIX}wordfilter remove <word>\``,        value: 'Remove a word from the blacklist', inline: false },
            { name: `\`${PREFIX}wordfilter list\``,                 value: 'Show all blacklisted words',      inline: false },
            { name: `\`${PREFIX}wordfilter clear\``,                value: 'Remove all blacklisted words',    inline: false },
            { name: `\`${PREFIX}wordfilter config\``,               value: 'Show current settings',           inline: false },
            { name: `\`${PREFIX}wordfilter set <option> <value>\``, value: 'Change a setting',                inline: false },
          )
          .setFooter({ text: `${words.length} word${words.length === 1 ? '' : 's'} currently blacklisted` })
          .toJSON()] });
      }
    }
  },
};