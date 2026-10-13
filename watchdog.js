// ============================================================
//  watchdog.js
//
//  Standalone process, run separately from the bot (e.g. its own
//  systemd unit / pm2 app / docker sidecar): `node watchdog.js`.
//
//  The bot process cannot reliably report its own death (that's the
//  whole problem an unhandled crash or frozen event loop creates), so
//  this reads the small heartbeat file the bot writes on an interval
//  (handlers/heartbeat.js) from the outside and alerts when it stops
//  updating, when the gateway connection looks unhealthy, or when the
//  bot is stuck in a restart loop.
//
//  Posts to two separate webhooks:
//    WATCHDOG_WEBHOOK_PUBLIC_URL, short, user-facing status message
//    WATCHDOG_WEBHOOK_URL       , detailed technical diagnostics, plus a
//                                  startup report every time the bot boots
//                                  (guild count, disk space, db size, node
//                                  version, nothing identifying like an IP
//                                  or a file path). Delayed a couple of
//                                  heartbeat cycles after boot so the guild
//                                  count reflects a settled read, not the
//                                  bot's very first pre-GUILD_CREATE write.
//
//  Alerts fire immediately on the first sign of trouble and on recovery.
//  Anything after that (flapping, a sustained outage) is capped to at most
//  one repeat alert per WATCHDOG_ALERT_COOLDOWN_S (default 1 hour), so a
//  prolonged incident can't spam either webhook.
//
//  The bot process itself also announces its own boot/shutdown to the same
//  public webhook (handlers/startupAlert.js), immediately and unconditionally,
//  since it's the fastest possible signal for a clean start or stop. That
//  system can't know when something is actually wrong though, a frozen or
//  killed process never gets the chance to self-report. To avoid the two
//  systems both posting for the same graceful event (a `systemctl stop`/
//  `restart` showing up here as "down" then "up" a few seconds later), this
//  reads the same bot_lifecycle_state table the bot writes to and skips its
//  own public post whenever the bot already announced that exact transition
//  itself. The private/technical webhook still gets a note either way, since
//  that's useful regardless of whether the public channel already knows.
// ============================================================

