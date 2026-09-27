import db from '../db.js';
import logger from '../utils/logger.js';
import * as resilience from './resilience.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS member_count_cache (
    guild_id     TEXT    PRIMARY KEY,
    member_count INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT 0
  )
`);

const stmts = {
  upsert: db.prepare(`
    INSERT OR REPLACE INTO member_count_cache (guild_id, member_count, updated_at)
    VALUES (?, ?, unixepoch())
  `),
  get: db.prepare(`SELECT member_count FROM member_count_cache WHERE guild_id = ?`),
};

export function getCachedMemberCount(guildId) {
  return stmts.get.get(guildId)?.member_count ?? 0;
}

export function updateMemberCount(guildId, count) {
  stmts.upsert.run(guildId, count);
}

// GuildManager extends Collection directly, it has no .cache sub-property
// (confirmed against the real @fluxerjs/core source), so `client.guilds
// ?.cache` was always undefined and both functions below always fell back
// to an empty Map, iterating zero guilds, always. Separately, the real
// Guild class has no `memberCount` field at all, the only way this
// library exposes a count is a raw REST fetch with `?with_counts=true`
// reading `approximate_member_count` off the JSON, same fix already
// applied to welcomeSystem.js/serverinfo.js elsewhere in this codebase.
// Both functions now share one real REST-backed refresh implementation
// instead of each having their own (differently) broken guild-iteration.
async function refreshAll(client) {
  const guilds = client.guilds ?? new Map();
  let synced = 0;
  for (const [guildId] of guilds) {
    try {
      const data = await client.rest.get(`/guilds/${guildId}?with_counts=true`);
      const count = data?.approximate_member_count ?? data?.member_count ?? 0;
      if (count) { stmts.upsert.run(guildId, count); synced++; }
    } catch { /* non-fatal */ }
  }
  return synced;
}

export async function syncMemberCountsOnReady(client) {
  const synced = await refreshAll(client);
  logger.info(`[MEMBERCOUNT] Synced ${synced} guild(s) on ready.`);
}

let _ttlTimer = null;
export function startMemberCountTTL(client) {
  if (_ttlTimer) return;
  const TTL_MS = 30 * 60 * 1000; // 30 min refresh

  const refresh = () => refreshAll(client);

  _ttlTimer = setInterval(() => resilience.runLight('memberCountSync.ttlRefresh', refresh), TTL_MS);
  _ttlTimer.unref?.();
  logger.info('[MEMBERCOUNT] TTL refresh started (30m).');
}
