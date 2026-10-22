import db from '../db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS, danger } from '../config/embeds.js';
import * as resilience from './resilience.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS webhook_feeds (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    url           TEXT    NOT NULL,
    channel_id    TEXT    NOT NULL,
    interval_m    INTEGER NOT NULL DEFAULT 30,
    last_checked  INTEGER NOT NULL DEFAULT 0,
    ping_role_id  TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS webhook_seen (
    feed_id INTEGER PRIMARY KEY,
    last_id TEXT    NOT NULL DEFAULT ''
  );

  -- Real dedup state (see checkFeed()'s item-selection comment below for why
  -- webhook_seen's single last_id, kept above only for the dashboard's
  -- existing display column, isn't enough on its own). A set of recently
  -- posted item ids per feed, not just one cursor.
  CREATE TABLE IF NOT EXISTS webhook_seen_items (
    feed_id INTEGER NOT NULL,
    item_id TEXT    NOT NULL,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (feed_id, item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_seen_items_feed_time
    ON webhook_seen_items (feed_id, seen_at DESC);
`);

// One-time migration: seed webhook_seen_items from whatever single last_id
// each feed already had recorded, so this fix doesn't itself cause a
// one-time repost of every feed's top items the moment it deploys (an
// empty new table would otherwise look identical to "never checked
// before" for every existing feed on the very next tick).
try {
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_migration_state (key TEXT PRIMARY KEY, value TEXT)`);
  const already = db.prepare(`SELECT 1 FROM webhook_migration_state WHERE key = 'seen_items_seed_v1'`).get();
  if (!already) {
    const oldRows = db.prepare(`SELECT feed_id, last_id FROM webhook_seen WHERE last_id != ''`).all();
    const seed = db.prepare(`INSERT OR IGNORE INTO webhook_seen_items (feed_id, item_id, seen_at) VALUES (?, ?, unixepoch())`);
    for (const row of oldRows) seed.run(row.feed_id, row.last_id);
    db.prepare(`INSERT INTO webhook_migration_state (key, value) VALUES ('seen_items_seed_v1', unixepoch())`).run();
  }
} catch { /* best-effort, worst case is one repost cycle for affected feeds */ }

// ─── Schema migrations, run before ANY db.prepare() call ────────────────────
for (const col of [
  `ALTER TABLE webhook_feeds ADD COLUMN last_checked INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE webhook_feeds ADD COLUMN ping_role_id TEXT`,
  `ALTER TABLE webhook_feeds ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE webhook_feeds ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE webhook_feeds ADD COLUMN first_fail_at INTEGER`,
  `ALTER TABLE webhook_feeds ADD COLUMN auto_disabled_at INTEGER`,
]) { try { db.exec(col); } catch { /* already exists */ } }

// Some deployments' webhook_feeds table predates this file (created by an
// older dashboard/bot version) and already has added_by/added_at/display_name
// as real columns, added_by specifically NOT NULL with no default. Detected
// at runtime rather than assumed, so the INSERT works whether or not a given
// database actually has these legacy columns, instead of throwing a NOT NULL
// constraint failure on any table that does.
const _feedCols = db.prepare(`PRAGMA table_info(webhook_feeds)`).all().map(c => c.name);
const _EXTRA_INSERT_COLS = ['added_by', 'added_at', 'display_name'].filter(c => _feedCols.includes(c));

const stmts = {
  list:          db.prepare(`SELECT * FROM webhook_feeds WHERE enabled = 1`),
  listGuild:     db.prepare(`SELECT * FROM webhook_feeds WHERE guild_id = ?`),
  get:           db.prepare(`SELECT * FROM webhook_feeds WHERE id = ?`),
  add:           db.prepare(`
    INSERT INTO webhook_feeds (guild_id, name, url, channel_id, interval_m, ping_role_id${_EXTRA_INSERT_COLS.map(c => `, ${c}`).join('')})
    VALUES (?, ?, ?, ?, ?, ?${_EXTRA_INSERT_COLS.map(() => ', ?').join('')})
  `),
  remove:        db.prepare(`DELETE FROM webhook_feeds WHERE id = ? AND guild_id = ?`),
  // Re-enabling (either manually or, if that's ever added, automatically)
  // clears auto_disabled_at, a feed that's live again is no longer a
  // candidate for the stale-auto-disabled cleanup sweep below. Manually
  // disabling deliberately does NOT set auto_disabled_at, only trackFailure's
  // disableById does, that's what distinguishes "the user chose to pause
  // this" (never swept) from "the system gave up on this" (swept after the
  // grace period).
  setEnabled:    db.prepare(`
    UPDATE webhook_feeds
    SET enabled = ?, auto_disabled_at = CASE WHEN ? = 1 THEN NULL ELSE auto_disabled_at END
    WHERE id = ? AND guild_id = ?
  `),
  updateCheck:   db.prepare(`UPDATE webhook_feeds SET last_checked = unixepoch() WHERE id = ?`),
  // Legacy single-cursor table: kept updated only for the dashboard's
  // existing "last seen" display column (dashboard/routes/webhooks.js),
  // no longer read for dedup logic, see webhook_seen_items below.
  upsertSeen:    db.prepare(`INSERT OR REPLACE INTO webhook_seen (feed_id, last_id) VALUES (?, ?)`),
  hasAnySeenItem: db.prepare(`SELECT 1 FROM webhook_seen_items WHERE feed_id = ? LIMIT 1`),
  isSeenItem:     db.prepare(`SELECT 1 FROM webhook_seen_items WHERE feed_id = ? AND item_id = ?`),
  touchSeenItem:  db.prepare(`
    INSERT INTO webhook_seen_items (feed_id, item_id, seen_at) VALUES (?, ?, unixepoch())
    ON CONFLICT (feed_id, item_id) DO UPDATE SET seen_at = unixepoch()
  `),
  pruneSeenItems: db.prepare(`
    DELETE FROM webhook_seen_items WHERE feed_id = ? AND item_id NOT IN (
      SELECT item_id FROM webhook_seen_items WHERE feed_id = ? ORDER BY seen_at DESC, rowid DESC LIMIT ?
    )
  `),
  deleteSeenItemsById: db.prepare(`DELETE FROM webhook_seen_items WHERE feed_id = ?`),
  forgetSeenItem: db.prepare(`DELETE FROM webhook_seen_items WHERE feed_id = ? AND item_id = ?`),
  incrFail:      db.prepare(`
    UPDATE webhook_feeds
    SET fail_count = fail_count + 1,
        first_fail_at = COALESCE(first_fail_at, unixepoch())
    WHERE id = ?
  `),
  resetFail:     db.prepare(`UPDATE webhook_feeds SET fail_count = 0, first_fail_at = NULL WHERE id = ?`),
  disableById:   db.prepare(`
    UPDATE webhook_feeds
    SET enabled = 0, fail_count = 0, first_fail_at = NULL, auto_disabled_at = unixepoch()
    WHERE id = ?
  `),
  listStaleAutoDisabled: db.prepare(`
    SELECT * FROM webhook_feeds WHERE enabled = 0 AND auto_disabled_at IS NOT NULL AND auto_disabled_at < ?
  `),
  deleteById:    db.prepare(`DELETE FROM webhook_feeds WHERE id = ?`),
  deleteSeenById: db.prepare(`DELETE FROM webhook_seen WHERE feed_id = ?`),
  deleteByGuild: db.prepare(`DELETE FROM webhook_feeds WHERE guild_id = ?`),
};

// ─── Dedup keys ───────────────────────────────────────────────────────────────
// The raw id (unchanged, so rows written before this existed still match)
// plus a normalised link: protocol, www., #fragment, tracking params and a
// trailing slash are dropped, so the same article with a reissued guid or a
// new utm_* tag still matches.
const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|at_medium|at_campaign)$/i;
export function normalizeLink(link) {
  if (!link) return null;
  try {
    const u = new URL(link);
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    const qs = u.searchParams.toString();
    return `${host}${path}${qs ? `?${qs}` : ''}`;
  } catch {
    return String(link).trim().toLowerCase() || null;
  }
}
// Newest first by publish date when the feed gives usable dates for most
// items; otherwise the feed's own order (the RSS/Atom norm) is kept.
export function sortNewestFirst(items) {
  const ts = items.map(i => Date.parse(i.pubDate ?? i.published ?? i.updated ?? ''));
  const dated = ts.filter(Number.isFinite).length;
  if (dated < Math.max(2, items.length * 0.8)) return items;
  return items
    .map((item, idx) => ({ item, idx, t: Number.isFinite(ts[idx]) ? ts[idx] : -Infinity }))
    .sort((a, b) => (b.t - a.t) || (a.idx - b.idx))
    .map(x => x.item);
}