import 'dotenv/config';
import './config/envClean.js';
import { readFileSync, writeFileSync, existsSync, statSync, statfsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { fullTimestamp, humanizeGap, formatBytes } from './utils/format.js';

const __dirname     = dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_FILE = join(__dirname, 'data', 'heartbeat');
const STATE_FILE     = join(__dirname, 'data', 'watchdog-state.json');
const BOT_DB_FILE    = join(__dirname, 'data', 'bot.db');
// Touched by dashboard/routes/status.js's "Check Now" button. This process
// only ever polls its own interval, it has no live channel to be told
// anything, so a manual check request is just a file whose mtime this picks
// up on the next tick (worst case CHECK_INTERVAL_S later).
const FORCE_CHECK_FILE = join(__dirname, 'data', 'watchdog-force-check');

const CHECK_INTERVAL_S      = parseInt(process.env.WATCHDOG_CHECK_INTERVAL_S      ?? '15',  10);
const HEARTBEAT_INTERVAL_S  = parseInt(process.env.WATCHDOG_HEARTBEAT_INTERVAL_S  ?? '15',  10);
const HEARTBEAT_TIMEOUT_S   = parseInt(process.env.WATCHDOG_HEARTBEAT_TIMEOUT_S   ?? '90',  10);
const GATEWAY_INTERVAL_S    = parseInt(process.env.WATCHDOG_GATEWAY_INTERVAL_S    ?? '180', 10);
const GATEWAY_FAIL_THRESHOLD = parseInt(process.env.WATCHDOG_GATEWAY_FAIL_THRESHOLD ?? '3', 10);
const RESTART_LOOP_THRESHOLD = parseInt(process.env.WATCHDOG_RESTART_LOOP_THRESHOLD ?? '5', 10);
const RESTART_LOOP_WINDOW_S  = parseInt(process.env.WATCHDOG_RESTART_LOOP_WINDOW_S  ?? '300', 10);
const RESTART_BACKOFF_S      = parseInt(process.env.WATCHDOG_RESTART_BACKOFF_S      ?? '120', 10);
const WS_SILENCE_TIMEOUT_S   = parseInt(process.env.WATCHDOG_WS_SILENCE_TIMEOUT_S   ?? '60', 10);
const WS_SILENCE_GRACE_S     = parseInt(process.env.WATCHDOG_WS_SILENCE_GRACE_S     ?? '60', 10);
// Hard floor on repeat alerts while still unhealthy (flapping between bad
// states, or a sustained outage), the very first "just went down" alert and
// the "back up" recovery alert always fire immediately regardless of this.
const ALERT_COOLDOWN_S      = parseInt(process.env.WATCHDOG_ALERT_COOLDOWN_S      ?? '3600', 10);
// How recent a bot-reported boot/shutdown has to be to count as "that's what
// I'm seeing" and suppress our own public alert for the same transition.
// Matches startupAlert.js's own restart-detection window for consistency.
const GRACEFUL_WINDOW_S     = parseInt(process.env.WATCHDOG_GRACEFUL_WINDOW_S    ?? '180', 10);

// The bot's very first heartbeat write happens immediately on Ready, before
// any GUILD_CREATE events have arrived, so its guild count is always 0 at
// that instant regardless of how many guilds it's actually in. Waiting a
// couple of heartbeat cycles before reporting guarantees at least one fresh,
// settled write has happened by the time the startup report reads it.
const STARTUP_REPORT_GRACE_MS = HEARTBEAT_INTERVAL_S * 2 * 1000;

const WEBHOOK_PRIVATE = process.env.WATCHDOG_WEBHOOK_URL;
const WEBHOOK_PUBLIC  = process.env.WATCHDOG_WEBHOOK_PUBLIC_URL;
const WEBHOOK_NAME    = process.env.WATCHDOG_WEBHOOK_NAME ?? 'Bloo Watchdog';
const AVATAR_URL      = process.env.WATCHDOG_AVATAR_URL ?? null;

function log(...args) {
  console.log(`[${new Date().toISOString()}] [WATCHDOG]`, ...args);
}

// ─── State persistence ────────────────────────────────────────────────────────
// Survives watchdog restarts so it doesn't lose restart-loop history or
// re-alert on every boot.
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      status:            'unknown', // 'up' | 'degraded' | 'down' | 'crash-loop'
      notReadySince:      null,
      notReadyTimestamps: [],        // recent "not ready" check times, pruned to GATEWAY_INTERVAL_S
      lastAlertAt:        0,
      lastStartedAt:      null,
      restarts:           [],        // timestamps of observed process (re)starts
      loopBackoffUntil:   0,
      pendingStartupReportAt: null,  // set on a detected restart, fires once settled
    };
  }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state)); }
  catch (err) { log('Failed to write state file:', err.message); }
}

// ─── Manual "Check Now" request (dashboard) ───────────────────────────────────
// Returns true at most once per request, keyed on the file's mtime so a
// stale/already-handled request from a previous tick (or a previous
// watchdog process, state.lastForceCheckHandled survives restarts via
// STATE_FILE) doesn't keep re-triggering forever.
function consumeForceCheckRequest(state) {
  try {
    const mtimeMs = statSync(FORCE_CHECK_FILE).mtimeMs;
    if (mtimeMs > (state.lastForceCheckHandled ?? 0)) {
      state.lastForceCheckHandled = mtimeMs;
      return true;
    }
  } catch { /* no request file, nothing to do */ }
  return false;
}

