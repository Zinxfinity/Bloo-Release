// ============================================================
//  handlers/digestJob.js
//
//  Hourly job that checks whether any guild's digest is due
//  and posts it to their configured staff channel.
//
//  Started from events/client/ready.js via the dynamic startPoller
//  convention: startPoller(client, '../../handlers/digestJob.js', 'startDigestJob')
// ============================================================

import { runDigestJob } from './digestSystem.js';
import logger           from '../utils/logger.js';
import * as resilience  from './resilience.js';

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let started = false;

export function startDigestJob(client) {
  if (started) return;
  started = true;

  const tick = () => resilience.runLight('digestJob.tick', () => runDigestJob(client));

  // Check on the hour boundary
  const now      = Date.now();
  const nextHour = Math.ceil(now / INTERVAL_MS) * INTERVAL_MS;
  const delay    = nextHour - now;

  const timer = setTimeout(() => {
    tick();
    const interval = setInterval(tick, INTERVAL_MS);
    interval.unref?.();
  }, delay);
  timer.unref?.();

  logger.info(`[DIGEST] Digest job scheduled, next run in ${Math.round(delay / 60000)}min`);
}
