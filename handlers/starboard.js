import db from '../db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../config/embeds.js';
import { emojiKey, sameEmoji } from './reactionRoles.js';

// Fluxer converts unicode emoji in message text to shortcode names (e.g. ⭐ → :star:).
// This map lets us resolve config values stored as shortcodes back to unicode for comparison.
const SHORTCODE_TO_UNICODE = {
  star: '⭐', star2: '🌟', sparkles: '✨', dizzy: '💫',
  heart: '❤️', hearts: '💕', thumbsup: '👍', fire: '🔥',
  tada: '🎉', gem: '💎', crown: '👑', trophy: '🏆',
};

export function resolveConfigEmoji(raw) {
  const m = raw?.match(/^:([^:]+):$/);
  // Variation selector stripped here too, same as the reaction side
  // (emojiKey): the map's '❤️' carries U+FE0F and never matched a reaction.
  if (m) return (SHORTCODE_TO_UNICODE[m[1]] ?? m[1]).replace(/️/g, '');
  return (raw ?? '').replace(/️/g, '');
}

// A custom emoji is stored bare, "name:id" ("a_name:id" if animated), the
// form resolveConfigEmoji()/emojiKey() compare reactions against, but that
// bare text renders as literal text when it's the thing actually posted,
// e.g. the "⭐ 5 | #channel" content line, it needs the real <:name:id>
// markup to show as an emoji at all. Every content string handleStarReaction/
// handleStarRemove build for posting must go through this, not the raw
// config.emoji, matching commands/moderation/starboard.js's own copy of
// this same helper (used there for command replies instead).
export function displayEmoji(stored) {
  const m = String(stored ?? '').match(/^(a_)?(\w+):(\d+)$/);
  if (m) return m[1] ? `<a:${m[2]}:${m[3]}>` : `<:${m[2]}:${m[3]}>`;
  return stored;
}

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS starboard_config (
    guild_id   TEXT PRIMARY KEY,
    channel_id TEXT,
    threshold  INTEGER NOT NULL DEFAULT 3,
    emoji      TEXT    NOT NULL DEFAULT '⭐',
    enabled    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS starboard_entries (
    guild_id           TEXT    NOT NULL,
    message_id         TEXT    NOT NULL,
    starboard_message_id TEXT,
    star_count         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, message_id)
  );

  -- Per-category override of the guild-wide starboard channel. channel_id
  -- NULL means this category is excluded from the starboard entirely
  -- (reacts in it never get posted anywhere); a real channel_id redirects
  -- that category's stars to a different channel instead of the default.
  -- A category with no row here just uses starboard_config's own channel.
  CREATE TABLE IF NOT EXISTS starboard_category_overrides (
    guild_id    TEXT NOT NULL,
    category_id TEXT NOT NULL,
    channel_id  TEXT,
    PRIMARY KEY (guild_id, category_id)
  );
`);

// ─── Schema drift repair, run before ANY db.prepare() call ──────────────────
// The live starboard_entries table predates the current shape: its real
// PRIMARY KEY is (guild_id, source_msg_id), plus NOT NULL legacy columns
// (star_msg_id, channel_id, author_id, created_at) the current code never
// reads or writes. CREATE TABLE IF NOT EXISTS is a no-op against an
// already-existing table, and the ALTER TABLE loop below only ever adds
// columns, it can't relax an existing NOT NULL, so every upsertEntry() call
// threw "NOT NULL constraint failed: starboard_entries.source_msg_id",
// silently swallowed by reactionAdd.js's catch-all. That meant a message's
// starboard_message_id could never actually be recorded, so every reaction
// past the threshold looked like the first one crossing it and posted a
// brand new starboard message instead of editing the existing one, exactly
// the "resends the same post" behavior reported. Same rebuild technique
// already used for ticket_cases/ticket_messages: build the current shape,
// carry over whatever legacy data exists (message_id/source_msg_id and
// starboard_message_id/star_msg_id are the same concept under an older
// name), drop, rename.
try {
  const colInfo = db.prepare(`PRAGMA table_info(starboard_entries)`).all();
  const legacyNotNull = colInfo.find(c => c.name === 'source_msg_id')?.notnull === 1;
  if (legacyNotNull) {
    db.exec(`
      CREATE TABLE starboard_entries_new (
        guild_id             TEXT    NOT NULL,
        message_id           TEXT    NOT NULL DEFAULT '',
        starboard_message_id TEXT,
        star_count           INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, message_id)
      );
      INSERT OR IGNORE INTO starboard_entries_new (guild_id, message_id, starboard_message_id, star_count)
        SELECT guild_id,
               CASE WHEN message_id IS NOT NULL AND message_id != '' THEN message_id ELSE source_msg_id END,
               COALESCE(starboard_message_id, star_msg_id),
               COALESCE(star_count, 0)
        FROM starboard_entries;
      DROP TABLE starboard_entries;
      ALTER TABLE starboard_entries_new RENAME TO starboard_entries;
    `);
  }
} catch (err) {
  logger.warn('[STARBOARD] Failed to repair starboard_entries schema drift:', err.message);
}

// ─── Schema migrations, run before ANY db.prepare() call ────────────────────
for (const col of [
  `ALTER TABLE starboard_entries ADD COLUMN message_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE starboard_entries ADD COLUMN starboard_message_id TEXT`,
  `ALTER TABLE starboard_entries ADD COLUMN star_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE starboard_config ADD COLUMN self_star INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE starboard_config ADD COLUMN ignore_bots INTEGER NOT NULL DEFAULT 1`,
]) { try { db.exec(col); } catch { /* already exists */ } }
// Ensure the unique constraint exists for ON CONFLICT upsert to work on legacy tables
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_starboard_entries ON starboard_entries (guild_id, message_id)`);
} catch { /* already exists as PK or index */ }

