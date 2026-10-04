// ============================================================
//  handlers/betaTesters.js
//
//  Commands marked `beta: true` are only usable by beta testers: anyone
//  with BETA_ROLE_ID in Bloo's support server (BETA_GUILD_ID, or
//  VOTE_SUPPORT_GUILD_ID when that's unset), plus bot owners. For everyone
//  else a beta command behaves as if it doesn't exist, and it's left out of
//  b!help and the docs. Ship a feature by removing its `beta` flag.
// ============================================================

import { isBotOwner } from '../config/dashAccess.js';

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // userId -> { ok, at }

const guildId = () => process.env.BETA_GUILD_ID || process.env.VOTE_SUPPORT_GUILD_ID || null;
const roleId  = () => process.env.BETA_ROLE_ID || null;
export const betaConfigured = () => !!(guildId() && roleId());

const API = () => (process.env.FLUXER_API || 'https://api.fluxer.app').replace(/\/+$/, '');

export async function isBetaTester(userId) {
  if (!userId) return false;
  if (isBotOwner(userId)) return true;
  if (!betaConfigured()) return false;
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ok;
  let ok = false;
  try {
    const res = await fetch(`${API()}/guilds/${guildId()}/members/${userId}`, {
      headers: { Authorization: `Bot ${process.env.FLUXER_BOT_TOKEN}` },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) ok = ((await res.json())?.roles ?? []).includes(roleId());
    else if (res.status !== 404) return hit?.ok ?? false; // API trouble: don't cache a "no"
  } catch {
    return hit?.ok ?? false;
  }
  cache.set(userId, { ok, at: Date.now() });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return ok;
}

// The beta commands this bot has loaded, for b!beta.
export const betaCommands = client => [...new Set(client.commands.values())].filter(c => c.beta);
