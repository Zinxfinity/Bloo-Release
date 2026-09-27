// ─── Ticket lifecycle, open / close / reopen ──────────────────────────────────

import db from '../../db.js';
import logger from '../../utils/logger.js';
import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';
import { getPrefix } from '../guildSettings.js';
import { stmts } from './schema.js';
import { getTicketConfig, normalizeKeyword, getOptionByEmoji, getTicketOptions } from './config.js';
import { buildTicketOverwrites, lockTicketChannel } from './permissions.js';

// ─── Case ID generation ───────────────────────────────────────────────────────
// case_id format: Ticket-{Category}-{seq4}, where Category comes from the
// option's admin-chosen keyword (e.g. "bug"), falling back to its label for
// options that never got one. case_id is globally UNIQUE (see schema.js), so
// the sequence is the max across ALL guilds sharing this category, not just
// the current one, to avoid collisions between e.g. two different guilds'
// first "General" ticket, or two guilds both using the "bug" keyword.
function generateCaseId({ label, keyword } = {}) {
  const slug     = normalizeKeyword(keyword, label);
  const category = slug.charAt(0).toUpperCase() + slug.slice(1);
  const prefix   = `Ticket-${category}-`;
  let maxSeq = 0;
  for (const { case_id } of stmts.getAllCaseIds.all()) {
    if (!case_id?.startsWith(prefix)) continue;
    const tail = parseInt(case_id.slice(prefix.length), 10);
    if (Number.isFinite(tail) && tail > maxSeq) maxSeq = tail;
  }
  const seq = String(maxSeq + 1).padStart(4, '0');
  return { caseId: `${prefix}${seq}`, slug };
}

// ─── Short ID lookup ──────────────────────────────────────────────────────────
function findTicketByShortId(guildId, shortId) {
  // shortId may be e.g. 'support-0003' (without guild prefix)
  if (!shortId) return null;
  return stmts.findByShortId.get(guildId, shortId, String(shortId).replace(/[%_]/g, '')) ?? null;
}

// Used by ticketfix.js's `orphan` repair to attach a DB record to an existing
// channel that was created but lost its DB row (e.g. via crash mid-openTicket).
// Does NOT create the channel, caller has already verified it exists.
export function registerExistingTicket({ guildId, channelId, userId, username, optionLabel, optionEmoji }) {
  const { caseId } = generateCaseId({ label: optionLabel });
  stmts.insertCase.run(
    guildId,
    caseId,
    userId,
    username ?? userId,
    channelId,
    optionLabel ?? 'Support',
    optionEmoji ?? null
  );
  return { caseId };
}

