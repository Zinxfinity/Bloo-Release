// ============================================================
//  handlers/echoSystem.js
//
//  Cross-server announcement relay. A guild designates a channel as a
//  "publisher", messages posted there get echoed, via webhook (so the
//  relayed post is attributed to the original author's name/avatar), into
//  any "subscriber" channel that publisher has approved.
//
//  Two independent opt-ins gate everything, mirroring serverGroups.js's
//  ban-sync model: the publisher's guild must have the feature enabled AND
//  approve the specific subscriber channel; the subscriber's guild must
//  independently have the feature enabled AND register that channel itself
//  before it can even be requested. Neither side can push content into a
//  guild that hasn't opted in on their end.
//
//  Hard caps (deliberately tight, this is the only feature in the bot that
//  lets one guild's content appear in another's channels):
//    - MAX_CHANNELS_PER_GUILD (2)  , total echo_channels rows a guild may
//      register, publisher + subscriber roles combined.
//    - MAX_APPROVED_PER_PUBLISHER (2), approved subscriptions per publisher
//      channel. Pending requests beyond this can still queue; approval is
//      what's capped.
//    - ECHO_MAX_PER_MINUTE (.env, default 10), sliding-window rate limit
//      per publisher channel, so a spam burst can't flood every subscriber.
//
//  Loop safety: relayEcho() refuses to relay any message that already has a
//  webhookId (i.e. it's a relayed copy, or from an unrelated webhook), a
//  subscriber channel that's also configured as a publisher elsewhere can
//  never re-broadcast content it received via echo, only its own original
//  posts. See events/guild/messageCreate.js for the call site and
//  events/guild/guildDelete.js for cleanup when either side leaves.
// ============================================================

import { Webhook } from '@fluxerjs/core';
import db          from '../db.js';
import logger      from '../utils/logger.js';

export const MAX_CHANNELS_PER_GUILD    = 2;
export const MAX_APPROVED_PER_PUBLISHER = 2;

db.exec(`
  CREATE TABLE IF NOT EXISTS echo_settings (
    guild_id TEXT PRIMARY KEY,
    enabled  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS echo_channels (
    guild_id      TEXT NOT NULL,
    channel_id    TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('publisher', 'subscriber')),
    webhook_id    TEXT,
    webhook_token TEXT,
    created_by    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );
  CREATE INDEX IF NOT EXISTS idx_echo_channels_channel ON echo_channels (channel_id);

  CREATE TABLE IF NOT EXISTS echo_subscriptions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    publisher_guild_id    TEXT    NOT NULL,
    publisher_channel_id  TEXT    NOT NULL,
    subscriber_guild_id   TEXT    NOT NULL,
    subscriber_channel_id TEXT    NOT NULL,
    requested_by          TEXT    NOT NULL,
    status                TEXT    NOT NULL DEFAULT 'pending', -- pending | approved | denied
    created_at            INTEGER NOT NULL,
    decided_at            INTEGER,
    decided_by            TEXT,
    UNIQUE (publisher_channel_id, subscriber_channel_id)
  );
  CREATE INDEX IF NOT EXISTS idx_echo_subs_publisher  ON echo_subscriptions (publisher_channel_id, status);
  CREATE INDEX IF NOT EXISTS idx_echo_subs_subscriber ON echo_subscriptions (subscriber_guild_id);
`);

// ─── Settings ───────────────────────────────────────────────────────────────

export function isEnabled(guildId) {
  const row = db.prepare('SELECT enabled FROM echo_settings WHERE guild_id = ?').get(guildId);
  return !!row?.enabled;
}

export function setEnabled(guildId, enabled) {
  db.prepare(`
    INSERT INTO echo_settings (guild_id, enabled) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET enabled = excluded.enabled
  `).run(guildId, enabled ? 1 : 0);
}

// ─── Channels ───────────────────────────────────────────────────────────────

export function getChannels(guildId) {
  return db.prepare('SELECT * FROM echo_channels WHERE guild_id = ? ORDER BY created_at ASC').all(guildId);
}

export function getChannel(guildId, channelId) {
  return db.prepare('SELECT * FROM echo_channels WHERE guild_id = ? AND channel_id = ?').get(guildId, channelId) ?? null;
}

// Looked up by channel_id alone from the relay hook, which only knows the
// channel a message arrived in, not which guild registered it as what.
function findChannelById(channelId) {
  return db.prepare('SELECT * FROM echo_channels WHERE channel_id = ?').get(channelId) ?? null;
}