export function itemKeys(item) {
  const keys = [];
  if (item.id) keys.push(item.id);
  const l = normalizeLink(item.link);
  if (l) keys.push(`link:${l}`);
  return keys;
}

// ─── HTML entity decoding ─────────────────────────────────────────────────────
// CRITICAL: must be applied to id/guid/link fields in ALL parsers
// String.fromCodePoint throws a RangeError on any codepoint outside
// 0..0x10FFFF, a malformed or garbage numeric entity in real feed content
// (encoding bugs, a broken feed generator, anything) would otherwise take
// down parsing for the entire feed on every single check, misreported as a
// generic fetch error and counted toward the 6-hour auto-disable threshold
// regardless of how healthy the actual upstream source is. Confirmed this
// is exactly what happened to a completely reliable YouTube feed. Left
// as the literal, undecoded entity text on failure rather than dropped
// entirely, so a broken entity is visible instead of silently vanishing.
function safeFromCodePoint(codepoint, original) {
  try { return String.fromCodePoint(codepoint); } catch { return original; }
}

function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => safeFromCodePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g,         (m, dec) => safeFromCodePoint(parseInt(dec, 10), m));
}

function stripHtml(str) {
  if (!str) return '';
  // Decode entities BEFORE stripping tags. Some feed sources (Nitter/Twitter
  // RSS bridges in particular) HTML-encode their own markup, so a literal
  // "&lt;p&gt;" never matches the tag-stripping regex below unless it's
  // decoded back into a real "<p>" first, otherwise the encoded tags leak
  // straight through into the embed as visible text.
  return decodeHtmlEntities(str).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Image/video extraction ───────────────────────────────────────────────────
// A link to a known video host or direct video file only plays properly when
// Fluxer/Discord unfurls the raw URL itself, a custom embed can only ever
// carry a static poster image, never an actual video player.
const VIDEO_URL_RE = /(?:youtube\.com\/watch|youtu\.be\/|vimeo\.com\/\d|twitch\.tv\/videos\/|\.(?:mp4|webm|mov)(?:\?|$))/i;

function extractImageFromHtml(html) {
  if (!html) return null;
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch?.[1]) return imgMatch[1];
  const posterMatch = html.match(/<video[^>]+poster=["']([^"']+)["']/i);
  if (posterMatch?.[1]) return posterMatch[1];
  return null;
}

