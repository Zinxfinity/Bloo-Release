import db from '../db.js';
import { isStaff } from './staffSystem.js';
import logger from '../utils/logger.js';

// automod_config table created in db.js

const stmts = {
  get:    db.prepare(`SELECT * FROM automod_config WHERE guild_id = ?`),
  ensure: db.prepare(`INSERT OR IGNORE INTO automod_config (guild_id) VALUES (?)`),
  update: db.prepare(`
    UPDATE automod_config SET
      enabled=?, mention_threshold=?, mention_action=?,
      spam_threshold=?, spam_window_s=?, spam_action=?,
      emoji_threshold=?, emoji_action=?,
      caps_threshold=?, caps_min_length=?, caps_action=?,
      invite_action=?, updated_at=unixepoch()
    WHERE guild_id = ?
  `),
};

// Per-guild spam tracking: Map<guildId, Map<userId, message timestamps[]>>
const spamTracker = new Map();

// Forget members who've gone quiet, so the tracker doesn't grow forever.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [guildId, users] of spamTracker) {
    for (const [userId, ts] of users) if (!ts.length || ts[ts.length - 1] < cutoff) users.delete(userId);
    if (!users.size) spamTracker.delete(guildId);
  }
}, 5 * 60 * 1000).unref();

function getSpamTimestamps(guildId, userId) {
  if (!spamTracker.has(guildId)) spamTracker.set(guildId, new Map());
  const guild = spamTracker.get(guildId);
  if (!guild.has(userId)) guild.set(userId, []);
  return guild.get(userId);
}

export function getAutomodConfig(guildId) {
  stmts.ensure.run(guildId);
  return stmts.get.get(guildId);
}

export function updateAutomodConfig(guildId, fields) {
  stmts.ensure.run(guildId);
  const existing = getAutomodConfig(guildId);
  stmts.update.run(
    fields.enabled           ?? existing.enabled,
    fields.mention_threshold ?? existing.mention_threshold,
    fields.mention_action    ?? existing.mention_action,
    fields.spam_threshold    ?? existing.spam_threshold,
    fields.spam_window_s     ?? existing.spam_window_s,
    fields.spam_action       ?? existing.spam_action,
    fields.emoji_threshold   ?? existing.emoji_threshold,
    fields.emoji_action      ?? existing.emoji_action,
    fields.caps_threshold    ?? existing.caps_threshold,
    fields.caps_min_length   ?? existing.caps_min_length,
    fields.caps_action       ?? existing.caps_action,
    fields.invite_action     ?? existing.invite_action,
    guildId,
  );
}

/**
 * Run all automod checks on a message.
 * Returns true if the message was blocked (deleted).
 */
export async function runAutomod(client, message) {
  const guildId = message.guildId;
  const userId  = message.author?.id;
  if (!guildId || !userId) return false;

  // Staff are exempt from automod
  if (await isStaff(client, guildId, userId)) return false;

  const config = getAutomodConfig(guildId);
  if (!config?.enabled) return false;

  const content = message.content ?? '';

  // ── Mention spam ─────────────────────────────────────────────────────────
  const mentionCount = (message.mentions?.length ?? 0) + (message.mentionRoles?.length ?? 0);
  if (mentionCount >= config.mention_threshold) {
    await applyAction(client, message, config.mention_action, 'Mention spam');
    return true;
  }

  // ── Message spam ──────────────────────────────────────────────────────────
  const now = Date.now();
  const timestamps = getSpamTimestamps(guildId, userId);
  timestamps.push(now);
  const windowMs = config.spam_window_s * 1000;
  const recent   = timestamps.filter(t => now - t < windowMs);
  spamTracker.get(guildId).set(userId, recent); // prune old timestamps

  if (recent.length >= config.spam_threshold) {
    spamTracker.get(guildId).set(userId, []); // reset after trigger
    await applyAction(client, message, config.spam_action, 'Message spam');
    return true;
  }

  // ── Emoji spam ────────────────────────────────────────────────────────────
  // \p{Emoji} also matches the digits 0-9, # and *, so pasting a single user
  // ID used to count as 18 emoji. Extended_Pictographic is the actual emoji
  // glyphs; custom emoji (<:name:id> / <a:name:id>) are counted separately.
  const emojiCount = (content.match(/\p{Extended_Pictographic}/gu)?.length ?? 0)
                   + (content.match(/<a?:\w+:\d+>/g)?.length ?? 0);
  if (emojiCount >= config.emoji_threshold) {
    await applyAction(client, message, config.emoji_action, 'Emoji spam');
    return true;
  }

  // ── Caps spam ─────────────────────────────────────────────────────────────
  if (content.length >= config.caps_min_length) {
    const letters  = content.replace(/[^a-zA-Z]/g, '');
    const caps     = content.replace(/[^A-Z]/g, '');
    const capsPct  = letters.length > 0 ? (caps.length / letters.length) * 100 : 0;
    if (capsPct >= config.caps_threshold) {
      await applyAction(client, message, config.caps_action, 'Caps spam');
      return true;
    }
  }

  // ── Invite links ──────────────────────────────────────────────────────────
  if (/(?:fluxer\.gg|discord\.gg)\/[a-zA-Z0-9]+/i.test(content)) {
    if (config.invite_action === 'delete') {
      try { await message.delete(); } catch { /* best effort */ }
      return true;
    }
    await applyAction(client, message, config.invite_action, 'Invite link');
    return true;
  }

  return false;
}

async function applyAction(client, message, action, reason) {
  try { await message.delete(); } catch { /* best effort */ }

  if (!action || action === 'delete') return;

  const guildId = message.guildId;
  const userId  = message.author?.id;
  if (!guildId || !userId) return;

  // Every automod punishment is a real moderation case (it used to leave no
  // record at all), and warns/bans go through the same paths as the commands.
  const why = `Automod: ${reason}`;
  const { recordAutoCase, autoWarn } = await import('./autoModCase.js');
  const user = { id: userId, username: message.author?.username };
  const log = (act, extraFields) => recordAutoCase(client, guildId, user, act, why, 'Automod', extraFields);

  try {
    if (action === 'warn') {
      await autoWarn(client, guildId, user, why, 'Automod');
    } else if (action === 'mute') {
      const until = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await client.rest.patch(`/guilds/${guildId}/members/${userId}`, {
        body: { communication_disabled_until: until },
      });
      await log('mute', [{ name: 'Duration', value: '10m', inline: true }]);
    } else if (action === 'kick') {
      await client.rest.delete(`/guilds/${guildId}/members/${userId}?reason=${encodeURIComponent(why)}`);
      await log('kick');
    } else if (action === 'ban') {
      const { performBanAction } = await import('./banSystem.js');
      await performBanAction(client.rest, guildId, userId, why, 'ban', 1);
      await log('ban');
    }
  } catch (err) {
    logger.warn(`[AUTOMOD] Action ${action} failed for ${userId} in ${guildId}:`, err.message);
  }
}