export function addChannel(guildId, channelId, role, userId) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM echo_channels WHERE guild_id = ?').get(guildId).n;
  if (count >= MAX_CHANNELS_PER_GUILD) {
    return { ok: false, reason: `This server already has ${MAX_CHANNELS_PER_GUILD} echo channels registered (the max). Remove one first.` };
  }
  const existing = findChannelById(channelId);
  if (existing && existing.guild_id !== guildId) {
    return { ok: false, reason: 'That channel is already registered by another server.' };
  }
  try {
    db.prepare(`
      INSERT INTO echo_channels (guild_id, channel_id, role, created_by, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(guildId, channelId, role, userId, Date.now());
    return { ok: true };
  } catch {
    return { ok: false, reason: 'That channel is already registered.' };
  }
}

export function removeChannel(guildId, channelId) {
  // Tear down anything relying on this channel, a channel can't be removed
  // out from under active subscriptions and leave dangling rows.
  db.prepare('DELETE FROM echo_subscriptions WHERE publisher_channel_id = ? OR subscriber_channel_id = ?').run(channelId, channelId);
  const result = db.prepare('DELETE FROM echo_channels WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId);
  return result.changes > 0;
}

export function saveWebhook(channelId, webhookId, webhookToken) {
  db.prepare('UPDATE echo_channels SET webhook_id = ?, webhook_token = ? WHERE channel_id = ?')
    .run(webhookId, webhookToken, channelId);
}

// ─── Subscriptions ────────────────────────────────────────────────────────

export function requestSubscription(publisherChannelId, subscriberGuildId, subscriberChannelId, userId) {
  const publisher = findChannelById(publisherChannelId);
  if (!publisher || publisher.role !== 'publisher') {
    return { ok: false, reason: 'That channel is not a registered publisher channel.' };
  }
  if (!isEnabled(publisher.guild_id)) {
    return { ok: false, reason: "That publisher's server has echo disabled." };
  }
  const subscriber = getChannel(subscriberGuildId, subscriberChannelId);
  if (!subscriber || subscriber.role !== 'subscriber') {
    return { ok: false, reason: 'Register this channel as a subscriber channel first (`echo channel #channel subscriber`).' };
  }
  if (publisher.guild_id === subscriberGuildId) {
    return { ok: false, reason: "A server can't subscribe to its own publisher channel." };
  }

  try {
    db.prepare(`
      INSERT INTO echo_subscriptions
        (publisher_guild_id, publisher_channel_id, subscriber_guild_id, subscriber_channel_id, requested_by, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(publisher.guild_id, publisherChannelId, subscriberGuildId, subscriberChannelId, userId, Date.now());
    return { ok: true };
  } catch {
    return { ok: false, reason: 'A subscription between these two channels already exists.' };
  }
}

export function getSubscription(id) {
  return db.prepare('SELECT * FROM echo_subscriptions WHERE id = ?').get(id) ?? null;
}

export function approveSubscription(id, approverGuildId, userId) {
  const sub = getSubscription(id);
  if (!sub) return { ok: false, reason: 'Subscription request not found.' };
  if (sub.publisher_guild_id !== approverGuildId) {
    return { ok: false, reason: "This request isn't for a publisher channel in this server." };
  }
  if (sub.status !== 'pending') {
    return { ok: false, reason: `That request is already ${sub.status}.` };
  }
  const approvedCount = db.prepare(`
    SELECT COUNT(*) AS n FROM echo_subscriptions WHERE publisher_channel_id = ? AND status = 'approved'
  `).get(sub.publisher_channel_id).n;
  if (approvedCount >= MAX_APPROVED_PER_PUBLISHER) {
    return { ok: false, reason: `This publisher channel already has ${MAX_APPROVED_PER_PUBLISHER} approved subscribers (the max). Revoke one first.` };
  }
  db.prepare(`UPDATE echo_subscriptions SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?`)
    .run(Date.now(), userId, id);
  return { ok: true, sub };
}

export function denySubscription(id, approverGuildId, userId) {
  const sub = getSubscription(id);
  if (!sub) return { ok: false, reason: 'Subscription request not found.' };
  if (sub.publisher_guild_id !== approverGuildId) {
    return { ok: false, reason: "This request isn't for a publisher channel in this server." };
  }
  db.prepare(`UPDATE echo_subscriptions SET status = 'denied', decided_at = ?, decided_by = ? WHERE id = ?`)
    .run(Date.now(), userId, id);
  return { ok: true, sub };
}

// Either the publisher or subscriber side can revoke an active subscription.
export function revokeSubscription(id, requestingGuildId) {
  const sub = getSubscription(id);
  if (!sub) return { ok: false, reason: 'Subscription not found.' };
  if (sub.publisher_guild_id !== requestingGuildId && sub.subscriber_guild_id !== requestingGuildId) {
    return { ok: false, reason: "That subscription doesn't involve this server." };
  }
  db.prepare('DELETE FROM echo_subscriptions WHERE id = ?').run(id);
  return { ok: true, sub };
}

export function listSubscriptionsForGuild(guildId) {
  return db.prepare(`
    SELECT * FROM echo_subscriptions
    WHERE publisher_guild_id = ? OR subscriber_guild_id = ?
    ORDER BY created_at DESC
  `).all(guildId, guildId);
}

// ─── Cleanup (called from events/guild/guildDelete.js) ───────────────────────

export function purgeGuild(guildId) {
  db.prepare(`
    DELETE FROM echo_subscriptions WHERE publisher_guild_id = ? OR subscriber_guild_id = ?
  `).run(guildId, guildId);
  db.prepare('DELETE FROM echo_channels WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM echo_settings WHERE guild_id = ?').run(guildId);
}

// ─── Relay ────────────────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 2000;

// In-memory sliding window, per publisher channel. Reset on process restart —
// fine, a restart is itself a natural cooldown.
const _rateWindow = new Map(); // channelId -> timestamps[]

function isRateLimited(channelId) {
  const limit = parseInt(process.env.ECHO_MAX_PER_MINUTE ?? '10', 10);
  const now   = Date.now();
  const times = (_rateWindow.get(channelId) ?? []).filter(t => now - t < 60_000);
  if (times.length >= limit) {
    _rateWindow.set(channelId, times);
    return true;
  }
  times.push(now);
  _rateWindow.set(channelId, times);
  return false;
}

async function getOrCreateWebhook(client, channel, channelRow) {
  if (channelRow.webhook_id && channelRow.webhook_token) {
    return { id: channelRow.webhook_id, token: channelRow.webhook_token };
  }
  const webhook = await channel.createWebhook({ name: 'Bloo Echo' });
  saveWebhook(channel.id, webhook.id, webhook.token);
  return { id: webhook.id, token: webhook.token };
}

function buildRelayContent(message) {
  let content = message.content ?? '';
  // Attachments aren't re-uploaded, just linked, Fluxer/Discord-style
  // clients auto-unfurl a bare URL, so this still carries images/files
  // through in practice without the complexity of downloading and
  // re-uploading bytes through the webhook.
  const urls = [...(message.attachments?.values() ?? [])].map(a => a.url).filter(Boolean);
  if (urls.length) content = [content, ...urls].filter(Boolean).join('\n');
  return content.slice(0, MAX_CONTENT_LENGTH);
}

// Called from events/guild/messageCreate.js for every non-bot message.
// Cheap early-outs first so the common case (not a publisher channel at
// all) never touches the DB more than once.
export async function relayEcho(client, message) {
  if (!message.guildId) return;          // DMs never relay
  if (message.webhookId) return;         // never re-relay a relayed (or any webhook) message
  if (message.author?.bot) return;

  const publisher = findChannelById(message.channelId);
  if (!publisher || publisher.role !== 'publisher') return;
  if (!isEnabled(publisher.guild_id)) return;

  const subs = db.prepare(`
    SELECT * FROM echo_subscriptions WHERE publisher_channel_id = ? AND status = 'approved'
  `).all(message.channelId);
  if (!subs.length) return;

  if (isRateLimited(message.channelId)) {
    logger.warn(`[ECHO] Rate limit hit for publisher channel ${message.channelId}, dropping relay`);
    return;
  }

  const content   = buildRelayContent(message);
  if (!content) return; // nothing to relay (e.g. embed-only message)

  const username  = message.author?.username ?? 'Unknown';
  const avatarUrl = message.author?.displayAvatarURL?.() ?? undefined;

  for (const sub of subs) {
    if (!isEnabled(sub.subscriber_guild_id)) continue; // subscriber disabled since approval

    const channelRow = getChannel(sub.subscriber_guild_id, sub.subscriber_channel_id);
    if (!channelRow) continue; // channel was unregistered out from under an active sub

    try {
      const channel = await client.channels.fetch(sub.subscriber_channel_id);
      const { id, token } = await getOrCreateWebhook(client, channel, channelRow);
      const webhook = Webhook.fromToken(client, id, token, { channelId: sub.subscriber_channel_id });
      await webhook.send({ content, username, avatarUrl, allowedMentions: { parse: [] } });
    } catch (err) {
      logger.warn(`[ECHO] Relay to channel ${sub.subscriber_channel_id} failed: ${err.message}`);
    }
  }
}
