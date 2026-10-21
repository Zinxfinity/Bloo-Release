// ============================================================
//  handlers/fluxerListReporter.js
//
//  Posts Bloo's live server count to FluxerList (fluxerlist.com) so the
//  public listing stays accurate instead of showing a stale number frozen
//  at whatever it was when the bot was last listed/updated by hand.
//
//  API: https://fluxerlist.com/api-docs
//    POST https://fluxerlist.com/api/bots/:id/stats
//    Header: Authorization: Bearer <FLUXERLIST_API_KEY>
//    Body:   { "serverCount": <non-negative integer> }
//
//  Note: the docs page lists "Base URL: https://fluxerlist.com/api/v1" but
//  the endpoint's own shown path already starts with /api/, stacking both
//  would double up to /api/v1/api/bots/..., which 404s. The real path is
//  the domain plus exactly what's shown for the endpoint, no extra /v1.
//
//  .env keys:
//    FLUXERLIST_API_KEY, bot owner/developer key, from FluxerList's dev settings
//    FLUXER_CLIENT_ID  , this bot's FluxerList ID doubles as its Fluxer
//                         client ID (same value already used for OAuth2),
//                         no separate FluxerList-specific ID needed
//
//  Started from events/client/ready.js via the dynamic startPoller
//  convention: startPoller(client, '../../handlers/fluxerListReporter.js', 'startFluxerListReporter', client)
// ============================================================

import logger from '../utils/logger.js';
import * as resilience from './resilience.js';

const POLL_MS = 30 * 60_000; // 30 minutes, matches typical bot-list update cadence
const BASE    = 'https://fluxerlist.com/api';

// FluxerList limits how many updates a key can send. Posting only when the
// count changed keeps well inside it, and a 429 pauses posting until the
// reset time it gives instead of failing (and logging) every 30 minutes.
let lastReported = null;
let pausedUntil  = 0;

async function postServerCount(client) {
  const apiKey = process.env.FLUXERLIST_API_KEY;
  const botId  = process.env.FLUXER_CLIENT_ID;
  if (!apiKey || !botId) return; // silently skip, not configured

  const serverCount = client?.guilds?.cache?.size ?? 0;
  if (Date.now() < pausedUntil || serverCount === lastReported) return;

  try {
    const res = await fetch(`${BASE}/bots/${botId}/stats`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ serverCount }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const retryS = Number(res.headers.get('retry-after'));
      const reset  = Number(body?.reset);
      // reset is a millisecond timestamp; fall back to Retry-After, then an hour.
      pausedUntil = reset > Date.now() ? reset : Date.now() + (retryS > 0 ? retryS * 1000 : 60 * 60_000);
      logger.warn(`[FLUXERLIST] Rate limited; pausing server count updates until ${new Date(pausedUntil).toISOString()}.`);
      return;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(`[FLUXERLIST] Stats update failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      return;
    }

    lastReported = serverCount;
    logger.info(`[FLUXERLIST] Reported server count: ${serverCount}`);
  } catch (err) {
    logger.warn(`[FLUXERLIST] Stats update failed: ${err.message}`);
  }
}

let started = false;

// See the matching guard in handlers/fluxerStatusMonitor.js, ready.js
// already boot-guards this from firing twice, this is defense-in-depth.
export function startFluxerListReporter(client) {
  if (started) return;
  if (!process.env.FLUXERLIST_API_KEY || !process.env.FLUXER_CLIENT_ID) {
    logger.info('[FLUXERLIST] FLUXERLIST_API_KEY/FLUXER_CLIENT_ID not set, stats reporting disabled');
    return;
  }
  started = true;

  resilience.runLight('fluxerListReporter.post', () => postServerCount(client)); // immediate first report
  const timer = setInterval(() => resilience.runLight('fluxerListReporter.post', () => postServerCount(client)), POLL_MS);
  timer.unref?.();
  logger.info(`[FLUXERLIST] Stats reporter started (every ${POLL_MS / 60_000}min)`);
}