const stmts = {
  getConfig:    db.prepare(`SELECT * FROM starboard_config WHERE guild_id = ?`),
  ensureConfig: db.prepare(`INSERT OR IGNORE INTO starboard_config (guild_id) VALUES (?)`),
  setField:     (field) => db.prepare(`UPDATE starboard_config SET ${field} = ? WHERE guild_id = ?`),
  getEntry:     db.prepare(`SELECT * FROM starboard_entries WHERE guild_id = ? AND message_id = ?`),
  // COALESCE here means "null = don't know yet, keep whatever's already
  // there", correct for the below-threshold tracking call in
  // handleStarReaction (it hasn't posted anything, so it has nothing new to
  // record). It is NOT correct for actually clearing the reference after a
  // post is deleted, that needs clearStarboardMessage below instead, a
  // bound NULL here can never overwrite an existing value.
  upsertEntry:  db.prepare(`
    INSERT INTO starboard_entries (guild_id, message_id, starboard_message_id, star_count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (guild_id, message_id) DO UPDATE SET
      starboard_message_id = COALESCE(excluded.starboard_message_id, starboard_entries.starboard_message_id),
      star_count = excluded.star_count
  `),
  // Explicitly clears starboard_message_id (e.g. after deleting the post
  // once a message falls back below threshold), unlike upsertEntry above
  // this can actually null it out instead of preserving the old value.
  clearStarboardMessage: db.prepare(`
    UPDATE starboard_entries SET starboard_message_id = NULL, star_count = ? WHERE guild_id = ? AND message_id = ?
  `),
  getCategoryOverride: db.prepare(`SELECT * FROM starboard_category_overrides WHERE guild_id = ? AND category_id = ?`),
  listCategoryOverrides: db.prepare(`SELECT * FROM starboard_category_overrides WHERE guild_id = ?`),
  setCategoryOverride: db.prepare(`
    INSERT INTO starboard_category_overrides (guild_id, category_id, channel_id)
    VALUES (?, ?, ?)
    ON CONFLICT (guild_id, category_id) DO UPDATE SET channel_id = excluded.channel_id
  `),
  removeCategoryOverride: db.prepare(`DELETE FROM starboard_category_overrides WHERE guild_id = ? AND category_id = ?`),
};

export function getStarboardConfig(guildId) {
  stmts.ensureConfig.run(guildId);
  return stmts.getConfig.get(guildId);
}

export function setStarboardField(guildId, field, value) {
  const allowed = ['channel_id', 'threshold', 'emoji', 'enabled', 'self_star', 'ignore_bots'];
  if (!allowed.includes(field)) throw new Error(`Unknown starboard field: ${field}`);
  stmts.ensureConfig.run(guildId);
  stmts.setField(field).run(value, guildId);
}

// ─── Per-category overrides ───────────────────────────────────────────────────
export function listStarboardCategoryOverrides(guildId) {
  return stmts.listCategoryOverrides.all(guildId);
}