// ─── openTicket ───────────────────────────────────────────────────────────────
export async function openTicket(client, guildId, userId, username, option) {
  if (stmts.isBlacklisted.get(guildId, userId)) {
    return { ok: false, reason: 'blacklisted' };
  }

  const config = getTicketConfig(guildId);
  if (!config) return { ok: false, reason: 'no-config' };

  // One active ticket per category (option_label), not per user overall, so
  // a user can hold e.g. one open Support ticket and one open Billing ticket
  // at the same time, but not two Support tickets. This is the primary
  // guard, always effective regardless of whether the partial unique index
  // below could be created on this install.
  const optionLabel = option?.label ?? null;
  const existingOpen = stmts.getOpenByUserOption.get(guildId, userId, optionLabel)
                     ?? stmts.getCreatingByUserOption.get(guildId, userId, optionLabel);
  if (existingOpen) {
    return { ok: false, reason: 'already-open', existing: existingOpen };
  }

  const { caseId, slug } = generateCaseId(option ?? {});

  // Atomic second guard: idx_ticket_one_active_per_user_category (schema.js)
  // makes this insert itself race-free against two near-simultaneous open
  // attempts (same category) both passing the check above before either
  // claim lands. If that index couldn't be created on this install, this is
  // just a plain insert, the explicit check above still covers the normal
  // case.
  try {
    stmts.claimCase.run(guildId, caseId, userId, username, optionLabel, option?.emoji ?? null);
  } catch (err) {
    if (/UNIQUE constraint failed/.test(err.message ?? '')) {
      const existing = stmts.getOpenByUserOption.get(guildId, userId, optionLabel)
                     ?? stmts.getCreatingByUserOption.get(guildId, userId, optionLabel);
      return { ok: false, reason: 'already-open', existing };
    }
    throw err;
  }

  const guild = client.guilds?.cache?.get(guildId)
             ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    stmts.failCase.run('Guild not found', caseId);
    return { ok: false, reason: 'no-guild' };
  }

  // Channel name mirrors the case ID's keyword (e.g. "bug"), not the opener's
  // username, so staff can tell what a ticket's about at a glance in the
  // channel list, same word an admin picked via !ticket option keyword.
  // The "ticket-" label itself is optional per-option (buildChannelName),
  // for categories that don't read like a support request, e.g. "partner".
  const channelName = buildChannelName(slug, caseId, option);

  let channel;
  try {
    const body = {
      name:   channelName,
      type:   0,
      // caseId already reads as "Ticket-Report-0009" on its own, no extra
      // "Ticket " label needed in front of it.
      topic:  `${caseId}, opened by ${username}`,
      permission_overwrites: buildTicketOverwrites(guildId, userId, config, option),
    };
    // Per-category channel destination: the option's own category_id
    // (e.g. "Partners" tickets landing in a different channel group than
    // "Support" ones), falling back to the guild-wide default.
    const parentId = option?.category_id ?? config.category_id;
    if (parentId) body.parent_id = parentId;

    channel = await client.rest.post(`/guilds/${guildId}/channels`, { body });
  } catch (err) {
    logger.warn(`[TICKET] Failed to create channel for ${caseId}:`, err.message);
    // Releases the claim from above (status -> 'failed', no longer matches
    // the partial index's WHERE clause), so this user isn't locked out of
    // opening a real ticket by a claim that never got a channel.
    stmts.failCase.run(err.message?.slice(0, 300) ?? 'channel-create-failed', caseId);
    return { ok: false, reason: 'channel-create-failed' };
  }

  stmts.activateCase.run(channel.id, guildId, caseId);

  // Send opening embed
  const closeEmoji = config.close_emoji || '❌';
  try {
    const pfx = getPrefix(guildId) ?? 'b!';
    // Same support-role fallback as buildTicketOverwrites(): the option's
    // own role if it has one, else the guild-wide default.
    const roleId = option?.support_role_id ?? config.support_role_id;
    // Custom opening messages document {user} {role} {ticket} {label}
    // placeholders (both the dashboard's Opening Message field and
    // !ticket option message say so), but nothing ever actually substituted
    // them, they rendered as the literal text "{user}" etc. in the embed.
    // The built-in default below doesn't need this, it's already
    // hand-written with the right mention baked in.
    const openingMsg = option?.opening_message
      ? option.opening_message
          .replace(/\{user\}/g, `<@${userId}>`)
          .replace(/\{role\}/g, roleId ? `<@&${roleId}>` : 'the support team')
          .replace(/\{ticket\}/g, caseId)
          .replace(/\{label\}/g, option?.label ?? 'Ticket')
      : `Hello <@${userId}>, a staff member will be with you shortly.\nReact ${closeEmoji} to any message in this ticket to close it, or run \`${pfx}close\`.`;

    const embed = new EmbedBuilder()
      .setColor(COLORS.SUCCESS)
      .setTitle(`${option?.label ?? 'Ticket'} #${caseId.slice(-4)}`)
      .setDescription(openingMsg)
      .setTimestamp();

    const raw = embed.toJSON();
    if (config.icon_url)   raw.thumbnail = { url: config.icon_url };
    if (config.banner_url) raw.image     = { url: config.banner_url };

    // Real mentions outside the embed, so this actually pings the opener and
    // support team instead of just showing their names inside embed text
    // (embed mentions don't notify anyone).
    const pingLine = `<@${userId}>${roleId ? ` <@&${roleId}>` : ''}`;

    const opening = await client.rest.post(`/channels/${channel.id}/messages`, { body: { content: pingLine, embeds: [raw] } });

    // Pre-react with the close emoji so there's actually something visible
    // to click, matching how postTicketPanel() pre-adds a reaction per
    // option, handleCloseReaction() itself works on any message in the
    // channel, but nothing was ever putting the emoji on screen for anyone
    // to react to it in the first place.
    if (opening?.id) {
      try {
        const emojiPath = closeEmoji.includes(':') ? encodeURIComponent(closeEmoji) : closeEmoji;
        await client.rest.put(`/channels/${channel.id}/messages/${opening.id}/reactions/${emojiPath}/@me`);
      } catch { /* non-fatal, e.g. missing Add Reactions permission */ }
    }
  } catch { /* opening message failure is non-fatal */ }

  return { ok: true, caseId, channelId: channel.id };
}

