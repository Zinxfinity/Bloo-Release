// ============================================================
//  handlers/fluxerStatusMonitor.js
//
//  Polls https://fluxerstatus.com/v3/summary.json every 90s.
//  On new incident: posts an alert to FLUXER_STATUS_WEBHOOK_URL.
//  On incident resolved: posts a recovery message.
//
//  DB table: fluxer_status_incidents, same shape both dashboards
//  (bloodash/dashboard/routes/fluxerStatus.js, dashboard/server.js)
//  already create and read from.
//  .env key: FLUXER_STATUS_WEBHOOK_URL, read live at send time, since
//  the dashboard's config endpoint mutates it (and rewrites .env) at runtime.
//
//  Started from events/client/ready.js via the dynamic startPoller
//  convention: startPoller(client, '../../handlers/fluxerStatusMonitor.js', 'startFluxerStatusMonitor')
// ============================================================

import db     from '../db.js';
import logger from '../utils/logger.js';
import * as resilience from './resilience.js';

const POLL_MS = 90_000; // 90 seconds
const SUMMARY = 'https://fluxerstatus.com/v3/summary.json';

const STATUS_COLORS = {
  MAJOROUTAGE:      0xED4245, // red
  PARTIALOUTAGE:    0xFBBF24, // yellow
  DEGRADED:         0xFBBF24,
  UNDERMAINTENANCE: 0x60A5FA, // blue
  OPERATIONAL:      0x57F287, // green
  INVESTIGATING:    0xED4245,
  IDENTIFIED:       0xFBBF24,
  MONITORING:       0x60A5FA,
  RESOLVED:         0x57F287,
};
const STATUS_EMOJI = {
  MAJOROUTAGE:      '🔴',
  PARTIALOUTAGE:    '🟡',
  DEGRADED:         '🟡',
  UNDERMAINTENANCE: '🔵',
  OPERATIONAL:      '🟢',
  INVESTIGATING:    '🔴',
  IDENTIFIED:       '🟡',
  MONITORING:       '🔵',
  RESOLVED:         '🟢',
};

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS fluxer_status_incidents (
    id           TEXT    PRIMARY KEY,
    name         TEXT    NOT NULL,
    impact       TEXT,
    started      TEXT,
    status       TEXT    NOT NULL DEFAULT 'INVESTIGATING',
    resolved_at  TEXT,
    url          TEXT,
    posted_at    INTEGER NOT NULL,
    resolved     INTEGER NOT NULL DEFAULT 0
  )`);
}

async function postWebhook(embed) {
  const url = process.env.FLUXER_STATUS_WEBHOOK_URL;
  if (!url) return;
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username:   'Fluxer Status',
        avatar_url: 'https://fluxerstatus.com/favicon.ico',
        embeds: [{ timestamp: new Date().toISOString(), ...embed }],
      }),
    });
    if (!r.ok) logger.warn(`[STATUS] Webhook ${r.status}`);
  } catch (err) {
    logger.warn(`[STATUS] Webhook POST failed: ${err.message}`);
  }
}

async function tick() {
  try {
    ensureTable();
    const r = await fetch(SUMMARY, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return;
    const summary = await r.json();

    const activeIds   = new Set((summary.activeIncidents    ?? []).map(i => i.id));
    const activeMaint = new Set((summary.activeMaintenances ?? []).map(i => i.id));

    // ── Check for NEW incidents ─────────────────────────────────────────────
    for (const inc of (summary.activeIncidents ?? [])) {
      const existing = db.prepare('SELECT id, status FROM fluxer_status_incidents WHERE id = ?').get(inc.id);
      if (!existing) {
        db.prepare(`
          INSERT INTO fluxer_status_incidents (id, name, impact, started, status, url, posted_at, resolved)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        `).run(inc.id, inc.name, inc.impact ?? null, inc.started ?? null, inc.status, inc.url ?? null, Date.now());

        const emoji = STATUS_EMOJI[inc.impact] ?? STATUS_EMOJI[inc.status] ?? '🔴';
        const color = STATUS_COLORS[inc.impact] ?? STATUS_COLORS[inc.status] ?? 0xED4245;
        await postWebhook({
          title:       `${emoji} Fluxer Incident: ${inc.name}`,
          description: `**Status:** ${inc.status}\n**Impact:** ${inc.impact ?? 'Unknown'}\n**Started:** <t:${Math.floor(new Date(inc.started ?? Date.now()).getTime() / 1000)}:R>`,
          color,
          url:         inc.url ?? undefined,
          footer:      { text: 'Fluxer Status Monitor' },
        });
        logger.info(`[STATUS] New incident: ${inc.id}, ${inc.name}`);
      } else if (existing.status !== inc.status) {
        db.prepare('UPDATE fluxer_status_incidents SET status = ? WHERE id = ?').run(inc.status, inc.id);
        const emoji = STATUS_EMOJI[inc.status] ?? '🟡';
        const color = STATUS_COLORS[inc.status] ?? 0xFBBF24;
        await postWebhook({
          title:       `${emoji} Fluxer Incident Update: ${inc.name}`,
          description: `**New Status:** ${inc.status}\n**Impact:** ${inc.impact ?? 'Unknown'}`,
          color,
          url:         inc.url ?? undefined,
          footer:      { text: 'Fluxer Status Monitor' },
        });
      }
    }

    // ── Check for NEW maintenances ──────────────────────────────────────────
    for (const maint of (summary.activeMaintenances ?? [])) {
      const existing = db.prepare('SELECT id FROM fluxer_status_incidents WHERE id = ?').get(maint.id);
      if (!existing) {
        db.prepare(`
          INSERT INTO fluxer_status_incidents (id, name, impact, started, status, url, posted_at, resolved)
          VALUES (?, ?, 'MAINTENANCE', ?, ?, ?, ?, 0)
        `).run(maint.id, maint.name, maint.start ?? null, maint.status, maint.url ?? null, Date.now());

        await postWebhook({
          title:       `🔵 Fluxer Maintenance: ${maint.name}`,
          description: `**Status:** ${maint.status}\n**Starts:** <t:${Math.floor(new Date(maint.start ?? Date.now()).getTime() / 1000)}:F>\n**Duration:** ${maint.duration ? `${maint.duration} min` : 'Unknown'}`,
          color:       0x60A5FA,
          url:         maint.url ?? undefined,
          footer:      { text: 'Fluxer Status Monitor' },
        });
        logger.info(`[STATUS] New maintenance: ${maint.id}, ${maint.name}`);
      }
    }

    // ── Check for resolved incidents ────────────────────────────────────────
    const knownUnresolved = db.prepare(
      'SELECT id, name FROM fluxer_status_incidents WHERE resolved = 0'
    ).all();

    for (const known of knownUnresolved) {
      if (!activeIds.has(known.id) && !activeMaint.has(known.id)) {
        const now = new Date().toISOString();
        db.prepare(
          'UPDATE fluxer_status_incidents SET resolved = 1, resolved_at = ?, status = ? WHERE id = ?'
        ).run(now, 'RESOLVED', known.id);
        await postWebhook({
          title:       `✅ Fluxer Incident Resolved: ${known.name}`,
          description: `This incident has been marked as resolved.\n**Resolved:** <t:${Math.floor(Date.now() / 1000)}:R>`,
          color:       0x57F287,
          footer:      { text: 'Fluxer Status Monitor' },
        });
        logger.info(`[STATUS] Resolved: ${known.id}, ${known.name}`);
      }
    }
  } catch (err) {
    logger.warn(`[STATUS] Poll failed: ${err.message}`);
  }
}

let started = false;

// events/client/ready.js already boot-guards its poller-start block behind
// a top-level `_booted` flag before this is ever reached, so this can't
// currently double-fire from a reconnect. Kept as a defense-in-depth guard
// against a new call site being added later without going through that
// same boot-guarded block.
export function startFluxerStatusMonitor() {
  if (started) return;
  started = true;

  if (!process.env.FLUXER_STATUS_WEBHOOK_URL) {
    logger.info('[STATUS] FLUXER_STATUS_WEBHOOK_URL not set, monitor running in silent mode (dashboard still works)');
  }
  resilience.runLight('fluxerStatusMonitor.tick', tick); // immediate first check
  const timer = setInterval(() => resilience.runLight('fluxerStatusMonitor.tick', tick), POLL_MS);
  timer.unref?.();
  logger.info('[STATUS] Fluxer status monitor started');
}