// channelId=null marks the category excluded from the starboard entirely
// (nothing in it ever gets posted anywhere). A real channelId redirects
// this category's stars to that channel instead of the guild-wide default.
export function setStarboardCategoryOverride(guildId, categoryId, channelId) {
  stmts.setCategoryOverride.run(guildId, categoryId, channelId ?? null);
}

export function removeStarboardCategoryOverride(guildId, categoryId) {
  stmts.removeCategoryOverride.run(guildId, categoryId);
}

// Resolves where (if anywhere) a message in `sourceChannelId` should be
// starboarded, checking that channel's own category against any override
// before falling back to the guild-wide default. Every function below that
// posts, edits, or deletes a starboard message goes through this so a
// category redirect or exclusion applies consistently everywhere, not just
// on the initial post.
export async function resolveStarboardChannel(client, guildId, sourceChannelId, defaultChannelId) {
  try {
    const channel = await client.rest.get(`/channels/${sourceChannelId}`);
    const categoryId = channel?.parent_id;
    if (categoryId) {
      const override = stmts.getCategoryOverride.get(guildId, categoryId);
      if (override) {
        return override.channel_id
          ? { excluded: false, channelId: override.channel_id }
          : { excluded: true, channelId: null };
      }
    }
  } catch { /* channel fetch failed, fall through to the default below */ }
  return { excluded: false, channelId: defaultChannelId };
}

// Shared by handleStarReaction (new stars / count changes) and
// handleStarredMessageEdit (source message edited after being starboarded),
// so both stay in sync instead of building the embed two different ways.
// originalMsg can be either a raw REST message object or a hydrated gateway
// Message instance, attachments is a plain array on the former and a
// Collection on the latter, normalise so either shape works here.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
function getAttachments(originalMsg) {
  return Array.isArray(originalMsg.attachments)
    ? originalMsg.attachments
    : [...(originalMsg.attachments?.values?.() ?? [])];
}

// Extension match against a filename or URL, tolerant of a signed CDN
// URL's query string (Fluxer attachment URLs carry ?ex=...&hm=... the same
// way Discord's do), which a bare $-anchored regex against the full URL
// would never match. Checks filename AND url independently, `a.url ??
// a.filename` was the actual bug: url is essentially always present, so
// the filename fallback (which has no query string to trip over) never
// even ran.
function hasExtension(value, extRe) {
  if (!value) return false;
  return extRe.test(value.split('?')[0]);
}

// Embeds can't actually play video, embed.image/.thumbnail only ever
// render a static picture, so a starred message's video attachment was
// silently dropped entirely, buildStarboardEmbed only ever looked for
// images. The fix is the same one already used for attachments in
// handlers/echoSystem.js's buildRelayContent(): post the raw URL in the
// message content instead of the embed, Fluxer/Discord-style clients
// auto-unfurl that into a real inline player.
const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif|bmp)$/i;
// Raw REST messages say content_type, hydrated gateway ones contentType.
const typeOf = a => a.contentType ?? a.content_type ?? '';
const isVideo = a => typeOf(a).startsWith('video/') || hasExtension(a.filename, VIDEO_EXT_RE) || hasExtension(a.url, VIDEO_EXT_RE);
const isImage = a => typeOf(a).startsWith('image/') || hasExtension(a.filename, IMAGE_EXT_RE) || hasExtension(a.url, IMAGE_EXT_RE);

// Spoilered (and explicit-flagged) media must stay hidden on the starboard
// too. An embed image or an unfurled link can't be blurred, so these never
// go in either; the post re-uploads them with the same flags instead.
const IS_SPOILER = 8, CONTAINS_EXPLICIT_MEDIA = 16;
const HIDDEN_FLAGS = IS_SPOILER | CONTAINS_EXPLICIT_MEDIA;
const isHidden = a => ((a.flags ?? 0) & HIDDEN_FLAGS) !== 0 || /^SPOILER_/i.test(a.filename ?? '') || a.nsfw === true;
const shown = attachments => attachments.filter(a => !isHidden(a));

function findVideoUrl(attachments) {
  return shown(attachments).find(isVideo)?.url ?? null;
}

// The first spoilered image or video, if any.
function findHiddenMedia(attachments) {
  return attachments.find(a => isHidden(a) && a.url && (isImage(a) || isVideo(a))) ?? null;
}