// Slug this ticket's case ID currently reads as, e.g. "Ticket-Partner-0001"
// -> "partner". Shared by the rename-detection path and the manual !ticket
// type command, both need to know the current category to tell whether a
// requested change is actually a change.
function getCategorySlugFromCaseId(caseId) {
  const match = String(caseId ?? '').match(/^Ticket-([A-Za-z0-9]+)-\d+$/);
  return match ? match[1].toLowerCase() : null;
}

// Channel name for a given slug/case, honoring the option's own no_prefix
// setting (e.g. "partner-0001" instead of "ticket-partner-0001" for a
// category that opted out of the generic "ticket-" label, typically because
// it's used for something that doesn't read like a support request).
function buildChannelName(slug, caseId, option) {
  const seq = caseId.slice(-4);
  return option?.no_prefix ? `${slug}-${seq}` : `ticket-${slug}-${seq}`;
}

// ─── recategorizeTicket ───────────────────────────────────────────────────────
// Moves an open ticket to a different, already-configured category: fresh
// case ID under the new category, transcript carried over, role/channel
// routing re-applied, channel renamed to match, and an in-channel notice
// posted (and captured into the transcript, bot messages don't reach
// captureMessage via the normal message path). Shared by handleTicketRename
// (auto-detected via a staff channel rename) and the explicit `!ticket type`
// command (chosen directly, no rename required).
export async function recategorizeTicket(client, guildId, ticket, matchedOption) {
  const oldCaseId = ticket.case_id;
  const { caseId: newCaseId, slug } = generateCaseId({ label: matchedOption.label, keyword: matchedOption.keyword });

  stmts.recategorizeCase.run(newCaseId, matchedOption.label, matchedOption.emoji, guildId, oldCaseId);

  const transcriptMod = await import('../ticketTranscript.js').catch(() => ({}));

  // Carry the already-captured transcript over to the new case ID too,
  // otherwise every message sent before this rename silently drops out of
  // the transcript the moment the ticket's identity moves to newCaseId
  // (handlers/ticketTranscript.js's own table is keyed by case_id, and
  // ticket_cases no longer has a row under oldCaseId after the update above).
  try {
    transcriptMod.reassignTranscript?.(oldCaseId, newCaseId);
  } catch (err) {
    logger.warn(`[TICKET] Could not carry transcript from ${oldCaseId} to ${newCaseId}:`, err.message);
  }

  // Re-apply the new option's routing (role visibility + channel category),
  // same as a freshly opened ticket under this option would get.
  const config = getTicketConfig(guildId);
  try {
    await client.rest.patch(`/channels/${ticket.channel_id}`, {
      body: {
        name: buildChannelName(slug, newCaseId, matchedOption),
        parent_id: matchedOption.category_id ?? config?.category_id ?? null,
        permission_overwrites: buildTicketOverwrites(guildId, ticket.user_id, config, matchedOption),
      },
    });
  } catch (err) {
    logger.warn(`[TICKET] Recategorised ${oldCaseId} -> ${newCaseId} but channel update failed:`, err.message);
  }

  // In Bloo's own voice, not a bare system log line, this is user-facing.
  try {
    const notice = new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle('🫧 Bloo System Notice')
      .setDescription(
        `This ticket has been recategorized to **${matchedOption.label}**.\n\n` +
        `Case \`${newCaseId}\` (previously \`${oldCaseId}\`), routing has been updated to match.`
      )
      .setTimestamp();
    const rawNotice = notice.toJSON();
    const sent = await client.rest.post(`/channels/${ticket.channel_id}/messages`, { body: { embeds: [rawNotice] } });

    // Bot messages never reach captureMessage via the normal messageCreate
    // path (events/guild/messageCreate.js bails out for bot authors before
    // it's ever called), so without this Bloo's own recategorisation notice
    // would be the one message missing from an otherwise-continuous
    // transcript, right at the exact point a reader would want it most.
    if (sent?.id && transcriptMod.captureMessage) {
      transcriptMod.captureMessage({
        channelId: ticket.channel_id,
        id: sent.id,
        author: { id: client.user?.id ?? 'bloo', username: client.user?.username ?? 'Bloo', bot: true },
        content: '',
        embeds: [rawNotice],
        attachments: [],
      });
    }
  } catch { /* non-fatal */ }

  logger.info(`[TICKET] Recategorised ${oldCaseId} -> ${newCaseId} in ${guildId}`);
  return { ok: true, oldCaseId, newCaseId };
}

