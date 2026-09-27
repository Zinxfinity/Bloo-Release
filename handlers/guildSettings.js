import db from '../db.js';

// ─── In-memory cache ──────────────────────────────────────────────────────────
// Map<guildId, { prefix, modlogChannelId, updatedAt }>
const cache = new Map();

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  get: db.prepare(`
    SELECT prefix, modlog_channel_id, updated_at
    FROM guild_settings WHERE guild_id = ?
  `),
  setPrefix: db.prepare(`
    UPDATE guild_settings
    SET prefix = ?, updated_at = unixepoch()
    WHERE guild_id = ?
  `),
  setModlog: db.prepare(`
    UPDATE guild_settings
    SET modlog_channel_id = ?, updated_at = unixepoch()
    WHERE guild_id = ?
  `),
  // prefix supplied explicitly rather than relying on guild_settings'
  // SQL-level DEFAULT 'b!' (db.js), that default is static and can never
  // reflect a changed PREFIX env var. Without this, getPrefix() below
  // would return the correct env-derived prefix on a brand new guild's
  // very first call (before this row existed) and then silently revert
  // to the SQL default on every call after, once the row it just
  // created is actually read back.
  ensure: db.prepare(`
    INSERT OR IGNORE INTO guild_settings (guild_id, prefix, updated_at)
    VALUES (?, ?, unixepoch())
  `),
};

// ─── ensure ───────────────────────────────────────────────────────────────────
export function ensureGuild(guildId) {
  stmts.ensure.run(guildId, process.env.PREFIX ?? 'b!');
}

// ─── getPrefix ────────────────────────────────────────────────────────────────
export function getPrefix(guildId) {
  const cached = cache.get(guildId);
  const row    = stmts.get.get(guildId);

  if (!row) {
    ensureGuild(guildId);
    return process.env.PREFIX ?? 'b!';
  }

  // If DB is newer than cache, re-read (dashboard writes directly to DB)
  if (!cached || row.updated_at > cached.updatedAt) {
    cache.set(guildId, {
      prefix:           row.prefix          ?? process.env.PREFIX ?? 'b!',
      modlogChannelId:  row.modlog_channel_id ?? null,
      updatedAt:        row.updated_at,
    });
  }

  return cache.get(guildId).prefix;
}

// ─── getModlogChannel ─────────────────────────────────────────────────────────
export function getModlogChannel(guildId) {
  const cached = cache.get(guildId);
  const row    = stmts.get.get(guildId);
  if (!row) return null;

  if (!cached || row.updated_at > cached.updatedAt) {
    cache.set(guildId, {
      prefix:          row.prefix          ?? process.env.PREFIX ?? 'b!',
      modlogChannelId: row.modlog_channel_id ?? null,
      updatedAt:       row.updated_at,
    });
  }

  return cache.get(guildId).modlogChannelId;
}

// ─── setPrefix ────────────────────────────────────────────────────────────────
export function setPrefix(guildId, prefix) {
  ensureGuild(guildId);
  stmts.setPrefix.run(prefix, guildId);
  cache.delete(guildId); // invalidate immediately
}

// ─── setModlogChannel ─────────────────────────────────────────────────────────
export function setModlogChannel(guildId, channelId) {
  ensureGuild(guildId);
  stmts.setModlog.run(channelId, guildId);
  cache.delete(guildId);
}

// ─── invalidate ───────────────────────────────────────────────────────────────
export function invalidateGuild(guildId) {
  cache.delete(guildId);
}
