// ─── Link Auditor ──────────────────────────────────────────────────────────────
// Scoped v1 of the requested "Link & Files Auditor": links only, no file
// re-hosting yet (that needs its own byte-download/size-cap groundwork this
// codebase doesn't have, added later once this half is proven out).
// Archival is fire-and-forget with a hard timeout, never blocks the repost
// (web.archive.org isn't always fast), and is rate-limited per user (the
// feature's own bandwidth-abuse concern, raised when it was requested).
// Staff are exempt, matching handlers/linkEnforcement.js's own convention.

import logger from '../utils/logger.js';
import db from '../db.js';
import { isStaff } from './staffSystem.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS link_auditor_config (
    guild_id TEXT PRIMARY KEY,
    enabled  INTEGER NOT NULL DEFAULT 0
  );
`);

const stmts = {
  ensureConfig: db.prepare(`INSERT OR IGNORE INTO link_auditor_config (guild_id) VALUES (?)`),
  getConfig:    db.prepare(`SELECT * FROM link_auditor_config WHERE guild_id = ?`),
  setEnabled:   db.prepare(`UPDATE link_auditor_config SET enabled = ? WHERE guild_id = ?`),
};

export function getLinkAuditorConfig(guildId) {
  stmts.ensureConfig.run(guildId);
  return stmts.getConfig.get(guildId);
}

export function setLinkAuditorEnabled(guildId, enabled) {
  stmts.ensureConfig.run(guildId);
  stmts.setEnabled.run(enabled ? 1 : 0, guildId);
}

// Full URL (scheme + domain + optional path/query), not just the domain
// handlers/linkEnforcement.js's own URL_PATTERN captures, this needs the
// whole link to actually archive it.
const URL_PATTERN = /https?:\/\/[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?:\/\S*)?/gi;

// ─── Per-user rate limit ──────────────────────────────────────────────────────
// In-memory sliding window, resets on restart, that's fine, this is abuse
// prevention (a burst-of-links flood shouldn't hammer web.archive.org or
// spam the channel with reposts), not a durable record of anything.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX       = 5;
const _userRequestTimes = new Map();

function isRateLimited(userId) {
  const now = Date.now();
  const recent = (_userRequestTimes.get(userId) ?? []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  _userRequestTimes.set(userId, recent);
  return recent.length >= RATE_LIMIT_MAX;
}

function recordRequest(userId) {
  const recent = _userRequestTimes.get(userId) ?? [];
  recent.push(Date.now());
  _userRequestTimes.set(userId, recent);
}

// ─── Archival ─────────────────────────────────────────────────────────────────
// web.archive.org's Save Page Now only, deliberately not archive.is/
// archive.today: no public API, no reliable no-auth trigger, and known to
// be slow/CAPTCHA-gated, exactly the reliability risk flagged when this
// feature was requested. Can be added later behind the same best-effort/
// timeout shape if it turns out to be worth the flakiness.
//
// Two paths: with ARCHIVE_ORG_ACCESS_KEY/ARCHIVE_ORG_SECRET_KEY set (free,
// from https://archive.org/account/s3.php), uses the real authenticated
// SPN2 job API, which has a materially higher rate limit than the anonymous
// endpoint below (confirmed via a live test during development: the
// anonymous path got a 429 on its very first request from this
// environment). Without a key, falls back to the old anonymous GET
// /save/<url> trigger, still functional, just far more likely to get
// rate-limited under any real usage.
const ARCHIVE_TIMEOUT_MS = 15_000;
const ARCHIVE_POLL_INTERVAL_MS = 1_500;

function archiveOrgAuthHeader() {
  const access = process.env.ARCHIVE_ORG_ACCESS_KEY;
  const secret = process.env.ARCHIVE_ORG_SECRET_KEY;
  if (!access || !secret) return null;
  return `LOW ${access}:${secret}`;
}

async function archiveToWaybackAuthenticated(url, authHeader, deadline) {
  const headers = { 'Accept': 'application/json', 'Authorization': authHeader, 'User-Agent': 'Bloo-Bot/2.0 LinkAuditor' };

  const triggerRes = await fetch('https://web.archive.org/save', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ url }),
    signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
  });
  if (!triggerRes.ok) return null;
  const triggerBody = await triggerRes.json().catch(() => null);
  const jobId = triggerBody?.job_id;
  if (!jobId) return null;

  // Poll until the job resolves or the overall deadline is hit, SPN2 jobs
  // are async (the trigger above just queues the capture).
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, ARCHIVE_POLL_INTERVAL_MS));
    const statusRes = await fetch(`https://web.archive.org/save/status/${jobId}`, {
      headers,
      signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
    }).catch(() => null);
    if (!statusRes?.ok) continue;
    const status = await statusRes.json().catch(() => null);
    if (status?.status === 'success' && status.timestamp && status.original_url) {
      return `https://web.archive.org/web/${status.timestamp}/${status.original_url}`;
    }
    if (status?.status === 'error') return null;
    // status === 'pending', keep polling until the deadline.
  }
  return null; // timed out waiting on the job, not a hard failure, just too slow this time
}

