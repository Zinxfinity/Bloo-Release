// ─── Resilience, the shared circuit breaker ─────────────────────────────────
// One reusable wrapper for every place the bot calls into a handler: command
// execution, event-pipeline sub-calls, and background pollers. A single
// misbehaving handler should never take down the gateway connection or any
// other feature.
//
// Two tiers:
//   runCritical, for moderation/economy-grade handlers. Tracks consecutive
//                 failures per key and quarantines (short-circuits) that key
//                 once its threshold is reached, until released.
//   runLight   , for everything else. Catches and logs, no counter kept.
//
// recordSuccess/recordFailure are the primitives runCritical is built on —
// exposed directly for callers (like commandHandler.js) that need to fold an
// existing error-classification pipeline into the same shared quarantine
// store instead of routing execution itself through runCritical's fn wrapper.
//
// Keys are per-concern, not per-file (e.g. "antiRaid.detection" vs
// "antiRaid.captcha"), so a bug in one part of a handler doesn't quarantine
// unrelated logic that happens to live in the same module.

import logger from '../utils/logger.js';

const DEFAULT_THRESHOLD = 3;

/** @type {Map<string, { count: number, quarantined: boolean, error: string, stack: string, lockedAt: number|null }>} */
const state = new Map();

function entryFor(key) {
  let entry = state.get(key);
  if (!entry) {
    entry = { count: 0, quarantined: false, error: null, stack: null, lockedAt: null };
    state.set(key, entry);
  }
  return entry;
}

/**
 * Reset a key's failure count after a successful call. No-op if the key was
 * never seen before.
 *
 * @param {string} key
 */
export function recordSuccess(key) {
  const entry = state.get(key);
  if (!entry) return;
  entry.count = 0;
  entry.error = null;
  entry.stack = null;
}

/**
 * Record a failure for a key, quarantining it once `opts.threshold`
 * consecutive failures have been recorded (default 3).
 *
 * @param {string} key
 * @param {Error}  err
 * @param {object} [opts]
 * @param {number} [opts.threshold]
 * @param {(entry: object) => void} [opts.onQuarantine] called once when the threshold is crossed
 * @returns {{ quarantined: boolean }}
 */
export function recordFailure(key, err, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const entry = entryFor(key);

  entry.count += 1;
  entry.error = err?.message ?? String(err);
  entry.stack = err?.stack ?? '';

  logger.error(`[RESILIENCE] ${key} failed (${entry.count}/${threshold}):`, err);

  if (entry.count >= threshold && !entry.quarantined) {
    entry.quarantined = true;
    entry.lockedAt = Date.now();
    logger.error(`[RESILIENCE] ${key} quarantined after ${entry.count} consecutive failures.`);
    opts.onQuarantine?.(entry);
  }

  return { quarantined: entry.quarantined };
}

/**
 * Run a critical handler under the circuit breaker.
 *
 * @param {string}   key                 stable identifier, e.g. 'antiRaid.detection'
 * @param {Function} fn                  sync or async function to run
 * @param {object}   [opts]
 * @param {*}        [opts.fallback]     value returned when quarantined or on caught error
 * @param {number}   [opts.threshold]    consecutive failures before quarantine (default 3)
 * @param {(entry: object) => void} [opts.onQuarantine] called once when the threshold is crossed
 * @returns {Promise<*>}
 */
export async function runCritical(key, fn, opts = {}) {
  if (isQuarantined(key)) {
    return opts.fallback;
  }

  try {
    const result = await fn();
    recordSuccess(key);
    return result;
  } catch (err) {
    recordFailure(key, err, opts);
    return opts.fallback;
  }
}

/**
 * Run a non-critical handler: try/catch + log only, no counter, no quarantine.
 * Same call shape as runCritical so a handler's priority tier can be changed
 * later without touching the call site's surrounding code.
 *
 * @param {string}   key
 * @param {Function} fn
 * @param {object}   [opts]
 * @param {*}        [opts.fallback]
 * @returns {Promise<*>}
 */
export async function runLight(key, fn, opts = {}) {
  try {
    return await fn();
  } catch (err) {
    logger.error(`[RESILIENCE] ${key} failed:`, err);
    return opts.fallback;
  }
}

export function isQuarantined(key) {
  return state.get(key)?.quarantined ?? false;
}

export function releaseQuarantine(key) {
  const entry = state.get(key);
  if (!entry?.quarantined) return false;

  entry.quarantined = false;
  entry.count = 0;
  entry.error = null;
  entry.stack = null;
  entry.lockedAt = null;

  logger.info(`[RESILIENCE] Released ${key} from quarantine.`);
  return true;
}

export function listQuarantined() {
  return [...state.entries()]
    .filter(([, entry]) => entry.quarantined)
    .map(([key, entry]) => ({ key, ...entry }));
}
