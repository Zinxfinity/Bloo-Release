import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import { getLastEventAgeS } from './gatewayActivity.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const HEARTBEAT     = join(__dirname, '..', 'data', 'heartbeat');
// systemd/watchdog-check.mjs, the watchdog service actually deployed —
// reads this exact path/format for its heartbeat-staleness and WS-silence
// checks. Root watchdog.js (this repo's own reference implementation) reads
// HEARTBEAT instead; keeping both in sync here means either watchdog works
// off the one process that's actually alive to report on itself.
const TMP_HEARTBEAT = '/tmp/bloo-heartbeat.json';
const INTERVAL_S = parseInt(process.env.WATCHDOG_HEARTBEAT_INTERVAL_S ?? '15', 10);

const startedAt = Date.now();
let _timer = null;

// ─── startHeartbeat ───────────────────────────────────────────────────────────
// Writes small JSON status files that watchdog processes poll to detect
// unresponsive processes, crash loops, and gateway disconnects, independent
// of this process's own ability to notice or report its own failure.
export function startHeartbeat(client, bootTimeS = null) {
  if (_timer) return;

  const tick = () => {
    let payload;
    try {
      const mem = process.memoryUsage();
      payload = {
        ts:         Date.now(),
        pid:        process.pid,
        startedAt,
        bootTimeS,
        ready:        client?.isReady?.() ?? false,
        guildCount:   client?.guilds?.cache?.size ?? 0,
        // client.commands is keyed by name AND every alias pointing at the
        // same command object, so .size overcounts. Dedupe by object
        // identity to get the real number of distinct commands.
        commandCount: client?.commands ? new Set(client.commands.values()).size : 0,
        heapUsed:     mem.heapUsed,
        rss:          mem.rss,
        // Seconds since the last gateway event (handlers/gatewayActivity.js,
        // bumped from messageCreate). A dead-but-still-"connected" WebSocket
        // leaves ready === true and the event loop spinning, so this is the
        // only signal that actually catches that failure mode.
        last_event_age: getLastEventAgeS(),
      };
    } catch (err) {
      logger.warn('[HEARTBEAT] Failed to build heartbeat payload:', err.message);
      return;
    }

    // Each target gets its own try/catch: these two files serve different
    // consumers (data/heartbeat backs dashboard/routes/status.js and this
    // repo's watchdog.js reference implementation; /tmp/bloo-heartbeat.json
    // is what systemd/watchdog-check.mjs, the watchdog actually deployed,
    // reads). Previously one shared try/catch meant a transient failure
    // writing either file (e.g. a permissions hiccup on just one of the two
    // directories) silently skipped the other write too, even though it
    // would have succeeded on its own, risking a false "stale heartbeat"
    // restart from the deployed watchdog over an unrelated problem.
    const json = JSON.stringify(payload);
    try {
      writeFileSync(HEARTBEAT, json);
    } catch (err) {
      logger.warn(`[HEARTBEAT] Failed to write ${HEARTBEAT}:`, err.message);
    }
    try {
      writeFileSync(TMP_HEARTBEAT, json);
    } catch (err) {
      logger.warn(`[HEARTBEAT] Failed to write ${TMP_HEARTBEAT}:`, err.message);
    }
  };

  tick(); // immediate first write
  _timer = setInterval(tick, INTERVAL_S * 1000);
  _timer.unref?.(); // don't keep process alive just for this

  logger.info(`[HEARTBEAT] Started (interval: ${INTERVAL_S}s)`);
}

export function stopHeartbeat() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
