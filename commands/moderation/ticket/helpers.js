// ─── Shared parsing/formatting helpers for the ticket command family ──────────

import { EmbedBuilder } from '@fluxerjs/core';

export function parseChannelId(arg) {
  if (!arg) return null;
  return arg.match(/^<#(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

export function parseRoleId(arg) {
  if (!arg) return null;
  return arg.match(/^<@&(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

export function hexToInt(hex) {
  const clean = hex.replace(/^#/, '');
  const n = parseInt(clean, 16);
  return isNaN(n) ? null : n;
}

// Parse [\n] in user-supplied text into real newlines
export function parseBreaks(str) {
  return (str ?? '').replace(/\[\\n\]/g, '\n');
}

// ticket_options.emoji is stored as bare "name:id" ("a_name:id" if animated),
// the format handleTicketReaction() and the reaction-PUT endpoint both
// expect, but that's NOT what Fluxer renders as an actual emoji image in
// message/embed text, it needs the <:name:id> / <a:name:id> markup form.
// Matches dashboard/routes/tickets.js's own displayEmoji() exactly, that
// route is the only one of the three panel-posting implementations in this
// codebase that was actually converting this correctly.
function displayEmoji(stored) {
  if (!stored) return '';
  const custom = String(stored).match(/^(a_\w+|\w+):(\d+)$/);
  if (custom) return custom[1].startsWith('a_') ? `<a:${custom[1].slice(2)}:${custom[2]}>` : `<:${custom[1]}:${custom[2]}>`;
  return stored;
}

// Build the panel embed from current config + options
export function buildPanelEmbed(cfg, options) {
  const embed = new EmbedBuilder()
    .setTitle(parseBreaks(cfg.title))
    .setDescription(
      parseBreaks(cfg.description) +
      (options.length
        ? '\n\n' + options.map(o => `${displayEmoji(o.emoji)} — **${o.label}**`).join('\n')
        : '\n\n*No options configured yet.*')
    )
    .setColor(cfg.color ?? 0x5865F2);

  embed.setFooter({ text: 'React below to open a ticket.' });

  // Build raw JSON and inject image fields directly.
  // EmbedBuilder.setThumbnail() maps to the large image field in FluxerJS,
  // so both thumbnail and banner must be set on the raw object.
  const raw = embed.toJSON();
  if (cfg.icon_url)   raw.thumbnail = { url: cfg.icon_url };   // small corner image
  if (cfg.banner_url) raw.image     = { url: cfg.banner_url }; // large banner below description
  return raw;
}