// Scrapes the linked article's og:image as a fallback when the feed item
// itself carries no image. Best-effort, any failure just means no image.
async function fetchOgImage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bloo-Bot/2.0)' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const raw = match?.[1] ?? null;
    if (!raw) return null;
    try { return new URL(raw, url).href; } catch { return raw; }
  } catch {
    return null;
  }
}

// ─── Feed parsers ─────────────────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[^>]*>([\s\S]*?)<\/item>/gi) ?? [];

  for (const block of itemBlocks) {
    const title = stripHtml(block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)?.[1]
      ?? block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    const link  = decodeHtmlEntities(block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim()
      ?? block.match(/<link\s+href="([^"]+)"/i)?.[1] ?? '');
    const guid  = decodeHtmlEntities(block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1]?.trim() ?? link);
    const rawDesc = block.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i)?.[1]
      ?? block.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] ?? '';
    const desc = stripHtml(rawDesc);
    const embedImage = extractImageFromHtml(rawDesc);
    const pubDate = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ?? '';

    if (guid || link) items.push({ id: guid || link, title, link, description: desc, embedImage, pubDate });
  }
  return items;
}

function parseAtom(xml) {
  const items = [];
  const entryBlocks = xml.match(/<entry[^>]*>([\s\S]*?)<\/entry>/gi) ?? [];

  for (const block of entryBlocks) {
    const title = stripHtml(block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    const link  = decodeHtmlEntities(block.match(/<link[^>]*href="([^"]+)"/i)?.[1]
      ?? block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim() ?? '');
    const id    = decodeHtmlEntities(block.match(/<id[^>]*>([\s\S]*?)<\/id>/i)?.[1]?.trim() ?? link);
    const rawSummary = block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1]
      ?? block.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1] ?? '';
    const summary = stripHtml(rawSummary);
    const embedImage = extractImageFromHtml(rawSummary);

    if (id || link) items.push({ id: id || link, title, link, description: summary, embedImage });
  }
  return items;
}