// ─── Bot's own lifecycle state (handlers/startupAlert.js) ────────────────────
// Read-only, opened fresh each check so a missing file or an in-progress
// write from the bot process never blocks this process. Returns null if the
// bot has never booted yet (no bot.db) or the table doesn't exist.
function readBotLifecycleState() {
  try {
    const db  = new Database(BOT_DB_FILE, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT last_event, last_event_at FROM bot_lifecycle_state WHERE id = 1').get();
    db.close();
    return row ?? null;
  } catch {
    return null;
  }
}

// Did the bot itself already tell the public channel about this transition?
// `kind` is 'shutdown' when checking a "down" alert, 'boot' when checking "up".
function alreadySelfReported(kind, nowMs) {
  const lc = readBotLifecycleState();
  if (!lc || lc.last_event !== kind) return false;
  return (nowMs / 1000 - lc.last_event_at) <= GRACEFUL_WINDOW_S;
}

// ─── Webhook alerting ─────────────────────────────────────────────────────────
async function postWebhook(url, embed) {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username:   WEBHOOK_NAME,
        avatar_url: AVATAR_URL,
        embeds:     [embed],
      }),
    });
    if (!res.ok) log(`Webhook responded ${res.status}`);
  } catch (err) {
    log('Failed to post webhook:', err.message);
  }
}

const PUBLIC_MESSAGES = {
  down:        { title: '⚠️ Bloo is experiencing an outage',        color: 0xef4444, desc: 'We\'ve detected the bot is unresponsive and are working on it.' },
  degraded:    { title: '⚠️ Bloo is reconnecting',                  color: 0xf59e0b, desc: 'The bot process is up but having trouble staying connected. Some commands may be delayed.' },
  'crash-loop': { title: '⚠️ Bloo is experiencing instability',      color: 0xef4444, desc: 'The bot is restarting repeatedly. We\'re investigating.' },
  up:          { title: '✅ Bloo is back online',                    color: 0x4ade80, desc: 'Service has been restored.' },
};

async function alert(status, detail, { suppressPublic = false } = {}) {
  const pub = PUBLIC_MESSAGES[status];
  if (pub && !suppressPublic) {
    await postWebhook(WEBHOOK_PUBLIC, {
      title: pub.title,
      description: pub.desc,
      color: pub.color,
      timestamp: new Date().toISOString(),
    });
  }

  await postWebhook(WEBHOOK_PRIVATE, {
    title: suppressPublic
      ? `Watchdog: status → ${status} (public alert suppressed, bot self-reported)`
      : `Watchdog: status → ${status}`,
    description: detail,
    color: pub?.color ?? 0x94a3b8,
    timestamp: new Date().toISOString(),
  });
}

// ─── Startup diagnostic report ────────────────────────────────────────────────
// Fires once per detected bot (re)start, private webhook only. Deliberately
// excludes anything identifying about the host: no hostname, no IP, no
// absolute file paths, just aggregate numbers.
function readDiskUsage() {
  try {
    const stats = statfsSync(__dirname);
    const total = stats.blocks * stats.bsize;
    const free  = stats.bavail * stats.bsize;
    const used  = total - free;
    const pct   = total > 0 ? ((used / total) * 100).toFixed(1) : '0.0';
    return `${formatBytes(used)} used / ${formatBytes(free)} free / ${formatBytes(total)} total (${pct}%)`;
  } catch {
    return 'unavailable on this platform';
  }
}

function readDbSize() {
  try {
    return formatBytes(statSync(join(__dirname, 'data', 'bot.db')).size);
  } catch {
    return 'unavailable';
  }
}

async function postStartupReport(hb) {
  const now      = Date.now();
  const gapS     = Math.max(0, Math.round((now - hb.startedAt) / 1000));
  const bootTime = Number.isFinite(hb.bootTimeS) ? `${hb.bootTimeS.toFixed(1)}s` : 'unknown';

  await postWebhook(WEBHOOK_PRIVATE, {
    title: '🟢 Bloo started',
    description: 'New process detected via the heartbeat file.',
    color: 0x60a5fa,
    fields: [
      { name: '🏠 Servers',      value: String(hb.guildCount ?? 'unknown'),     inline: true },
      { name: '🧠 Heap',         value: formatBytes(hb.heapUsed),               inline: true },
      { name: '💾 RSS',          value: formatBytes(hb.rss),                    inline: true },
      { name: '🛠️ Node.js',      value: process.version,                        inline: true },
      { name: '⏱️ Boot time',    value: bootTime,                               inline: true },
      { name: '🆔 PID',          value: String(hb.pid),                         inline: true },
      { name: '🕐 Online since', value: fullTimestamp(hb.startedAt),            inline: false },
      { name: '🔁 Since',        value: `${humanizeGap(gapS)} ago`,             inline: true },
      { name: 'Gateway',        value: hb.ready ? 'ready' : 'connecting',       inline: true },
      { name: 'Platform',       value: `${process.platform}/${process.arch}`,  inline: true },
      { name: 'Database size',  value: readDbSize(),                           inline: true },
      { name: 'Disk space',     value: readDiskUsage(),                        inline: false },
    ],
    timestamp: new Date().toISOString(),
  });
}

