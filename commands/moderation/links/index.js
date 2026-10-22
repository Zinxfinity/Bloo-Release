// ============================================================
//  commands/moderation/links/index.js
//  Category : Moderation  |  Rank: Server Owner (default)
//
//  !links on/off                      , toggle scanner
//  !links status                      , show config
//  !links allow <domain>              , whitelist domain
//  !links deny <domain>               , remove from whitelist
//  !links channel add/remove <#ch>    , exempt channels
//  !links import                      , bulk import from attachment
// ============================================================

import { EmbedBuilder }                    from '@fluxerjs/core';
import { Embed, COLORS }                   from '../../../config/embeds.js';
import {
  getConfig, setEnabled, addDomain, removeDomain,
  addChannel, removeChannel, normaliseEntry, bulkAddDomains, joinList,
} from '../../../handlers/linkScanner.js';
import { registerPagination } from '../../../handlers/paginationManager.js';
import { handleEnforce } from './enforce.js';

const DOMAINS_PER_PAGE = 15;

function parseChannelId(arg) {
  if (!arg) return null;
  return arg.match(/^<#(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

function entryTypeLabel(entry) {
  const isWild = entry.startsWith('*.');
  const hasPath = entry.includes('/');
  if (isWild && hasPath)  return '`*.sub` + path';
  if (isWild)             return '`*.sub` wildcard';
  if (hasPath)            return 'exact path';
  return 'domain + subs';
}

export default {
  name: 'links',
  aliases: ['linkscanner', 'linkscan'],
  description: 'Configure the link scanner to block all links except approved domains.',
  usage: '{prefix}links <on|off|status|allow|deny|channel|enforce> [args]',
  category: 'moderation',

  requiredPermission: 'SERVER_OWNER',

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const PREFIX     = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId    = message.guildId;
    if (!guildId) { await message.reply({ embeds: [Embed.danger('Server only.').toJSON()] }).catch(() => {}); return; }

    const [sub, ...rest] = args;

    // Helper to get domains/channels as arrays
    function getCfgArrays() {
      const cfg  = getConfig(guildId);
      const domains  = joinList(cfg?.domain_whitelist);
      const channels = joinList(cfg?.channel_whitelist);
      return { cfg, domains, channels };
    }

    // Link Enforcement settings (commands/moderation/linksEnforce.js).
    if (sub?.toLowerCase() === 'enforce') return handleEnforce({ message, rest, prefix: PREFIX, guildId });

    switch (sub?.toLowerCase()) {

      // ── on ───────────────────────────────────────────────
      case 'on': {
        setEnabled(guildId, true);
        const { domains, channels } = getCfgArrays();
        const embed = new EmbedBuilder()
          .setColor(COLORS.SUCCESS)
          .setTitle('🔗  Link Scanner Enabled')
          .setDescription(domains.length
            ? `Scanner is active. **${domains.length}** domain(s) whitelisted.`
            : `⚠️ No domains whitelisted yet. All links will be blocked until you add some.\nUse \`${PREFIX}links allow <domain>\` to add domains.`)
          .addFields(
            { name: `Whitelisted Domains (${domains.length})`, value: domains.slice(0, 20).join('\n') || 'None', inline: true },
            { name: `Exempt Channels (${channels.length})`,    value: channels.slice(0, 10).map(id => `<#${id}>`).join('\n') || 'None', inline: true },
          );
        await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
        break;
      }

      // ── off ──────────────────────────────────────────────
      case 'off': {
        setEnabled(guildId, false);
        await message.reply({ embeds: [Embed.warning('🔗  Link Scanner Disabled').setDescription('All links are now permitted. Your config is saved. Use `links on` to re-enable.').toJSON()] }).catch(() => {});
        break;
      }

      // ── status ───────────────────────────────────────────
      case 'status': {
        const { cfg, domains, channels } = getCfgArrays();
        const channelsField = channels.map(id => `<#${id}>`).join('\n') || 'None';

        const domainPages = [];
        for (let i = 0; i < domains.length; i += DOMAINS_PER_PAGE) domainPages.push(domains.slice(i, i + DOMAINS_PER_PAGE));
        if (!domainPages.length) domainPages.push([]);
        const totalPages = domainPages.length;

        const pageEmbeds = domainPages.map((chunk, i) => {
          const title = totalPages > 1
            ? `🔗  Link Scanner: ${cfg?.enabled ? '🟢 Enabled' : '🔴 Disabled'} (Page ${i + 1}/${totalPages})`
            : `🔗  Link Scanner: ${cfg?.enabled ? '🟢 Enabled' : '🔴 Disabled'}`;
          const footer = totalPages > 1
            ? `◀ ▶ to navigate  ·  ${PREFIX}links allow <domain>`
            : `${PREFIX}links allow <domain>  ·  ${PREFIX}links channel add <#ch>`;

          return new EmbedBuilder()
            .setColor(cfg?.enabled ? COLORS.SUCCESS : COLORS.WARNING)
            .setTitle(title)
            .addFields(
              { name: `Whitelisted Domains (${domains.length})`, value: chunk.join('\n') || 'None whitelisted', inline: false },
              { name: `Exempt Channels (${channels.length})`,    value: channelsField, inline: false },
            )
            .setFooter({ text: footer })
            .toJSON();
        });

        const sent = await message.reply({ embeds: [pageEmbeds[0]] }).catch(() => null);
        if (totalPages > 1 && sent?.id) {
          await registerPagination(client, sent.channelId ?? message.channelId, sent.id, message.author.id, pageEmbeds);
        }
        break;
      }

      // ── allow ─────────────────────────────────────────────
      case 'allow': {
        const raw = rest[0];
        if (!raw) { await message.reply({ embeds: [Embed.warning('Missing Domain').setDescription(`Usage: \`${PREFIX}links allow <domain>\``).toJSON()] }).catch(() => {}); return; }
        const domain = normaliseEntry(raw);
        if (!domain) { await message.reply({ embeds: [Embed.danger('Invalid Domain').toJSON()] }).catch(() => {}); return; }
        const added = addDomain(guildId, domain);
        if (!added) { await message.reply({ embeds: [Embed.info('Already Whitelisted').setDescription(`\`${domain}\` is already on the whitelist.`).toJSON()] }).catch(() => {}); return; }
        const { domains } = getCfgArrays();
        await message.reply({
          embeds: [Embed.success('Domain Whitelisted')
            .setDescription(`**\`${domain}\`** added to the whitelist.`)
            .addFields(
              { name: 'Type',  value: entryTypeLabel(domain), inline: true },
              { name: 'Total', value: `${domains.length}`,   inline: true },
            ).toJSON()],
        }).catch(() => {});
        break;
      }

      // ── deny ──────────────────────────────────────────────
      case 'deny': {
        const raw = rest[0];
        if (!raw) { await message.reply({ embeds: [Embed.warning('Missing Domain').setDescription(`Usage: \`${PREFIX}links deny <domain>\``).toJSON()] }).catch(() => {}); return; }
        const domain = normaliseEntry(raw);
        const removed = removeDomain(guildId, domain);
        if (!removed) { await message.reply({ embeds: [Embed.info('Not Whitelisted').setDescription(`\`${domain}\` is not on the whitelist.`).toJSON()] }).catch(() => {}); return; }
        await message.reply({ embeds: [Embed.success('Domain Removed').setDescription(`**\`${domain}\`** removed from the whitelist.`).toJSON()] }).catch(() => {});
        break;
      }

      // ── channel add/remove ────────────────────────────────
      case 'channel': {
        const [action, channelArg] = rest;
        const channelId = parseChannelId(channelArg);
        if (!action || !channelId) {
          await message.reply({ embeds: [Embed.info('Channel Exemptions').addFields({ name: `\`${PREFIX}links channel add <#ch>\``, value: 'Exempt a channel from link scanning', inline: false }, { name: `\`${PREFIX}links channel remove <#ch>\``, value: 'Remove channel exemption', inline: false }).toJSON()] }).catch(() => {});
          return;
        }
        if (action === 'add') {
          addChannel(guildId, channelId);
          await message.reply({ embeds: [Embed.success('Channel Exempted').setDescription(`<#${channelId}> is now exempt from link scanning.`).toJSON()] }).catch(() => {});
        } else if (action === 'remove') {
          removeChannel(guildId, channelId);
          await message.reply({ embeds: [Embed.success('Exemption Removed').setDescription(`<#${channelId}> will now be scanned.`).toJSON()] }).catch(() => {});
        } else {
          await message.reply({ embeds: [Embed.danger('Unknown action. Use `add` or `remove`.').toJSON()] }).catch(() => {});
        }
        break;
      }

      // ── import ────────────────────────────────────────────
      case 'import': {
        const attachment = [...(message.attachments?.values?.() ?? [])][0] ?? null;
        if (!attachment) {
          await message.reply({ embeds: [Embed.warning('No File').setDescription(`Attach a \`.txt\` or \`.csv\` file to your \`${PREFIX}links import\` message.\nOne domain per line; lines starting with # are comments.`).toJSON()] }).catch(() => {});
          return;
        }
        if (!/\.(txt|csv)$/i.test(attachment.name ?? '')) {
          await message.reply({ embeds: [Embed.danger('Invalid File Type').setDescription('Only `.txt` and `.csv` files are supported.').toJSON()] }).catch(() => {}); return;
        }
        if ((attachment.size ?? 0) > 512 * 1024) {
          await message.reply({ embeds: [Embed.danger('File Too Large').setDescription('Max 512 KB.').toJSON()] }).catch(() => {}); return;
        }
        let raw;
        try {
          // Restrict fetch to Fluxer's CDN, attachments coming from elsewhere are not platform-validated.
          const parsed = new URL(attachment.url);
          const allowedHosts = new Set([
            'cdn.fluxer.app',
            'fluxerusercontent.com',
            'fluxerstatic.com',
          ]);
          if (!allowedHosts.has(parsed.hostname)) {
            await message.reply({ embeds: [Embed.danger('Untrusted Attachment').setDescription('Attachment must be hosted on Fluxer.').toJSON()] }).catch(() => {});
            return;
          }
          const res = await fetch(parsed.toString());
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          raw = await res.text();
        } catch (err) {
          await message.reply({ embeds: [Embed.danger(`Download Failed: ${err.message}`).toJSON()] }).catch(() => {}); return;
        }
        const lines = raw.split(/\r?\n/).map(l => l.split('#')[0].trim()).filter(Boolean);
        const { added, skipped } = bulkAddDomains(guildId, lines);
        const { domains } = getCfgArrays();
        await message.reply({
          embeds: [Embed.success(`Import Complete: ${added} domain(s) added`)
            .addFields(
              { name: '✅ Added',    value: `${added}`,        inline: true },
              { name: '⏭️ Skipped', value: `${skipped}`,      inline: true },
              { name: '📋 Total',   value: `${domains.length}`, inline: true },
            ).toJSON()],
        }).catch(() => {});
        break;
      }

      // ── help ──────────────────────────────────────────────
      default: {
        const { cfg } = getCfgArrays();
        await message.reply({
          embeds: [Embed.info(`🔗  Link Scanner: ${cfg?.enabled ? '🟢 Enabled' : '🔴 Disabled'}`)
            .addFields(
              { name: `\`${PREFIX}links on / off\``,                   value: 'Toggle the scanner',                  inline: false },
              { name: `\`${PREFIX}links status\``,                      value: 'Show full config',                    inline: false },
              { name: `\`${PREFIX}links allow <domain>\``,              value: 'Whitelist a domain',                 inline: false },
              { name: `\`${PREFIX}links deny <domain>\``,               value: 'Remove from whitelist',              inline: false },
              { name: `\`${PREFIX}links channel add <#channel>\``,      value: 'Exempt a channel',                   inline: false },
              { name: `\`${PREFIX}links channel remove <#channel>\``,   value: 'Remove channel exemption',           inline: false },
              { name: `\`${PREFIX}links import\``,                      value: 'Bulk import from .txt/.csv file',    inline: false },
            ).toJSON()],
        }).catch(() => {});
      }
    }
  },
};