// Downloads a spoilered attachment so it can go back up as a spoiler.
// Returns null when it's too big or can't be fetched; the post then just
// says the message has a spoiler.
const SPOILER_REUPLOAD_MAX = 8 * 1024 * 1024;
async function spoilerUpload(att) {
  try {
    if ((att.size ?? 0) > SPOILER_REUPLOAD_MAX) return null;
    const res = await fetch(att.url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > SPOILER_REUPLOAD_MAX) return null;
    const name = /^SPOILER_/i.test(att.filename ?? '') ? att.filename : `SPOILER_${att.filename || 'image.png'}`;
    return {
      files: [{ name, data }],
      attachments: [{ id: 0, filename: name, flags: ((att.flags ?? 0) & HIDDEN_FLAGS) || IS_SPOILER }],
    };
  } catch {
    return null;
  }
}

function buildStarboardEmbed(guildId, channelId, messageId, originalMsg) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.WARNING)
    .setDescription(originalMsg.content?.slice(0, 2000) || ZERO_WIDTH_SPACE)
    .addFields({
      name: 'Source',
      value: `[Jump to message](https://fluxer.app/channels/${guildId}/${channelId}/${messageId})`,
      inline: true,
    })
    .setTimestamp();

  if (originalMsg.author) {
    const avatarUrl = originalMsg.author.avatar
      ? `https://fluxerusercontent.com/avatars/${originalMsg.author.id}/${originalMsg.author.avatar}.png?size=64`
      : null;
    embed.setAuthor({ name: originalMsg.author.username, iconURL: avatarUrl ?? undefined });
  }

  const attachments = getAttachments(originalMsg);
  // Filename-extension-only matching missed real images shared without a
  // recognized extension (e.g. mobile "Saved Images" shares, which can come
  // through as .heic/.heif, or with no extension at all), silently leaving
  // the starboard repost with no image. Check the real content type first,
  // same dual-check already used in commands/general/bugreport.js.
  const img = shown(attachments).find(isImage);
  if (img?.url) embed.setImage(img.url);

  return embed;
}

// Called from events/guild/messageUpdate.js when a message's content or
// attachments change. Only touches messages that are already on the
// starboard, keeps the star count as-is (this isn't a re-star), just
// refreshes the embed so an edited message doesn't leave the starboard
// showing stale content indefinitely.
export async function handleStarredMessageEdit(client, newMessage, guildIdOverride) {
  const guildId   = guildIdOverride ?? newMessage.guildId;
  const messageId = newMessage.id;
  const channelId = newMessage.channelId;
  if (!guildId || !messageId) return;

  const config = getStarboardConfig(guildId);
  if (!config?.enabled || !config.channel_id) return;

  const entry = stmts.getEntry.get(guildId, messageId);
  if (!entry?.starboard_message_id) return; // never starboarded, nothing to refresh

  const { excluded, channelId: targetChannelId } = await resolveStarboardChannel(client, guildId, channelId, config.channel_id);
  if (excluded) return;

  const embed = buildStarboardEmbed(guildId, channelId, messageId, newMessage);
  try {
    await client.rest.patch(
      `/channels/${targetChannelId}/messages/${entry.starboard_message_id}`,
      { body: { embeds: [embed.toJSON()] } }
    );
  } catch (err) {
    logger.warn(`[STARBOARD] Failed to refresh edited message ${messageId} in ${guildId}:`, err.message);
  }
}

// Called from events/guild/messageDelete.js. The source message is gone, so
// there's nothing left to keep the starboard post in sync with, remove it
// rather than leaving a dead "Jump to message" link and stale content up
// indefinitely.
export async function handleStarredMessageDelete(client, guildId, messageId, channelId) {
  if (!guildId || !messageId) return;

  const config = getStarboardConfig(guildId);
  if (!config?.channel_id) return; // no starboard channel configured, nothing was ever posted

  const entry = stmts.getEntry.get(guildId, messageId);
  if (!entry) return;

  if (entry.starboard_message_id) {
    // Best-effort: if the source channel itself is already gone too, this
    // falls back to the guild default, which is right for the common case
    // and only wrong in the rare case a message in an overridden category
    // is deleted after its own channel is. Not worth tracking each entry's
    // resolved channel just for that edge case.
    const { channelId: targetChannelId } = channelId
      ? await resolveStarboardChannel(client, guildId, channelId, config.channel_id)
      : { channelId: config.channel_id };
    try {
      await client.rest.delete(`/channels/${targetChannelId}/messages/${entry.starboard_message_id}`);
    } catch { /* already gone */ }
  }

  try {
    db.prepare(`DELETE FROM starboard_entries WHERE guild_id = ? AND message_id = ?`).run(guildId, messageId);
  } catch { /* best effort */ }
}

