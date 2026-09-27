// ─── Ticket panel, posting and reaction routing ───────────────────────────────

import logger from '../../utils/logger.js';
import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';
import { stmts } from './schema.js';
import { getTicketConfig, getTicketOptions } from './config.js';
import { openTicket, closeTicketWithNotice } from './lifecycle.js';
import { resolveAccess } from '../commandPermissions.js';
import { Permissions } from '../../config/guildPermissions.js';
import { sameEmoji } from '../reactionRoles.js';

// ticket_options.emoji is stored as bare "name:id" (handleTicketReaction's
// own matching format below expects this, no <a?:...> markup and no "a_"
// prefix, animated and static are stored identically), but that raw form
// doesn't render as an actual emoji image in message/embed text, only the
// <:name:id> markup does. Matches commands/moderation/ticket/helpers.js's
// buildPanelEmbed() and dashboard/routes/tickets.js's own displayEmoji().
function displayEmoji(stored) {
  if (!stored) return '';
  const custom = String(stored).match(/^(\w+):(\d+)$/);
  return custom ? `<:${custom[1]}:${custom[2]}>` : stored;
}

export async function postTicketPanel(client, guildId) {
  const config  = getTicketConfig(guildId);
  const options = getTicketOptions(guildId);

  if (!config?.channel_id) return { ok: false, reason: 'no-channel' };

  const embed = new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle(config.title)
    .setDescription(
      config.description +
      (options.length
        ? '\n\n' + options.map(o => `${displayEmoji(o.emoji)} — **${o.label}**`).join('\n')
        : '')
    );

  const raw = embed.toJSON();
  if (config.icon_url)   raw.thumbnail = { url: config.icon_url };
  if (config.banner_url) raw.image     = { url: config.banner_url };

  try {
    const msg = await client.rest.post(
      `/channels/${config.channel_id}/messages`,
      { body: { embeds: [raw] } }
    );

    for (const option of options) {
      try {
        const emoji = option.emoji.includes(':')
          ? encodeURIComponent(option.emoji)
          : option.emoji;
        await client.rest.put(
          `/channels/${config.channel_id}/messages/${msg.id}/reactions/${emoji}/@me`
        );
      } catch { /* non-fatal */ }
    }

    stmts.setConfigField('panel_message_id').run(msg.id, guildId);

    return { ok: true, messageId: msg.id };
  } catch (err) {
    logger.warn(`[TICKET] Failed to post panel in ${guildId}:`, err.message);
    return { ok: false, reason: err.message };
  }
}

