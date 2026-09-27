import db from '../db.js';
import logger from '../utils/logger.js';
import { fullTimestamp, humanizeGap } from '../utils/format.js';

// ─── Lifecycle state ──────────────────────────────────────────────────────────
// One row tracking the last boot/shutdown event, so the next boot can tell
// whether it's coming back from a real period of downtime (systemctl stop,
// server reboot, etc.) or just cycling through a quick restart (systemctl
// restart, a crash that systemd's Restart=always immediately relaunched).
// A short gap since the last recorded event means "restart"; a long gap, or
// no prior row at all, means "was actually down".
//
// watchdog.js (a separate process) also reads this table, so it can tell a
// graceful stop/restart apart from a real crash and skip posting its own
// duplicate public alert when this file already announced the transition.
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_lifecycle_state (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    last_event    TEXT    NOT NULL CHECK (last_event IN ('boot', 'shutdown')),
    last_event_at INTEGER NOT NULL
  )
`);

const RESTART_THRESHOLD_S = 180; // gaps shorter than this read as a restart, not real downtime

function getLifecycleState() {
  return db.prepare('SELECT last_event, last_event_at FROM bot_lifecycle_state WHERE id = 1').get() ?? null;
}

function setLifecycleState(event, atMs) {
  db.prepare(`
    INSERT INTO bot_lifecycle_state (id, last_event, last_event_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_event = excluded.last_event, last_event_at = excluded.last_event_at
  `).run(event, Math.floor(atMs / 1000));
}

async function postWebhook(embed) {
  const webhookUrl = process.env.STARTUP_WEBHOOK_URL;
  if (!webhookUrl) return;

  const payload = {
    username: 'Bloo Status',
    avatar_url: process.env.BLOO_PFP_URL ?? null,
    embeds: [embed],
  };

  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(5000),
    });
    if (!res.ok) logger.warn(`[LIFECYCLE] Webhook responded ${res.status}`);
    else logger.info(`[LIFECYCLE] ${embed.title}, alert sent.`);
  } catch (err) {
    logger.warn('[LIFECYCLE] Failed to send alert:', err.message);
  }
}

// ─── postStartupAlert ─────────────────────────────────────────────────────────
export async function postStartupAlert(client) {
  const now       = Date.now();
  const username  = client.user?.username ?? 'Bloo';
  const guildCount = client.guilds?.cache?.size ?? 0;

  const prev   = getLifecycleState();
  const gapS   = prev ? Math.max(0, Math.floor(now / 1000) - prev.last_event_at) : null;
  const isRestart = !!prev && (prev.last_event === 'boot' || gapS < RESTART_THRESHOLD_S);

  const title = isRestart
    ? `🔁 ${username} re-slimed back online after a restart!`
    : `🟢 ${username} has successfully slimed online!`;

  const footerText = prev
    ? `${fullTimestamp(now)} · last event was ${humanizeGap(gapS)} ago`
    : fullTimestamp(now);

  await postWebhook({
    title,
    description: `**Guilds:** ${guildCount}`,
    color: 0x4ade80,
    footer: { text: footerText },
    timestamp: new Date(now).toISOString(),
  });

  setLifecycleState('boot', now);
}

// ─── postShutdownAlert ────────────────────────────────────────────────────────
// Fired from index.js's SIGTERM/SIGINT handler, covers `systemctl stop`,
// `systemctl restart` (stop half of the cycle), and Ctrl+C during manual runs.
// Not fired on a hard crash (uncaught exception, OOM kill), since those never
// reach a signal handler. The next boot's `isRestart` check covers that case.
export async function postShutdownAlert(client) {
  const now        = Date.now();
  const username    = client?.user?.username ?? 'Bloo';
  const guildCount  = client?.guilds?.cache?.size ?? 0;

  const prev = getLifecycleState();
  const gapS = prev ? Math.max(0, Math.floor(now / 1000) - prev.last_event_at) : null;

  const footerText = prev
    ? `${fullTimestamp(now)} · was online for ${humanizeGap(gapS)}`
    : fullTimestamp(now);

  await postWebhook({
    title: `🔴 ${username} has gone offline`,
    description: `**Guilds:** ${guildCount}`,
    color: 0xef4444,
    footer: { text: footerText },
    timestamp: new Date(now).toISOString(),
  });

  setLifecycleState('shutdown', now);
}