export async function handleStarReaction(client, reaction, userId) {
  const guildId   = reaction.guild_id ?? reaction.guildId;
  const messageId = reaction.message_id ?? reaction.messageId;
  const channelId = reaction.channel_id ?? reaction.channelId;
  logger.debug(`[STARBOARD] reaction received guildId=${guildId} messageId=${messageId} userId=${userId} emoji=${JSON.stringify(reaction.emoji)}`);
  if (!guildId || !messageId) { logger.debug('[STARBOARD] exit: missing guildId or messageId'); return; }

  const config = getStarboardConfig(guildId);
  logger.debug(`[STARBOARD] config=${JSON.stringify(config)}`);
  if (!config?.enabled || !config.channel_id) { logger.debug('[STARBOARD] exit: not enabled or no channel_id'); return; }

  const emoji = emojiKey(reaction.emoji ?? reaction);
  const configEmoji = resolveConfigEmoji(config.emoji);
  logger.debug(`[STARBOARD] emoji="${emoji}" configEmoji="${configEmoji}"`);
  if (!sameEmoji(emoji, configEmoji)) { logger.debug('[STARBOARD] exit: emoji mismatch'); return; }

  // Per-category exclusion/redirect. Resolved before fetching the message
  // to skip that extra call entirely for excluded categories.
  const { excluded, channelId: targetChannelId } = await resolveStarboardChannel(client, guildId, channelId, config.channel_id);
  if (excluded) { logger.debug('[STARBOARD] exit: category excluded from starboard'); return; }

  // Fetch the original message first, we need it for self_star and ignore_bots checks
  let originalMsg = null;
  try { originalMsg = await client.rest.get(`/channels/${channelId}/messages/${messageId}`); } catch (err) { logger.debug(`[STARBOARD] exit: failed to fetch message: ${err.message}`); return; }

  // Ignore bot messages if configured
  if (config.ignore_bots && originalMsg?.author?.bot) { logger.debug('[STARBOARD] exit: bot message ignored'); return; }

  // Block self-starring unless explicitly allowed
  if (!config.self_star && originalMsg?.author?.id === userId) { logger.debug('[STARBOARD] exit: self-star blocked'); return; }

  // Don't star messages in the starboard channel itself
  if (channelId === targetChannelId) { logger.debug('[STARBOARD] exit: reaction in starboard channel'); return; }

  // Fetch current reaction count from the message object (more reliable than reaction payload)
  const react = (originalMsg?.reactions ?? []).find(r => sameEmoji(emojiKey(r.emoji), configEmoji));
  const starCount = react?.count ?? 1;
  logger.debug(`[STARBOARD] starCount=${starCount} threshold=${config.threshold}`);

  const entry = stmts.getEntry.get(guildId, messageId);

  if (starCount < config.threshold) {
    // Below threshold, track count but don't post
    stmts.upsertEntry.run(guildId, messageId, entry?.starboard_message_id ?? null, starCount);
    logger.debug('[STARBOARD] exit: below threshold');
    return;
  }

  // Fetch the starboard channel via REST (client.channels.fetch is not a FluxerJS v1.3 method)
  const starChannel = await client.rest.get(`/channels/${targetChannelId}`).catch((err) => { logger.debug(`[STARBOARD] starboard channel fetch failed: ${err.message}`); return null; });
  if (!starChannel) { logger.debug('[STARBOARD] exit: starboard channel not found'); return; }

  const embed     = buildStarboardEmbed(guildId, channelId, messageId, originalMsg);
  const videoUrl  = findVideoUrl(getAttachments(originalMsg));
  const hidden    = findHiddenMedia(getAttachments(originalMsg));
  const content   = `${displayEmoji(config.emoji)} **${starCount}** | <#${channelId}>${hidden ? ' · 🙈 has a spoiler' : ''}${videoUrl ? `\n${videoUrl}` : ''}`;

  try {
    if (entry?.starboard_message_id) {
      await client.rest.patch(
        `/channels/${targetChannelId}/messages/${entry.starboard_message_id}`,
        { body: { content, embeds: [embed.toJSON()] } }
      );
      stmts.upsertEntry.run(guildId, messageId, entry.starboard_message_id, starCount);
    } else {
      // A spoilered image or video goes up again as a spoiler attachment.
      const upload = hidden ? await spoilerUpload(hidden) : null;
      const posted = await client.rest.post(
        `/channels/${targetChannelId}/messages`,
        upload
          ? { body: { content, embeds: [embed.toJSON()], attachments: upload.attachments }, files: upload.files }
          : { body: { content, embeds: [embed.toJSON()] } }
      );
      stmts.upsertEntry.run(guildId, messageId, posted?.id ?? null, starCount);
    }
  } catch (err) {
    logger.warn(`[STARBOARD] Failed to post/update for ${messageId} in ${guildId}:`, err.message);
  }
}