function parseJSON(json) {
  try {
    const data  = JSON.parse(json);
    const items = data.items ?? data.entries ?? data.feed?.entries ?? [];
    return items.map(item => {
      const rawHtml = item.content_html ?? item.summary ?? '';
      return {
        id:          decodeHtmlEntities(item.id ?? item.guid ?? item.url ?? ''),
        title:       decodeHtmlEntities(item.title ?? ''),
        link:        decodeHtmlEntities(item.url ?? item.link ?? item.external_url ?? ''),
        description: item.content_text ? decodeHtmlEntities(item.content_text) : (stripHtml(rawHtml) || item.summary || ''),
        embedImage:  item.image ?? extractImageFromHtml(rawHtml),
      };
    });
  } catch {
    return [];
  }
}

// ─── TwitterAPI.io bridge ─────────────────────────────────────────────────────
// X/Twitter has no native RSS, and every free scraping bridge tried this
// session (Nitter, RSSHub's Twitter route) is currently dead or blocked.
// TwitterAPI.io is a paid, third-party-hosted API that isn't a feed format at
// all, so it can't go through the normal fetch-and-sniff-the-format path
// below. A feed URL of the form "twitter:<handle>" or "x:<handle>" (instead
// of a real http(s) URL) routes here instead. Requires TWITTERAPI_KEY in
// .env, add via `!webhook add "Name" twitter:handle #channel [interval_m]`.
const TWITTER_BRIDGE_RE = /^(?:twitter|x):(.+)$/i;

