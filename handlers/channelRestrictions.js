import db from '../db.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_channels (
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  )
`);

const stmts = {
  list:   db.prepare(`SELECT channel_id FROM bot_channels WHERE guild_id = ?`),
  add:    db.prepare(`INSERT OR IGNORE INTO bot_channels (guild_id, channel_id) VALUES (?, ?)`),
  remove: db.prepare(`DELETE FROM bot_channels WHERE guild_id = ? AND channel_id = ?`),
  clear:  db.prepare(`DELETE FROM bot_channels WHERE guild_id = ?`),
  count:  db.prepare(`SELECT COUNT(*) AS n FROM bot_channels WHERE guild_id = ?`),
};

/**
 * Returns true if the channel is allowed (or if no restrictions are configured).
 */
export function isChannelAllowed(guildId, channelId) {
  const { n } = stmts.count.get(guildId);
  if (n === 0) return true; // no restrictions set, all channels allowed
  const rows = stmts.list.all(guildId);
  return rows.some(r => r.channel_id === channelId);
}

export function listChannels(guildId) {
  return stmts.list.all(guildId).map(r => r.channel_id);
}

export function addChannel(guildId, channelId) {
  stmts.add.run(guildId, channelId);
}

export function removeChannel(guildId, channelId) {
  stmts.remove.run(guildId, channelId);
}

export function clearChannels(guildId) {
  stmts.clear.run(guildId);
}