export async function handleStarRemove(client, reaction) {
  const guildId   = reaction.guild_id ?? reaction.guildId;
  const messageId = reaction.message_id ?? reaction.messageId;
  const channelId = reaction.channel_id ?? reaction.channelId;
  if (!guildId || !messageId) return;

  const config = getStarboardConfig(guildId);
  if (!config?.enabled || !config.channel_id) return;

  const emoji = emojiKey(reaction.emoji ?? reaction);
  if (!sameEmoji(emoji, resolveConfigEmoji(config.emoji))) return;

  const entry = stmts.getEntry.get(guildId, messageId);
  if (!entry?.starboard_message_id) return;

  const { channelId: targetChannelId } = await resolveStarboardChannel(client, guildId, channelId, config.channel_id);

  // Fetch current count from the live message
  let starCount = 0;
  let originalMsg = null;
  try {
    originalMsg = await client.rest.get(`/channels/${channelId}/messages/${messageId}`);
    const react = (originalMsg?.reactions ?? []).find(r => sameEmoji(emojiKey(r.emoji), resolveConfigEmoji(config.emoji)));
    starCount = react?.count ?? 0;
  } catch { /* message deleted, treat as 0 */ }

  if (starCount >= config.threshold) {
    stmts.upsertEntry.run(guildId, messageId, entry.starboard_message_id, starCount);
    // Preserve the video link line (if any) when refreshing the count,
    // otherwise a count update would silently strip it back out.
    const videoUrl = originalMsg ? findVideoUrl(getAttachments(originalMsg)) : null;
    const hidden   = originalMsg ? findHiddenMedia(getAttachments(originalMsg)) : null;
    // The embed is rebuilt too, same as on a new star, so a post made before
    // spoilers were kept hidden loses its uncovered picture either way.
    const embeds   = originalMsg ? { embeds: [buildStarboardEmbed(guildId, channelId, messageId, originalMsg).toJSON()] } : {};
    try {
      await client.rest.patch(
        `/channels/${targetChannelId}/messages/${entry.starboard_message_id}`,
        { body: { content: `${displayEmoji(config.emoji)} **${starCount}** | <#${channelId}>${hidden ? ' · 🙈 has a spoiler' : ''}${videoUrl ? `\n${videoUrl}` : ''}`, ...embeds } }
      );
    } catch { /* best effort */ }
    return;
  }

  // Fell below threshold, delete the starboard post
  try {
    await client.rest.delete(`/channels/${targetChannelId}/messages/${entry.starboard_message_id}`);
  } catch { /* already deleted */ }

  // upsertEntry's COALESCE means a bound NULL can never actually clear an
  // existing starboard_message_id, it would keep pointing at the message
  // just deleted above. The next reaction to cross the threshold again
  // would then try to PATCH that dead ID, fail silently, and never post a
  // fresh one, exactly the "took the post away and didn't post it again"
  // symptom reported. clearStarboardMessage genuinely nulls it out.
  stmts.clearStarboardMessage.run(starCount, guildId, messageId);
}

// ─── updateStarboardConfig ────────────────────────────────────────────────────
// Update individual starboard config fields. Used by the starboard command.
export function updateStarboardConfig(guildId, fields = {}) {
  const VALID = new Set(['enabled','channel_id','threshold','emoji','self_star','ignore_bots']);
  stmts.ensureConfig.run(guildId);
  for (const [k, v] of Object.entries(fields)) {
    if (!VALID.has(k)) continue;
    stmts.setField(k).run(v, guildId);
  }
}