// Called from events/guild/reactionAdd.js when any reaction is added.
// Returns true if this was a ticket panel reaction and was handled, false
// otherwise (lets the caller fall through to other reaction handlers).
//
// Flow:
//   1. Look up the ticket config for this guild
//   2. Check if message_id matches the configured panel message
//   3. Resolve the emoji to a ticket option
//   4. Call openTicket() to create the ticket channel
//   5. Best-effort remove the user's reaction so the panel stays clean
export async function handleTicketReaction(client, reaction, userId, guildId, channelId, messageId, emoji) {
  if (!guildId || !messageId || !emoji) return false;

  const config = getTicketConfig(guildId);
  if (!config?.panel_message_id || config.panel_message_id !== messageId) return false;

  const options = getTicketOptions(guildId);
  if (!options.length) return false;

  // Match by emoji ID (custom emoji) or by unicode name. Fluxer strips the
  // U+FE0F variation selector from reaction payloads, so stored emoji values
  // must be compared with it stripped too.
  const VARIATION_SELECTOR = /️/g;
  const reactionKey = emoji.id
    ? `${emoji.name}:${emoji.id}`
    : (emoji.name ?? '').replace(VARIATION_SELECTOR, '');
  const matched = options.find(o => {
    const stored = (o.emoji ?? '').replace(VARIATION_SELECTOR, '');
    return stored === reactionKey || stored === emoji.name;
  });
  if (!matched) return false;

  try {
    const emojiPath = emoji.id
      ? encodeURIComponent(`${emoji.name}:${emoji.id}`)
      : encodeURIComponent(emoji.name);
    await client.rest.delete(`/channels/${channelId}/messages/${messageId}/reactions/${emojiPath}/${userId}`).catch(() => {});
  } catch { /* non-fatal */ }

  // Category temporarily turned off (e.g. "not offering partnerships right
  // now"), stays visible on the panel so people can still see it exists, but
  // reacting DMs an explanation instead of creating a ticket.
  if (!matched.enabled) {
    try {
      const user = await client.users.fetch(userId);
      const dm   = await user.createDM();
      const text = (matched.disabled_message?.trim() || `${matched.label} tickets are not being accepted right now. Please check back later.`)
        .replace(/\{label\}/g, matched.label);
      await dm.send({ content: text });
    } catch { /* DMs may be closed */ }
    return true;
  }

  // Guild nickname, then global display name, then the plain account
  // username, matching messageLogger.js/ticketTranscript.js's priority
  // order elsewhere in this codebase. Plain `username` alone can be a short
  // handle that doesn't match what the member actually goes by (a real
  // account had one just one character long), and that's what used to get
  // stored here and baked permanently into the channel topic, case lookup,
  // and transcript, since nothing else re-resolves it after ticket open.
  let username = userId;
  try {
    const member = await client.rest.get(`/guilds/${guildId}/members/${userId}`).catch(() => null);
    username = member?.nick ?? member?.user?.global_name ?? member?.user?.username ?? userId;
  } catch { /* fall back to id */ }

  const result = await openTicket(client, guildId, userId, username, matched);
  if (!result.ok && result.reason === 'already-open') {
    // Best-effort DM, matching the DM-then-silently-fail-if-closed pattern
    // used elsewhere in this codebase (welcomeSystem.js, antiRaid/captcha.js).
    // handleTicketReaction has no other user-facing surface, tickets are
    // opened via reaction, not a command that could reply in-channel.
    try {
      const user = await client.users.fetch(userId);
      const dm    = await user.createDM();
      const channelHint = result.existing?.channel_id ? ` <#${result.existing.channel_id}>` : '';
      const categoryHint = matched?.label ? ` ${matched.label}` : '';
      await dm.send({ content: `You already have an open${categoryHint} ticket${channelHint}, close it before opening another one.` });
    } catch { /* DMs may be closed */ }
  }
  return true;
}

// Called from events/guild/reactionAdd.js on any reaction, `key` is the
// already-normalised emojiKey() output (variation selector stripped,
// custom emoji as "name:id"). Works on ANY message inside an open ticket
// channel, not just a specific registered one, matching how !close works
// on the channel itself rather than a particular message. Same access
// rule as !close/!ticket close: the ticket's own opener, or mod-tier
// (default Kick Members, per-guild configurable via the same 'close'
// permission key those commands already use).
export async function handleCloseReaction(client, guildId, channelId, key, userId, reactingUser) {
  const config = getTicketConfig(guildId);
  // No configured emoji falls back to the default ❌, not "feature off",
  // reacting to close is meant to work out of the box, customising it is
  // the opt-in part, not the feature's existence.
  const closeEmoji = (config?.close_emoji || '❌').replace(/️/g, '');
  if (!sameEmoji(key, closeEmoji)) return false; // by emoji ID for custom, so animated close emoji match too

  const ticket = stmts.getCaseByChannel.get(channelId);
  if (!ticket || ticket.guild_id !== guildId || ticket.status !== 'open') return false;

  const isOwner = ticket.user_id === userId;
  const isMod   = isOwner || await resolveAccess(client, guildId, userId, 'close', Permissions.KICK_MEMBERS);
  if (!isMod) return false;

  await closeTicketWithNotice(client, guildId, ticket, reactingUser, 'Closed via reaction');
  return true;
}
