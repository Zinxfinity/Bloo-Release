import { getTicketConfig, getTicketOptions } from './config.js';
import { resolveAccess, requirementPhrase } from '../commandPermissions.js';
import { Permissions } from '../../config/guildPermissions.js';

// ─── Ticket channel permission overwrites ──────────────────────────────────────
// Shared by openTicket and reopenTicket in lifecycle.js, both need the same
// "hide from @everyone, allow the opener, allow the support role" overwrite set.

// `option`, when it carries its own support_role_id (per-category routing,
// e.g. "Partners" tickets going to a Partners-specific role instead of the
// general support role), takes priority over the guild-wide
// config.support_role_id rather than adding alongside it, so a category's
// role override actually narrows visibility instead of just widening it.
// ─── What a ticket's opener can do ────────────────────────────────────────────
// Always: see the channel, send messages, read history. On top of that, the
// server picks a default set (b!ticket perms, or the dashboard), and staff
// can change it for one ticket with b!ticket allow/deny.
const BASE_OPENER = 1024 | 2048 | 65536;
export const TICKET_PERMS = {
  attach: { bit: 32768, label: 'Attach files', aliases: ['attachments', 'files', 'images', 'uploads'] },
  embed:  { bit: 16384, label: 'Embed links',  aliases: ['embeds', 'links'] },
  react:  { bit: 64,    label: 'Add reactions', aliases: ['reactions', 'reacts'] },
};
export const DEFAULT_OPENER_PERMS = 'attach,embed,react';

// "attachments" → "attach", or null.
export function ticketPermKey(word) {
  const w = String(word ?? '').toLowerCase();
  return Object.keys(TICKET_PERMS).find(k => k === w || TICKET_PERMS[k].aliases.includes(w)) ?? null;
}
export function openerPermKeys(config) {
  const raw = config?.opener_perms ?? DEFAULT_OPENER_PERMS;
  return String(raw).split(',').map(s => s.trim()).filter(k => TICKET_PERMS[k]);
}
const bitsFor = keys => keys.reduce((n, k) => n | (TICKET_PERMS[k]?.bit ?? 0), 0);
const ALL_EXTRAS = bitsFor(Object.keys(TICKET_PERMS));

export function buildTicketOverwrites(guildId, userId, config, option) {
  const overwrites = [
    // Hide from @everyone
    { id: guildId, type: 0, deny: String(1024) },
    // The ticket opener: the basics plus the server's chosen extras
    { id: userId,  type: 1, allow: String(BASE_OPENER | bitsFor(openerPermKeys(config))) },
  ];

  // Support staff can always attach, embed and react.
  const roleId = option?.support_role_id ?? config?.support_role_id;
  if (roleId) {
    overwrites.push({ id: roleId, type: 0, allow: String(BASE_OPENER | ALL_EXTRAS) });
  }

  return overwrites;
}

// Turns one extra on or off for a ticket's opener, leaving everything else in
// their channel permissions as it is. Returns the opener's new allow bits.
export async function setOpenerPerm(client, channelId, userId, key, on) {
  const bit = TICKET_PERMS[key]?.bit;
  if (!bit) throw new Error(`Unknown ticket permission: ${key}`);
  const channel = await client.rest.get(`/channels/${channelId}`);
  const current = (channel?.permission_overwrites ?? []).find(o => o.id === userId && Number(o.type) === 1);
  let allow = BigInt(current?.allow ?? BASE_OPENER);
  let deny = BigInt(current?.deny ?? 0);
  if (on) { allow |= BigInt(bit); deny &= ~BigInt(bit); }
  else { allow &= ~BigInt(bit); deny |= BigInt(bit); }
  await client.rest.put(`/channels/${channelId}/permissions/${userId}`, {
    body: { id: userId, type: 1, allow: String(allow), deny: String(deny) },
  });
  return allow;
}

// ─── lockTicketChannel ────────────────────────────────────────────────────────
// Called on close, before the "closed" notice, denies the ticket opener
// SEND_MESSAGES (2048) while keeping VIEW_CHANNEL + READ_MESSAGE_HISTORY
// (1024 | 65536) so they can still read the closing notice, just not post
// further. Staff keep their own separate role overwrite, so this only
// affects the opener. Best-effort: a failure here shouldn't block closing.
export async function lockTicketChannel(client, channelId, userId) {
  try {
    await client.rest.put(`/channels/${channelId}/permissions/${userId}`, {
      body: { id: userId, type: 1, allow: String(1024 | 65536), deny: String(2048) },
    });
  } catch { /* best effort, channel may already be gone */ }
}

// ─── Who can close a ticket ───────────────────────────────────────────────────
// One rule for b!close, b!ticket close and the close reaction. Any of these
// can close:
//   - the ticket's opener
//   - a member holding a support role: the ticket's category role AND the
//     server-wide support role both count
//   - a member meeting the server's close requirement: Kick Members by
//     default, or the role/permission set with b!permissions close
// Support staff used to be able to see and answer a ticket but not close it.
export function ticketSupportRoles(guildId, ticket) {
  const option = ticket?.option_label ? getTicketOptions(guildId).find(o => o.label === ticket.option_label) : null;
  return [...new Set([option?.support_role_id, getTicketConfig(guildId)?.support_role_id].filter(Boolean))];
}

export async function canCloseTicket(client, guildId, ticket, userId) {
  if (ticket.user_id === userId) return true;
  const roles = ticketSupportRoles(guildId, ticket);
  if (roles.length) {
    const member = await client.rest.get(`/guilds/${guildId}/members/${userId}`).catch(() => null);
    if (Array.isArray(member?.roles) && roles.some(r => member.roles.includes(r))) return true;
  }
  return resolveAccess(client, guildId, userId, 'close', Permissions.KICK_MEMBERS);
}

// "Only the person who opened this ticket, the @Support role, or someone with
// the Kick Members permission can close it."
export function closeRequirementText(guildId, ticket) {
  const roles = ticketSupportRoles(guildId, ticket).map(r => `<@&${r}>`);
  const who = ['the person who opened this ticket'];
  if (roles.length) who.push(`the ${roles.join(' or ')} role`);
  who.push(`someone with ${requirementPhrase(guildId, 'close', Permissions.KICK_MEMBERS)}`);
  return `Only ${who.slice(0, -1).join(', ')}, or ${who.at(-1)} can close it.`;
}
