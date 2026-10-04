// ============================================================
//  handlers/votes.js
//
//  FluxerList votes and the perks they unlock. On FluxerList a vote is one
//  per person and lasts until the voter removes it, and there's no webhook,
//  so Bloo checks two ways:
//    - checkVote(): one person, live, when they run b!vote (cached 5 min)
//    - a poll of the whole voter list every 10 minutes, for new votes and
//      removed ones
//  Perks last while the vote stands: a Supporter mark on rank cards, the
//  vote-only card theme, an optional Supporter role in the support server,
//  and an optional thank-you post. FluxerList's only rule is no faked votes
//  (bots, scripts, fake accounts); rewarding real voters is fine.
//
//  .env: FLUXERLIST_API_KEY and FLUXER_CLIENT_ID (required for any of this);
//  VOTE_THANKS_WEBHOOK_URL, VOTE_SUPPORT_GUILD_ID, VOTE_SUPPORTER_ROLE_ID
//  (optional extras).
// ============================================================

import db from '../db.js';
import logger from '../utils/logger.js';

const API = 'https://fluxerlist.com/api/v1';
const POLL_MS = 10 * 60 * 1000;
const CHECK_CACHE_MS = 5 * 60 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS fluxerlist_voters (
    user_id     TEXT PRIMARY KEY,
    username    TEXT,
    voted_at    TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    thanked     INTEGER NOT NULL DEFAULT 0,
    first_seen  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS fluxerlist_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const q = {
  get:      db.prepare(`SELECT * FROM fluxerlist_voters WHERE user_id = ?`),
  upsert:   db.prepare(`INSERT INTO fluxerlist_voters (user_id, username, voted_at, active, thanked) VALUES (?, ?, ?, 1, ?)
                        ON CONFLICT (user_id) DO UPDATE SET username = COALESCE(excluded.username, username), voted_at = COALESCE(excluded.voted_at, voted_at), active = 1, updated_at = unixepoch()`),
  thanked:  db.prepare(`UPDATE fluxerlist_voters SET thanked = 1 WHERE user_id = ?`),
  deactivate: db.prepare(`UPDATE fluxerlist_voters SET active = 0, updated_at = unixepoch() WHERE user_id = ?`),
  active:   db.prepare(`SELECT user_id FROM fluxerlist_voters WHERE active = 1`),
  count:    db.prepare(`SELECT COUNT(*) c FROM fluxerlist_voters WHERE active = 1`),
  meta:     db.prepare(`SELECT value FROM fluxerlist_meta WHERE key = ?`),
  setMeta:  db.prepare(`INSERT INTO fluxerlist_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`),
};

const botId = () => process.env.FLUXER_CLIENT_ID || null;
export const votingConfigured = () => !!(process.env.FLUXERLIST_API_KEY && botId());
export const voteUrl = () => (botId() ? `https://fluxerlist.com/bots/${botId()}` : null);

async function api(path) {
  const res = await fetch(API + path, {
    headers: { Authorization: `Bearer ${process.env.FLUXERLIST_API_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error('FluxerList rate limit'), { retryAt: body.reset ?? Date.now() + 60_000 });
  }
  if (!res.ok) throw new Error(`FluxerList answered ${res.status}`);
  return res.json();
}

// ─── Perks ────────────────────────────────────────────────────────────────────
// Read by card rendering, so it's a plain local lookup, never a network call.
export function isSupporter(userId) {
  return !!q.get.get(String(userId))?.active;
}

async function setSupportRole(client, userId, give) {
  const guild = process.env.VOTE_SUPPORT_GUILD_ID, role = process.env.VOTE_SUPPORTER_ROLE_ID;
  if (!client || !guild || !role) return;
  const path = `/guilds/${guild}/members/${userId}/roles/${role}`;
  try {
    if (give) await client.rest.put(path); else await client.rest.delete(path);
  } catch (err) {
    // Not in the support server, or Bloo's role sits below the Supporter role.
    if (!/404|Unknown Member/i.test(err.message)) logger.debug(`[VOTES] Supporter role ${give ? 'give' : 'remove'} failed for ${userId}: ${err.message}`);
  }
}

async function postThanks(userId, username) {
  const url = process.env.VOTE_THANKS_WEBHOOK_URL;
  if (!url) return;
  const total = q.count.get().c;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Bloo',
      avatar_url: process.env.BLOO_PFP_URL || undefined,
      content: `💚 Thanks <@${userId}> for voting for Bloo! That's **${total}** supporter${total === 1 ? '' : 's'} so far.${voteUrl() ? ` Vote too: <${voteUrl()}>` : ''}`,
      allowed_mentions: { parse: [] }, // shows the name without pinging
    }),
    signal: AbortSignal.timeout(8000),
  }).catch(err => logger.debug(`[VOTES] Thank-you post failed: ${err.message}`));
}