// ─── handleTicketRename ───────────────────────────────────────────────────────
// Called from events/guild/channelUpdate.js when a ticket channel's name
// changes. If the new name matches a DIFFERENT option's keyword than the
// ticket's current category (e.g. renamed from ticket-partner-0001 to
// ticket-support-something), recategorizes it via recategorizeTicket(). A
// rename that doesn't match any known option's keyword, or matches the
// ticket's current category unchanged, is left alone, this only acts on an
// unambiguous category change. The "ticket-" label is optional here too, an
// option with no_prefix set (see buildChannelName) is renamed without it,
// e.g. straight to "partner-0001".
export async function handleTicketRename(client, guildId, channelId, newName) {
  const ticket = stmts.getCaseByChannel.get(channelId);
  if (!ticket || ticket.guild_id !== guildId || ticket.status !== 'open') return { ok: false, reason: 'not-open-ticket' };

  const nameMatch = String(newName ?? '').match(/^(?:ticket-)?([a-z0-9]+)-\d+$/i);
  if (!nameMatch) return { ok: false, reason: 'name-not-recognised' };
  const newSlug = nameMatch[1].toLowerCase();

  const currentSlug = getCategorySlugFromCaseId(ticket.case_id);
  if (currentSlug === newSlug) return { ok: false, reason: 'same-category' };

  const options = getTicketOptions(guildId);
  const matchedOption = options.find(o => normalizeKeyword(o.keyword, o.label) === newSlug);
  if (!matchedOption) return { ok: false, reason: 'unknown-category' };

  return recategorizeTicket(client, guildId, ticket, matchedOption);
}

// ─── closeTicket ─────────────────────────────────────────────────────────────
// deleteChannel: false lets closeTicketWithNotice close the DB record without
// also deleting the channel out from under its own delayed-notice flow.
export async function closeTicket(client, guildId, caseId, closedBy, reason, { deleteChannel = true } = {}) {
  const ticket = stmts.getCase.get(guildId, caseId)
              ?? findTicketByShortId(guildId, caseId);

  if (!ticket) return { ok: false, reason: 'not-found' };
  if (ticket.status === 'closed') return { ok: false, reason: 'already-closed' };

  // Flush transcript to DB before closing so messages survive channel deletion
  const { flushTranscript } = await import('../ticketTranscript.js').catch(() => ({}));
  const msgCount = flushTranscript ? flushTranscript(ticket.case_id) : 0;

  // Conditional update: two near-simultaneous closes (e.g. two close
  // reactions) both pass the status check above across the await; only the
  // first write wins, the second reports already-closed.
  if (stmts.closeCase.run(closedBy, reason ?? null, guildId, ticket.case_id).changes === 0) {
    return { ok: false, reason: 'already-closed' };
  }

  if (deleteChannel && ticket.channel_id) {
    try {
      await client.rest.delete(`/channels/${ticket.channel_id}`);
    } catch { /* channel may already be gone */ }
  }

  return { ok: true, ticket, msgCount };
}