async function archiveToWaybackAnonymous(url, deadline) {
  const res = await fetch(`https://web.archive.org/save/${encodeURIComponent(url)}`, {
    headers: { 'User-Agent': 'Bloo-Bot/2.0 LinkAuditor' },
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
  });
  return res.url?.includes('web.archive.org/web/') ? res.url : null;
}

async function archiveToWayback(url) {
  const deadline = Date.now() + ARCHIVE_TIMEOUT_MS;
  const authHeader = archiveOrgAuthHeader();
  try {
    return authHeader
      ? await archiveToWaybackAuthenticated(url, authHeader, deadline)
      : await archiveToWaybackAnonymous(url, deadline);
  } catch {
    return null; // best-effort: timeout, network error, or an unrecognized response all just mean no archive link
  }
}

// ─── Core ─────────────────────────────────────────────────────────────────────
export async function auditMessage(client, message) {
  const guildId = message.guildId;
  if (!guildId) return;

  const config = getLinkAuditorConfig(guildId);
  if (!config.enabled) return;

  const content = message.content ?? '';
  const urls = [...new Set([...content.matchAll(URL_PATTERN)].map(m => m[0]))];
  if (!urls.length) return;

  const userId = message.author.id;
  if (await isStaff(client, guildId, userId)) return;

  if (isRateLimited(userId)) return; // silently skip under a burst, don't repost/archive
  recordRequest(userId);

  const authorTag = message.author.username ?? userId;

  // Best-effort: this may already be gone if another feature (e.g. link
  // enforcement) also acted on the same message, that's fine, still repost.
  try { await message.delete(); } catch { /* best effort */ }

  // Repost immediately with a placeholder, archival must never block this
  // (the locked scoped-v1 decision: web.archive.org isn't always fast).
  const placeholder = `**Originally posted by ${authorTag}:**\n${content}\n\n_(archiving ${urls.length} link${urls.length === 1 ? '' : 's'}…)_`;
  let sent;
  try {
    sent = await client.rest.post(`/channels/${message.channelId}/messages`, {
      body: { content: placeholder.slice(0, 2000), allowed_mentions: { parse: [] } },
    });
  } catch (err) {
    logger.warn(`[LINKAUDITOR] Failed to repost in guild ${guildId}:`, err.message);
    return;
  }

  finishArchiving(client, message.channelId, sent.id, authorTag, content, urls).catch(err => {
    logger.warn(`[LINKAUDITOR] Background archive step failed:`, err.message);
  });
}

async function finishArchiving(client, channelId, messageId, authorTag, originalContent, urls) {
  const results = await Promise.all(urls.map(async (url) => ({ url, archived: await archiveToWayback(url) })));

  let rewritten = originalContent;
  for (const { url, archived } of results) {
    if (archived) rewritten = rewritten.split(url).join(archived);
  }

  const failed = results.filter(r => !r.archived).length;
  let finalContent = `**Originally posted by ${authorTag}:**\n${rewritten}`;
  if (failed > 0) {
    finalContent += `\n\n_(${failed} link${failed === 1 ? '' : 's'} could not be archived, shown as originally posted)_`;
  }

  try {
    await client.rest.patch(`/channels/${channelId}/messages/${messageId}`, {
      body: { content: finalContent.slice(0, 2000), allowed_mentions: { parse: [] } },
    });
  } catch { /* best effort, message may have been removed since */ }
}
