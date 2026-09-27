import db from '../db.js';
import { getModlogChannel } from './guildSettings.js';
import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../config/embeds.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS watchlist (
    guild_id TEXT    NOT NULL,
    user_id  TEXT    NOT NULL,
    reason   TEXT    NOT NULL DEFAULT 'No reason provided',
    added_by TEXT    NOT NULL,
    added_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (guild_id, user_id)
  )
`);

// Separate config table for watchlist alert channel
db.exec(`
  CREATE TABLE IF NOT EXISTS watchlist_config (
    guild_id   TEXT PRIMARY KEY,
    channel_id TEXT
  )
`);

const stmts = {
  // added_at supplied explicitly rather than relying on the column's
  // DEFAULT (unixepoch()) declared above: the live table predates that
  // default (CREATE TABLE IF NOT EXISTS is a no-op against it) and has
  // notnull=1 with no default on disk, so omitting it here threw "NOT
  // NULL constraint failed: watchlist.added_at" on every single add,
  // uncaught, quarantining the command after one use.
  add:          db.prepare(`INSERT OR REPLACE INTO watchlist (guild_id, user_id, reason, added_by, added_at) VALUES (?, ?, ?, ?, unixepoch())`),
  remove:       db.prepare(`DELETE FROM watchlist WHERE guild_id = ? AND user_id = ?`),
  get:          db.prepare(`SELECT * FROM watchlist WHERE guild_id = ? AND user_id = ?`),
  list:         db.prepare(`SELECT * FROM watchlist WHERE guild_id = ? ORDER BY added_at DESC`),
  setChannel:   db.prepare(`INSERT OR REPLACE INTO watchlist_config (guild_id, channel_id) VALUES (?, ?)`),
  getChannel:   db.prepare(`SELECT channel_id FROM watchlist_config WHERE guild_id = ?`),
};

export function addToWatchlist(guildId, userId, reason, addedBy) {
  // The live table's reason column is NOT NULL with a default of 'No
  // reason provided', but a column DEFAULT only applies when the column
  // is omitted from the INSERT entirely, an explicit NULL still violates
  // NOT NULL. Passing no reason used to throw here, uncaught, quarantining
  // the whole command after one use (QUARANTINE_THRESHOLD = 1).
  stmts.add.run(guildId, userId, reason ?? 'No reason provided', addedBy);
}

export function removeFromWatchlist(guildId, userId) {
  stmts.remove.run(guildId, userId);
}

export function isWatched(guildId, userId) {
  return !!stmts.get.get(guildId, userId);
}

export function getWatchEntry(guildId, userId) {
  return stmts.get.get(guildId, userId) ?? null;
}

export function listWatchlist(guildId) {
  return stmts.list.all(guildId);
}

export function setWatchChannel(guildId, channelId) {
  stmts.setChannel.run(guildId, channelId);
}

export function getWatchChannel(guildId) {
  return stmts.getChannel.get(guildId)?.channel_id ?? null;
}

// This can fall back to the shared modlog channel (below), which must never
// carry a live user/role/channel tag, resolve a plain display name instead.
async function resolveUsername(client, userId) {
  try {
    const user = await client.rest.get(`/users/${userId}`).catch(() => null);
    return user?.username ?? userId;
  } catch {
    return userId;
  }
}

export async function alertWatchlist(client, guildId, userId, event, context) {
  const entry = getWatchEntry(guildId, userId);
  if (!entry) return;

  const channelId = getWatchChannel(guildId) ?? getModlogChannel(guildId);
  if (!channelId) return;

  const [userTag, addedByTag] = await Promise.all([
    resolveUsername(client, userId),
    resolveUsername(client, entry.added_by),
  ]);

  const embed = new EmbedBuilder()
    .setColor(COLORS.WARNING)
    .setTitle(`👁️ Watchlist Alert, ${event}`)
    .addFields(
      { name: 'User',   value: `${userTag} (\`${userId}\`)`, inline: true },
      { name: 'Reason', value: entry.reason ?? 'No reason', inline: true },
      { name: 'Added By', value: `${addedByTag} (\`${entry.added_by}\`)`, inline: true },
    )
    .setTimestamp();

  if (context) embed.setDescription(context.slice(0, 500));

  // Raw REST, not client.channels.fetch() + channel.send(): confirmed in
  // production that pattern fails with "channel.send is not a function"
  // for at least one channel type on v2.0.1's SDK.
  await client.rest.post(`/channels/${channelId}/messages`, { body: { embeds: [embed.toJSON()] } }).catch(() => {});
}
