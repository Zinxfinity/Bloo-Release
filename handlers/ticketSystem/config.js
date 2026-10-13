// ─── Ticket config + options CRUD ──────────────────────────────────────────────

import { stmts } from './schema.js';

// Shared by both the channel name and the case ID category segment, so a
// ticket's channel and its case ID always agree on the same word. Falls
// back to the option's label when no explicit keyword was set (e.g. options
// created before this existed), keeping older options working unchanged.
export function normalizeKeyword(raw, fallbackLabel) {
  const fromRaw = (raw ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  if (fromRaw) return fromRaw;
  const fromLabel = (fallbackLabel ?? '').toLowerCase().split(/\s+/)[0]?.replace(/[^a-z0-9]/g, '').slice(0, 20);
  return fromLabel || 'ticket';
}

export function getTicketConfig(guildId) {
  stmts.ensureConfig.run(guildId);
  return stmts.getConfig.get(guildId);
}

export function setTicketField(guildId, field, value) {
  const allowed = [
    'channel_id','panel_message_id','support_role_id',
    'icon_url','banner_url','title','description','category_id','color',
    'close_emoji','close_delay_seconds','opener_perms',
  ];
  if (!allowed.includes(field)) throw new Error(`Unknown ticket config field: ${field}`);
  stmts.ensureConfig.run(guildId);
  stmts.setConfigField(field).run(value, guildId);
}

export function getTicketOptions(guildId) {
  return stmts.getOptions.all(guildId);
}

export function addTicketOption(guildId, emoji, label, openingMessage, keyword) {
  stmts.addOption.run(guildId, emoji, label, openingMessage ?? null, normalizeKeyword(keyword, label), guildId);
}

export function removeTicketOption(guildId, emoji) {
  const option = stmts.getOptions.all(guildId).find(o => o.emoji === emoji);
  if (!option) return { error: `No option with emoji ${emoji} found.` };
  stmts.removeOption.run(option.id, guildId);
  return {};
}

export function editTicketOption(guildId, optionId, emoji, label, openingMessage, keyword) {
  stmts.editOption.run(emoji, label, openingMessage ?? null, normalizeKeyword(keyword, label), optionId, guildId);
}

// Update the opening message for a ticket option, looked up by emoji.
// Returns { ok: true } on success or { error: '...' } if no matching option.
// Pass openingMessage=null to reset to default.
export function setOptionMessage(guildId, emoji, openingMessage) {
  const options = getTicketOptions(guildId);
  const match   = options.find(o => o.emoji === emoji);
  if (!match) return { error: `No ticket option found for emoji ${emoji}.` };
  stmts.editOption.run(match.emoji, match.label, openingMessage ?? null, match.keyword, match.id, guildId);
  return { ok: true };
}

// Sets (or clears, if word is null) the channel-name/case-ID keyword for a
// ticket option, looked up by emoji. Returns { ok: true, keyword } on
// success or { error: '...' } if no matching option.
export function setOptionKeyword(guildId, emoji, word) {
  const options = getTicketOptions(guildId);
  const match   = options.find(o => o.emoji === emoji);
  if (!match) return { error: `No ticket option found for emoji ${emoji}.` };
  const keyword = normalizeKeyword(word, match.label);
  stmts.editOption.run(match.emoji, match.label, match.opening_message, keyword, match.id, guildId);
  return { ok: true, keyword };
}

// Looks up a ticket option by emoji, used by lifecycle.js to recover an
// option's routing (role/category) when reopening a ticket, since the
// reopen flow only has the closed ticket's stored option_emoji, not a
// live "which option did they pick" selection.
export function getOptionByEmoji(guildId, emoji) {
  if (!emoji) return null;
  return getTicketOptions(guildId).find(o => o.emoji === emoji) ?? null;
}

// Per-option support-role override. Pass roleId=null to clear it (falls
// back to the guild-wide ticket_config.support_role_id).
export function setOptionRole(guildId, emoji, roleId) {
  const match = getOptionByEmoji(guildId, emoji);
  if (!match) return { error: `No ticket option found for emoji ${emoji}.` };
  stmts.setOptionRole.run(roleId ?? null, match.id, guildId);
  return { ok: true };
}

// Per-option channel-category override. Pass categoryId=null to clear it
// (falls back to the guild-wide ticket_config.category_id).
export function setOptionCategory(guildId, emoji, categoryId) {
  const match = getOptionByEmoji(guildId, emoji);
  if (!match) return { error: `No ticket option found for emoji ${emoji}.` };
  stmts.setOptionCategory.run(categoryId ?? null, match.id, guildId);
  return { ok: true };
}

// Per-category on/off switch, e.g. temporarily turning off "Partnerships"
// without deleting the option or losing its role/category routing. Disabled
// options stay visible on the panel, but reacting DMs disabled_message
// (or a default) instead of opening a ticket, see panels.js.
export function setOptionEnabled(guildId, emoji, enabled) {
  const match = getOptionByEmoji(guildId, emoji);
  if (!match) return { error: `No ticket option found for emoji ${emoji}.` };
  stmts.setOptionEnabled.run(enabled ? 1 : 0, match.id, guildId);
  return { ok: true };
}

// Custom message DM'd to a user who reacts to a disabled option. Pass
// message=null to reset to the built-in default.
export function setOptionDisabledMessage(guildId, emoji, message) {
  const match = getOptionByEmoji(guildId, emoji);
  if (!match) return { error: `No ticket option found for emoji ${emoji}.` };
  stmts.setOptionDisabledMessage.run(message ?? null, match.id, guildId);
  return { ok: true };
}

// Whether this category's channel name skips the generic "ticket-" label
// (e.g. "partner-0001" instead of "ticket-partner-0001"). Only affects the
// channel name, the internal case ID always keeps its own "Ticket-" prefix.
export function setOptionNoPrefix(guildId, emoji, noPrefix) {
  const match = getOptionByEmoji(guildId, emoji);
  if (!match) return { error: `No ticket option found for emoji ${emoji}.` };
  stmts.setOptionNoPrefix.run(noPrefix ? 1 : 0, match.id, guildId);
  return { ok: true };
}