// A vote Bloo hasn't seen as active before: record it, give the role, and
// thank them once (unless this is the first-ever read, see pollVotes).
async function welcomeVoter(client, userId, username, votedAt, { thank = true } = {}) {
  const before = q.get.get(userId);
  q.upsert.run(userId, username ?? null, votedAt ?? null, thank ? 0 : 1);
  if (before?.active) return;
  await setSupportRole(client, userId, true);
  if (thank && !before?.thanked) {
    q.thanked.run(userId);
    await postThanks(userId, username);
  }
}

async function dropVoter(client, userId) {
  q.deactivate.run(userId);
  await setSupportRole(client, userId, false);
}

// ─── On demand (b!vote) ───────────────────────────────────────────────────────
const checked = new Map(); // userId -> { at, voted }
export async function checkVote(client, userId, username = null) {
  if (!votingConfigured()) return { voted: isSupporter(userId), votes: null, offline: true };
  const hit = checked.get(userId);
  if (hit && Date.now() - hit.at < CHECK_CACHE_MS) return hit;
  try {
    const r = await api(`/bots/${botId()}/check?fluxerId=${encodeURIComponent(userId)}`);
    const result = { at: Date.now(), voted: !!r.voted, votes: r.votes ?? null };
    checked.set(userId, result);
    if (result.voted && !isSupporter(userId)) await welcomeVoter(client, userId, username, null);
    if (!result.voted && isSupporter(userId)) await dropVoter(client, userId);
    return result;
  } catch (err) {
    logger.debug(`[VOTES] Vote check failed: ${err.message}`);
    return { voted: isSupporter(userId), votes: null, offline: true };
  }
}

// ─── Poll the full voter list ─────────────────────────────────────────────────
let retryAt = 0;
export async function pollVotes(client) {
  if (!votingConfigured() || Date.now() < retryAt) return null;
  const voters = [];
  let total = null;
  try {
    for (let page = 1; page <= 200; page++) {
      const r = await api(`/bots/${botId()}/voters?limit=100&page=${page}`);
      total = r.total;
      voters.push(...(r.voters ?? []));
      if (!r.voters?.length || voters.length >= total) break;
    }
  } catch (err) {
    if (err.retryAt) retryAt = err.retryAt;
    logger.debug(`[VOTES] Voter list fetch failed: ${err.message}`);
    return null;
  }
  // The very first read only records who has already voted: no thank-you
  // flood for votes cast before this feature existed.
  const firstRun = !q.meta.get('seeded');
  const now = new Set();
  for (const v of voters) {
    if (!v.fluxerId) continue;
    now.add(v.fluxerId);
    await welcomeVoter(client, v.fluxerId, v.username, v.votedAt, { thank: !firstRun });
  }
  if (firstRun) q.setMeta.run('seeded', String(Date.now()));
  // Only take perks away after a complete read, so a partial or failed fetch
  // can never strip everyone's Supporter status.
  let removed = 0;
  if (total != null && voters.length >= total) {
    for (const { user_id } of q.active.all()) {
      if (!now.has(user_id)) { await dropVoter(client, user_id); removed++; }
    }
  }
  return { total, seen: voters.length, removed, firstRun };
}

let _timer = null;
export function startVotePoller(client) {
  if (_timer || !votingConfigured()) return;
  const run = () => pollVotes(client).catch(err => logger.warn('[VOTES] Poll failed:', err.message));
  setTimeout(run, 30_000); // after boot settles
  _timer = setInterval(run, POLL_MS);
  logger.info('[VOTES] FluxerList vote poller started (10m).');
}