// Shared close orchestration used by both `!close` and `!ticket close`: closes
// the DB record, posts a closing embed, and schedules channel deletion after
// `delayMs` (or the guild's configured close_delay_seconds if the caller
// doesn't pass one explicitly) so the participants can see the closing
// message first.
export async function closeTicketWithNotice(client, guildId, ticket, closedBy, reason, { delayMs } = {}) {
  const cfg = getTicketConfig(guildId);
  const channelId = ticket.channel_id;
  const effectiveDelayMs = delayMs ?? (cfg?.close_delay_seconds ?? 10) * 1000;

  const closed = await closeTicket(client, guildId, ticket.case_id, closedBy.id, reason, { deleteChannel: false });
  // Someone else closed it first: don't send a second notice/transcript DM.
  if (!closed.ok) return closed;

  // Re-fetch after closing: the `ticket` parameter is a snapshot the caller
  // fetched before this function ran, closeTicket() above just flipped its
  // status/closed_at/closed_by/close_reason in the DB, using the stale
  // object would generate a transcript that still says "Open".
  const closedTicket = stmts.getCase.get(guildId, ticket.case_id) ?? ticket;

  // DM the ticket opener a full transcript file for their records. Best-effort
  //, the user may have DMs closed to the bot, which isn't fatal to closing.
  // Uses the presigned attachment-upload flow (uploadAttachmentsForSend),
  // not the classic inline `files` option, the latter comes back
  // INVALID_FORM_BODY from this Fluxer API regardless of payload shape,
  // confirmed against both DMs and guild channels. The presigned flow
  // (POST /channels/:id/attachments for an upload plan, PUT the bytes,
  // then reference the result via `uploadedAttachments`) is what this API
  // actually accepts.
  try {
    const { generateFluxerTranscript } = await import('../ticketTranscript.js').catch(() => ({}));
    const user = await client.users.fetch(closedTicket.user_id).catch(() => null);
    const dm   = await user?.createDM?.().catch(() => null);
    if (generateFluxerTranscript && dm) {
      const html = await generateFluxerTranscript(client, guildId, closedTicket);
      const filename = `transcript-${closedTicket.case_id}.html`;
      const uploaded = await dm.uploadAttachmentsForSend([
        { id: 0, filename, data: Buffer.from(html, 'utf-8'), contentType: 'text/html' },
      ]);

      const transcriptEmbed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle('📄  Ticket Transcript')
        .setDescription(`Your ticket \`${ticket.case_id}\` has been closed. A full transcript is attached for your records.`)
        .addFields({ name: '📋  Reason', value: reason, inline: false })
        .setTimestamp();

      await dm.send({ embeds: [transcriptEmbed.toJSON()], uploadedAttachments: uploaded });
    }
  } catch (err) {
    logger.warn(`[TICKET] Could not DM transcript for ${ticket.case_id}:`, err.message);
  }

  // Lock the opener out of sending further messages before posting the
  // closing notice, so the countdown embed reads as final.
  await lockTicketChannel(client, channelId, ticket.user_id);

  const now = Math.floor(Date.now() / 1000);
  const embed = new EmbedBuilder()
    .setTitle('🔒  Ticket Closed')
    .setColor(0xED4245)
    .setDescription(`This ticket has been closed. The channel will be deleted in **${Math.round(effectiveDelayMs / 1000)} seconds**.`)
    .addFields(
      { name: '🆔  Case ID',   value: `\`${ticket.case_id}\``, inline: true  },
      { name: '👤  Opened By', value: ticket.username,          inline: true  },
      { name: '🔒  Closed By', value: closedBy.username,        inline: true  },
      { name: '📋  Reason',    value: reason,                   inline: false },
      { name: '🕐  When',      value: `<t:${now}:R>`,          inline: true  },
    )
    .setTimestamp();

  const raw = embed.toJSON();
  if (cfg?.icon_url)   raw.thumbnail = { url: cfg.icon_url };
  if (cfg?.banner_url) raw.image     = { url: cfg.banner_url };

  await client.rest.post(`/channels/${channelId}/messages`, { body: { embeds: [raw] } }).catch(() => {});

  // Persisted alongside the in-memory setTimeout below, not instead of it:
  // the timeout handles the common case (bot stays up) with no polling
  // delay, this column is the fallback deletionPoller.js sweeps for when a
  // restart happens to land inside the delay window and the timeout is
  // lost with it. Whichever path actually deletes the channel first clears
  // this, so the other doesn't try to delete an already-gone channel.
  stmts.scheduleDelete.run(now + Math.round(effectiveDelayMs / 1000), ticket.id);

  setTimeout(async () => {
    try {
      await client.rest.delete(`/channels/${channelId}`);
    } catch (err) {
      logger.error(`[TICKET] Could not delete channel ${channelId}:`, err.message);
    } finally {
      stmts.clearDeleteSchedule.run(ticket.id);
    }
  }, effectiveDelayMs);
}