async function fetchTwitterBridgeFeed(handle) {
  const apiKey = process.env.TWITTERAPI_KEY;
  if (!apiKey) throw new Error('TWITTERAPI_KEY not set in .env');

  const res = await fetch(
    `https://api.twitterapi.io/twitter/user/last_tweets?userName=${encodeURIComponent(handle)}`,
    { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(10_000) }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  if (data.status === 'error') throw new Error(data.message || 'TwitterAPI.io returned an error');

  const tweets = data.tweets ?? [];
  return tweets.map(t => ({
    id:          `t_${t.id}`,
    title:       '',
    link:        t.url || `https://x.com/${t.author?.userName ?? handle}/status/${t.id}`,
    description: decodeHtmlEntities(t.text ?? ''),
    embedImage:  null, // not documented in TwitterAPI.io's response schema
    pubDate:     t.createdAt ?? '',
  }));
}

// ─── Title fallback ───────────────────────────────────────────────────────────
function resolveTitle(item, feedName) {
  if (item.title?.trim()) return item.title.trim().slice(0, 200);
  if (item.description?.trim()) return item.description.trim().split('\n')[0].slice(0, 80);
  return feedName ?? 'New Post';
}

// An item with no title, no description, and no link has nothing worth
// posting, even if the parser found enough (an id) to include it.
function hasUsableContent(item) {
  return !!(item.title?.trim() || item.description?.trim() || item.link?.trim());
}

// ─── Fetch and parse a feed ───────────────────────────────────────────────────
// Exported so the dashboard's feed preview (dashboard/routes/webhooks.js)
// runs the exact same fetch/detect/parse pipeline the live poller uses,
// instead of a reimplementation that could silently drift from it.
export async function fetchFeed(url) {
  const twitterMatch = url.match(TWITTER_BRIDGE_RE);
  if (twitterMatch) {
    const items = await fetchTwitterBridgeFeed(twitterMatch[1]);
    return items.filter(hasUsableContent);
  }

  const res  = await fetch(url, { headers: { 'User-Agent': 'Bloo-Bot/2.0 RSS Reader' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();

  if (!text.trim()) return []; // blank response body, nothing to parse

  let items;
  if (text.trim().startsWith('{') || text.trim().startsWith('[')) items = parseJSON(text);
  else if (/<feed/i.test(text)) items = parseAtom(text);
  else items = parseRSS(text);

  return items.filter(hasUsableContent);
}

// ─── Post item to channel ─────────────────────────────────────────────────────
// Takes client + a channel ID string, not a fetched channel object: raw REST
// posting confirmed in production to be the reliable path, client.channels.
// fetch() + channel.send() fails with "channel.send is not a function" for
// at least one channel type on v2.0.1's SDK.
async function postItem(client, channelId, feed, item) {
  const title = resolveTitle(item, feed.name);
  const desc  = item.description?.slice(0, 300) ?? '';
  const ping  = feed.ping_role_id ? `<@&${feed.ping_role_id}>` : null;

  const isVideoLink = item.link ? VIDEO_URL_RE.test(item.link) : false;

  if (!isVideoLink) {
    // Prefer an image already embedded in the feed item (RSSHub/Atom/JSON
    // Feed all carry these for image and video posts); only reach out to the
    // linked article for its og:image if the feed itself had nothing.
    const image = item.embedImage
      ?? (item.link?.startsWith('http') ? await fetchOgImage(item.link) : null);

    if (image) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(title)
        .setImage(image)
        .setTimestamp();

      if (item.link) embed.setURL(item.link);
      if (desc)      embed.setDescription(desc);
      embed.setFooter({ text: feed.name });

      await client.rest.post(`/channels/${channelId}/messages`, { body: { content: ping ?? undefined, embeds: [embed.toJSON()] } });
      return;
    }
  }

  if (item.link) {
    // No image found, or a known video link, post the bare URL so
    // Fluxer/Discord generates its own native preview card. This is the only
    // way a video (YouTube, a direct .mp4, etc.) ends up as a playable embed,
    // since a custom embed can only ever carry a static image.
    const parts = [];
    if (ping) parts.push(ping);
    parts.push(item.link);
    await client.rest.post(`/channels/${channelId}/messages`, { body: { content: parts.join('\n') } });
    return;
  }

  // No link at all, nothing for Fluxer to unfurl, so fall back to a plain embed.
  const embed = new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle(title)
    .setTimestamp();
  if (desc) embed.setDescription(desc);
  embed.setFooter({ text: feed.name });
  await client.rest.post(`/channels/${channelId}/messages`, { body: { content: ping ?? undefined, embeds: [embed.toJSON()] } });
}

// ─── Failure tracking, auto-disables (not deletes) after a sustained outage ──
// Originally a raw consecutive-failure COUNT (20) regardless of the feed's
// own interval_m, which meant a 10-minute feed only got ~3.3h of grace before
// permanent deletion while a 60-minute feed got 20h for the exact same kind
// of failure, an inconsistency that cost a real feed its subscription during
// a multi-hour YouTube-side outage (confirmed via journalctl: HTTP 404/500
// for ~3.5h straight, the URL was fine again shortly after). Two changes:
// the threshold is now how long it's been continuously failing (a stable
// duration regardless of interval_m), and crossing it disables the feed
// instead of deleting it, since a transient upstream outage shouldn't cost
// the user having to reconstruct the channel/interval/ping-role config from
// scratch. `!webhook enable <id>` (or the dashboard toggle) brings it back.
const FAIL_DURATION_S = 6 * 60 * 60; // 6 hours of continuous failure

const isPermissionError = err => err?.status === 403 || err?.statusCode === 403
  || /permission/i.test(err?.message ?? '');

// Tells the person who added a feed that it was paused, by DM. The usual
// notice goes in the feed's own channel, which is exactly where Bloo can't
// post when the cause is missing permissions.
async function dmFeedOwner(client, feed, text) {
  if (!/^\d{15,25}$/.test(String(feed.added_by ?? ''))) return false;
  try {
    const dm = await client.rest.post('/users/@me/channels', { body: { recipient_id: feed.added_by } });
    await client.rest.post(`/channels/${dm.id}/messages`, { body: { embeds: [danger(text, 'Feed Subscription Paused').setTimestamp().toJSON()] } });
    return true;
  } catch { return false; }
}

// reason 'permissions': Bloo was refused when posting, so the pause notice
// goes to the person who added the feed instead of the channel.
async function trackFailure(client, feed, reason = null) {
  stmts.incrFail.run(feed.id);
  const row = stmts.get.get(feed.id);
  if (!row?.first_fail_at) return;

  const failingForS = Math.floor(Date.now() / 1000) - row.first_fail_at;
  if (failingForS < FAIL_DURATION_S) return;

  stmts.disableById.run(feed.id);
  logger.warn(`[WEBHOOK] Feed #${feed.id} "${feed.name}" auto-disabled after failing continuously for ${Math.round(failingForS / 3600)}h.`);

  const P = process.env.PREFIX ?? 'b!';
  const cause = reason === 'permissions'
    ? `I wasn't allowed to post in <#${feed.channel_id}>. Open that channel's **Permissions**, add my role, allow **View Channel**, **Send Messages** and **Embed Links**, then run \`${P}webhook enable ${feed.id}\`. Anything I couldn't post will go out then.`
    : `This usually means the source was temporarily down, not necessarily gone for good. Check the feed URL still works, then run \`${P}webhook enable ${feed.id}\` to resume it.`;
  const text = `The feed subscription **${feed.name}** (ID: #${feed.id}) has been automatically paused after failing continuously for over ${FAIL_DURATION_S / 3600} hours.\n\n${cause}`;
  let told = false;
  if (reason !== 'permissions') {
    try {
      await client.rest.post(`/channels/${feed.channel_id}/messages`, {
        body: { embeds: [danger(text, 'Feed Subscription Paused').setTimestamp().toJSON()] },
      });
      told = true;
    } catch { /* best-effort, channel may be read-only, or gone entirely */ }
  }
  if (!told) await dmFeedOwner(client, feed, text);
}

// ─── Prune feeds for a guild Bloo has actually left ──────────────────────────
// Called from events/guild/guildDelete.js, the real event that fires exactly
// when the bot leaves/is removed, not inferred from a cache-presence check.
// A guild missing from client.guilds.cache does NOT mean the bot left it,
// it just as easily means the cache hasn't finished hydrating yet after a
// restart (this bot has restarted a lot), or evicted it under the cache
// size limit. The old pruneLeftGuilds() used exactly that unreliable check,
// called unconditionally on every `!webhook` subcommand, and had almost
// certainly been silently deleting real feed subscriptions for guilds that
// never actually left, every time an admin ran the command shortly after a
// restart. Removed entirely in favor of this.
export function pruneGuildFeeds(guildId) {
  stmts.deleteByGuild.run(guildId);
}

// ─── Tick, check one feed ────────────────────────────────────────────────────
// force=true skips the "not due yet" gate, used by the dashboard's manual
// "Refresh Now" button (refreshFeedNow below) to check regardless of
// interval_m; the normal poller tick below never passes it.
async function checkFeed(client, feed, force = false) {
  const now    = Math.floor(Date.now() / 1000);
  const minAge = feed.interval_m * 60;
  if (!force && now - feed.last_checked < minAge) return { ok: true, skipped: 'not-due', posted: 0 };

  stmts.updateCheck.run(feed.id);

  // Channel must be reachable to count as a working feed; track failure if
  // not. Raw REST GET, not client.channels.fetch(), same reliability reason
  // as postItem/trackFailure above.
  const channelOk = await client.rest.get(`/channels/${feed.channel_id}`).catch(() => null);
  if (!channelOk) {
    logger.warn(`[WEBHOOK] Feed #${feed.id} ("${feed.name}") channel ${feed.channel_id} unreachable.`);
    await trackFailure(client, feed);
    return { ok: false, reason: 'channel-unreachable', posted: 0 };
  }

  let items;
  try {
    items = await fetchFeed(feed.url);
  } catch (err) {
    // A single blip is forgiven, only a sustained run of failures (see
    // FAIL_DURATION_S above) counts toward auto-disabling the feed.
    logger.warn(`[WEBHOOK] Feed #${feed.id} (${feed.name}) fetch error: ${err.message}`);
    await trackFailure(client, feed);
    return { ok: false, reason: err.message, posted: 0 };
  }

  if (!items.length) {
    // Fetched fine but came back blank, or every item was empty of usable
    // content. Same reasoning as a fetch error: count it so a feed that's
    // gone permanently quiet still gets flagged and eventually removed.
    await trackFailure(client, feed);
    return { ok: false, reason: 'empty-feed', posted: 0 };
  }

  // Which items are actually new: membership in a set of recently-posted
  // ids, not "find my one saved cursor id in this fetch". The old version
  // tracked a single last_id and located it by index in the current fetch;
  // whenever that one id didn't turn up (the feed re-ordered, the article's
  // guid/link value changed slightly between two fetches of the same real
  // article, a temporary CDN/cache blip served a different item set,
  // anything), it silently fell back to "post the newest 5 regardless",
  // reposting whatever of those had already gone out, this is the actual
  // repost bug: it wasn't that the bot picked the wrong 5, it's that any
  // single failure to relocate one bookmark wiped out its own memory of
  // everything else it had already posted. A set survives all of that:
  // each item is checked independently, so one id going missing or
  // changing shape never causes the others to be treated as unseen.
  // Each item is remembered under its id AND its normalised link, and counts
  // as seen if either matches, so an article whose guid/id changes between
  // fetches (reissued guid, tracking params) isn't posted a second time.
  //
  // The feed's own order is used as an anchor on top of that: once the
  // newest item we already know is found, everything listed below it is
  // older and counts as seen even if its key isn't stored. Without this, a
  // feed whose memory only holds its latest post (e.g. right after the
  // one-time migration from the old single-cursor table, which seeded just
  // that one id) treated every older article still listed as new and posted
  // months-old posts in batches. Items are sorted newest-first by date first,
  // so a feed that lists oldest-first can't flip the anchor.
  items = sortNewestFirst(items);
  const isFirstCheck = !stmts.hasAnySeenItem.get(feed.id);
  const isSeen = (item) => itemKeys(item).some(k => stmts.isSeenItem.get(feed.id, k));
  const anchor = isFirstCheck ? -1 : items.findIndex(isSeen);

  let newItems, seenNow;
  if (anchor === -1) {
    // First check, or nothing in the feed is recognised any more: post the
    // newest 5 and remember everything else, so the rest can't flood later.
    newItems = items.slice(0, 5);
    seenNow  = items.slice(5);
  } else {
    // Only items listed above the anchor are new. Post up to 5 per tick,
    // oldest first, so a real backlog drains in order without skipping any.
    newItems = items.slice(0, anchor).slice(-5);
    seenNow  = items.slice(anchor);
  }

  // Mark new items seen BEFORE posting (idempotent on retry), and refresh
  // seen_at on every item still listed in the feed. Pruning keeps the most
  // recently touched keys, so without the refresh a feed longer than the
  // retention window aged its still-listed items out and reposted them.
  // Retention scales with the feed so that can't happen for long feeds.
  db.transaction(() => {
    for (const item of [...newItems, ...seenNow]) for (const k of itemKeys(item)) stmts.touchSeenItem.run(feed.id, k);
    stmts.pruneSeenItems.run(feed.id, feed.id, Math.max(200, items.length * 4));
  })();
  if (!newItems.length) {
    // A good fetch with nothing new still proves the feed works, so it ends
    // any failure streak. Before, only a check that posted something did,
    // so a source that failed now and then (YouTube's feeds do) built up
    // "6 hours of failure" out of scattered errors and got paused.
    if (feed.fail_count > 0 || feed.first_fail_at) stmts.resetFail.run(feed.id);
    return { ok: true, posted: 0 };
  }
  stmts.upsertSeen.run(feed.id, newItems[0].id); // legacy display column, dashboard/routes/webhooks.js

  // Post newest last (so channel order matches feed order)
  let posted = 0;
  let lastPostError = null;
  for (const item of newItems.reverse()) {
    try {
      await postItem(client, feed.channel_id, feed, item);
      posted++;
    } catch (err) {
      logger.warn(`[WEBHOOK] Feed #${feed.id} post error: ${err.message}`);
      lastPostError = err;
      // Refused for permissions: forget the item so it posts once staff fix
      // the channel. Otherwise everything published while Bloo was locked out
      // (a whole stream's VOD, say) was marked handled and never appeared.
      if (isPermissionError(err)) for (const k of itemKeys(item)) stmts.forgetSeenItem.run(feed.id, k);
    }
  }

  if (posted > 0) {
    stmts.resetFail.run(feed.id);
    return { ok: true, posted };
  }
  // Had items but couldn't deliver any, count as a delivery failure
  await trackFailure(client, feed, lastPostError && isPermissionError(lastPostError) ? 'permissions' : null);
  return { ok: false, reason: 'delivery-failed', posted: 0 };
}

// ─── Manual refresh (dashboard "Refresh Now" button) ─────────────────────────
// Bypasses the interval_m gate and checks this one feed right now. Returns a
// plain result object for the API route to relay back to the dashboard,
// rather than the poller's fire-and-forget/log-only error handling.
export async function refreshFeedNow(client, feedId) {
  const feed = stmts.get.get(feedId);
  if (!feed) return { ok: false, reason: 'not-found', posted: 0 };
  return checkFeed(client, feed, true);
}

// ─── Stale auto-disabled cleanup ─────────────────────────────────────────────
// A feed auto-disabled by trackFailure() (source down, not manually paused,
// see auto_disabled_at's comment on the setEnabled statement above) gets a
// grace period to be fixed and re-enabled before it's actually deleted.
// Manually disabled feeds (auto_disabled_at stays NULL) are never touched
// here, that's an intentional, indefinite user choice, not a sign of neglect.
const AUTO_DELETE_GRACE_S = 14 * 24 * 60 * 60; // 14 days

function cleanupStaleAutoDisabledFeeds() {
  const cutoff = Math.floor(Date.now() / 1000) - AUTO_DELETE_GRACE_S;
  const stale  = stmts.listStaleAutoDisabled.all(cutoff);
  for (const feed of stale) {
    stmts.deleteSeenById.run(feed.id);
    stmts.deleteSeenItemsById.run(feed.id);
    stmts.deleteById.run(feed.id);
    logger.info(`[WEBHOOK] Feed #${feed.id} "${feed.name}" permanently deleted, auto-disabled for over ${AUTO_DELETE_GRACE_S / 86400} days with no re-enable.`);
  }
}

// ─── startWebhookPoller ───────────────────────────────────────────────────────
let _wTimer = null;

export function startWebhookPoller(client) {
  if (_wTimer) return;

  let lastCleanupAt = 0;

  const tick = async () => {
    const feeds = stmts.list.all();
    for (const feed of feeds) {
      await checkFeed(client, feed).catch(err =>
        logger.warn(`[WEBHOOK] checkFeed error for ${feed.id}:`, err.message)
      );
    }

    // Cheap query on a small table, but no need to run it every 60s, once an
    // hour is plenty for a 14-day-scale grace period.
    const now = Date.now();
    if (now - lastCleanupAt >= 60 * 60 * 1000) {
      lastCleanupAt = now;
      try { cleanupStaleAutoDisabledFeeds(); } catch (err) { logger.warn('[WEBHOOK] Cleanup sweep failed:', err.message); }
    }
  };

  resilience.runLight('webhookPoller.tick', tick);
  _wTimer = setInterval(() => resilience.runLight('webhookPoller.tick', tick), 60_000); // check every minute, each feed rate-limits itself
  _wTimer.unref?.();
  logger.info('[WEBHOOK] Poller started (1m check interval).');
}

// ─── Management helpers ───────────────────────────────────────────────────────
export function addFeed(guildId, name, url, channelId, intervalM, pingRoleId, addedBy) {
  const extraValues = _EXTRA_INSERT_COLS.map(c => {
    if (c === 'added_by')     return addedBy ?? 'unknown';
    if (c === 'added_at')     return Math.floor(Date.now() / 1000);
    if (c === 'display_name') return name;
    return null;
  });
  return stmts.add.run(guildId, name, url, channelId, intervalM ?? 30, pingRoleId ?? null, ...extraValues).lastInsertRowid;
}

// Edit a feed in place (b!webhook edit/ping, the dashboard's edit form).
// Only the fields given change. Returns false if the feed isn't in this server.
export function updateFeed(guildId, feedId, fields) {
  const cols = { name: 'name', url: 'url', channelId: 'channel_id', intervalM: 'interval_m', pingRoleId: 'ping_role_id' };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(cols)) if (fields[k] !== undefined) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  if (fields.name !== undefined && _feedCols.includes('display_name')) { sets.push('display_name = ?'); vals.push(fields.name); }
  if (!sets.length) return false;
  return db.prepare(`UPDATE webhook_feeds SET ${sets.join(', ')} WHERE id = ? AND guild_id = ?`).run(...vals, feedId, guildId).changes > 0;
}

export function removeFeed(guildId, feedId) {
  stmts.remove.run(feedId, guildId);
}

export function listFeeds(guildId) {
  return stmts.listGuild.all(guildId);
}

export function setFeedEnabled(guildId, feedId, enabled) {
  const val = enabled ? 1 : 0;
  stmts.setEnabled.run(val, val, feedId, guildId);
}