// ─── Main check loop ──────────────────────────────────────────────────────────
function readHeartbeat() {
  if (!existsSync(HEARTBEAT_FILE)) return null;
  try {
    return JSON.parse(readFileSync(HEARTBEAT_FILE, 'utf8'));
  } catch {
    return null; // corrupt/partial write, treated the same as missing
  }
}

async function check(state) {
  const now    = Date.now();
  const hb     = readHeartbeat();
  const forced = consumeForceCheckRequest(state);

  // ── Restart-loop detection ──────────────────────────────────────────────
  if (hb?.startedAt && hb.startedAt !== state.lastStartedAt) {
    state.lastStartedAt = hb.startedAt;
    state.restarts.push(now);
    // Don't report immediately, the heartbeat snapshot from the exact
    // moment a restart is first noticed is often the bot's very first write,
    // taken before it's had a chance to populate its guild cache. Queue it
    // and report once a later, settled read is available instead. If another
    // restart happens before this one fires, it just replaces the pending one.
    state.pendingStartupReportAt = now;
  }
  state.restarts = state.restarts.filter(t => now - t <= RESTART_LOOP_WINDOW_S * 1000);
  const isCrashLooping = state.restarts.length > RESTART_LOOP_THRESHOLD;

  // Fire the queued startup report once enough time has passed for the
  // heartbeat's guild count to have settled. Uses this tick's own hb read,
  // not the stale one from the moment the restart was first noticed.
  if (state.pendingStartupReportAt && now - state.pendingStartupReportAt >= STARTUP_REPORT_GRACE_MS) {
    if (hb) await postStartupReport(hb);
    state.pendingStartupReportAt = null;
  }

  // ── Compute current health ──────────────────────────────────────────────
  // "degraded" (gateway down but process alive) requires BOTH enough elapsed
  // silence (WATCHDOG_WS_SILENCE_TIMEOUT_S + _GRACE_S) and enough not-ready
  // checks within the WATCHDOG_GATEWAY_INTERVAL_S window (WATCHDOG_GATEWAY_
  // FAIL_THRESHOLD), avoids flipping state on a single flaky read during a
  // brief reconnect.
  let computed;
  if (!hb) {
    computed = 'down'; // no heartbeat file at all, process never started or was wiped
    state.notReadyTimestamps = [];
  } else {
    const age = (now - hb.ts) / 1000;
    if (age > HEARTBEAT_TIMEOUT_S) {
      computed = 'down'; // heartbeat stopped updating, process frozen or dead
      state.notReadyTimestamps = [];
    } else if (!hb.ready) {
      state.notReadySince ??= now;
      state.notReadyTimestamps.push(now);
      state.notReadyTimestamps = state.notReadyTimestamps.filter(t => now - t <= GATEWAY_INTERVAL_S * 1000);
      const notReadyForS = (now - state.notReadySince) / 1000;
      const silenceExpired = notReadyForS > (WS_SILENCE_TIMEOUT_S + WS_SILENCE_GRACE_S);
      computed = (silenceExpired && state.notReadyTimestamps.length >= GATEWAY_FAIL_THRESHOLD) ? 'degraded' : 'up';
    } else {
      state.notReadySince = null;
      state.notReadyTimestamps = [];
      computed = 'up';
    }
  }

  if (isCrashLooping) computed = 'crash-loop';

  const detail = hb
    ? `Heartbeat age: ${((now - hb.ts) / 1000).toFixed(0)}s · ready: ${hb.ready} · guilds: ${hb.guildCount} · pid: ${hb.pid} · restarts in last ${RESTART_LOOP_WINDOW_S}s: ${state.restarts.length}`
    : 'No heartbeat file found.';

  const cooldownElapsed = now - state.lastAlertAt > ALERT_COOLDOWN_S * 1000;

  if (computed !== state.status) {
    // The very first check after the watchdog starts just establishes a
    // baseline, it hasn't actually observed a transition, so it shouldn't
    // announce a "recovery" for a bot that was never seen to be down.
    const isFirstCheck = state.status === 'unknown';

    // Otherwise: the first alert of a new incident (healthy -> unhealthy) and
    // the recovery alert (-> up) always fire immediately, uncapped, those
    // are the two signals that actually matter in the moment. Everything
    // else (flapping between bad states, re-alerting after a crash-loop
    // backoff) respects the hourly cooldown like a sustained-outage reminder would.
    const isNewIncident = state.status === 'up' && computed !== 'up';
    const isRecovery     = computed === 'up' && state.status !== 'up';
    const loopCoolingDown = state.status === 'crash-loop' && now < state.loopBackoffUntil;

    if (isFirstCheck) {
      log(`Baseline established: ${computed} (${detail})`);
    } else if (loopCoolingDown) {
      // still cooling down from a crash-loop alert, skip re-alerting immediately
    } else if (isNewIncident || isRecovery || cooldownElapsed) {
      // A graceful `systemctl stop`/`restart` shows up here as a normal
      // down → up transition too. Check whether the bot itself already
      // told the public channel about this exact transition before we do.
      const suppressPublic =
        (computed === 'down' && alreadySelfReported('shutdown', now)) ||
        (computed === 'up'   && alreadySelfReported('boot', now));

      log(`Status change: ${state.status} → ${computed} (${detail})${suppressPublic ? ' [public suppressed, self-reported]' : ''}`);
      await alert(computed, detail, { suppressPublic });
      state.lastAlertAt = now;
      if (computed === 'crash-loop') state.loopBackoffUntil = now + RESTART_BACKOFF_S * 1000;
    }
    state.status = computed;
  } else if (computed !== 'up' && cooldownElapsed) {
    // Same unhealthy status persisting, at most one reminder per
    // WATCHDOG_ALERT_COOLDOWN_S, private webhook only, so an ongoing outage
    // doesn't go completely silent but also can't spam either webhook.
    log(`Still ${computed} (${detail})`);
    await postWebhook(WEBHOOK_PRIVATE, {
      title: `Watchdog: still ${computed}`,
      description: detail,
      color: 0xf59e0b,
      timestamp: new Date().toISOString(),
    });
    state.lastAlertAt = now;
  }

  // Manual "Check Now" from the dashboard, independent of the transition
  // logic above, always posts regardless of whether anything changed and
  // regardless of the cooldown, that's the whole point of asking for one.
  if (forced) {
    log(`Manual check requested, posting current status (${computed}).`);
    await postWebhook(WEBHOOK_PRIVATE, {
      title: `Watchdog: manual check → ${computed}`,
      description: detail,
      color: PUBLIC_MESSAGES[computed]?.color ?? 0x94a3b8,
      timestamp: new Date().toISOString(),
    });
    state.lastAlertAt = now;
  }

  return state;
}

async function main() {
  if (!WEBHOOK_PRIVATE && !WEBHOOK_PUBLIC) {
    log('Neither WATCHDOG_WEBHOOK_URL nor WATCHDOG_WEBHOOK_PUBLIC_URL is set, running in log-only mode.');
  }

  let state = loadState();
  log(`Started (check interval: ${CHECK_INTERVAL_S}s, heartbeat timeout: ${HEARTBEAT_TIMEOUT_S}s).`);

  const tick = async () => {
    state = await check(state);
    saveState(state);
  };

  await tick();
  setInterval(tick, CHECK_INTERVAL_S * 1000);
}

main();