// ─── reopenTicket ─────────────────────────────────────────────────────────────
export async function reopenTicket(client, guildId, caseId, reopenedBy, userId) {
  const ticket = stmts.getCase.get(guildId, caseId)
              ?? findTicketByShortId(guildId, caseId);

  if (!ticket) return { ok: false, reason: 'not-found' };
  if (ticket.status === 'open') return { ok: false, reason: 'already-open' };

  const config = getTicketConfig(guildId);
  // Recover the original option (if it still exists) from the closed
  // ticket's stored emoji, so reopening lands back under the same
  // per-category role/channel routing it was opened with, rather than
  // silently falling back to the guild default for every reopen.
  const option = getOptionByEmoji(guildId, ticket.option_emoji);

  let channel;
  try {
    const body = {
      name: `ticket-reopen-${ticket.case_id.slice(-4)}`,
      type: 0,
      permission_overwrites: buildTicketOverwrites(guildId, userId, config, option),
    };
    const parentId = option?.category_id ?? config?.category_id;
    if (parentId) body.parent_id = parentId;
    channel = await client.rest.post(`/guilds/${guildId}/channels`, { body });
  } catch (err) {
    logger.warn(`[TICKET] Failed to create reopen channel for ${caseId}:`, err.message);
    return { ok: false, reason: 'channel-create-failed' };
  }

  stmts.reopenCase.run(channel.id, guildId, ticket.case_id);
  return { ok: true, ticket, channelId: channel.id };
}

export function getTicketByCase(guildId, caseId) {
  return stmts.getCase.get(guildId, caseId) ?? findTicketByShortId(guildId, caseId) ?? null;
}

export function getTicketByChannel(channelId) {
  return stmts.getCaseByChannel.get(channelId) ?? null;
}

export function listOpenTickets(guildId) {
  return stmts.listOpen.all(guildId);
}

export function listTickets(guildId) {
  return stmts.listAll.all(guildId);
}

// Used by ticketfix.js to find a ticket in 'creating' state (mid-open, before
// the channel was finalised).
export function getCreatingTicketByUser(guildId, userId) {
  return stmts.getCreatingByUser.get(guildId, userId) ?? null;
}

export function getOpenTicketByUser(guildId, userId) {
  return stmts.getOpenByUser.get(guildId, userId) ?? null;
}

export function getTicketsByUser(guildId, userId, { limit = 5 } = {}) {
  return stmts.getByUser.all(guildId, userId, limit);
}

// Mark a ticket as failed (closed with a failure reason). Used by ticketfix.js
// to clear broken tickets without going through the normal close flow.
export function failTicket(caseId, reason) {
  stmts.failCase.run(reason ?? 'Marked as failed', caseId);
}
