// ============================================================
//  handlers/digestSystem.js
//
//  Moderation digest, posts a daily summary to a staff channel
//  showing: warnings issued, bans, kicks, mutes, tickets
//  opened/closed, and member change.
//
//  Server Owner opts in and configures a channel + UTC hour via
//  the dashboard (bloodash/dashboard/routes/analyticsAndDigest.js
//  owns the config UI/API, this file only reads/writes the same
//  table and runs the actual job).
//
//  Tables:
//    digest_config , per-guild configuration (dashboard creates
//                      the base table; this file adds last_posted)
//
//  Exported API:
//    getConfig(guildId)
//    setConfig(guildId, fields)
//    runDigestJob(client)  , called hourly by digestJob.js
// ============================================================

import db     from '../db.js';
import logger from '../utils/logger.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS digest_config (
    guild_id    TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 0,
    channel_id  TEXT,
    hour_utc    INTEGER NOT NULL DEFAULT 9
  );
`);
// The dashboard route creates the table above without this column, added
// here since only the job itself (not the dashboard) ever writes it.
try { db.exec(`ALTER TABLE digest_config ADD COLUMN last_posted TEXT`); } catch { /* already exists */ }

// ─── Config ───────────────────────────────────────────────────────────────────
export function getConfig(guildId) {
  return db.prepare('SELECT * FROM digest_config WHERE guild_id = ?').get(guildId) ?? null;
}

export function setConfig(guildId, fields = {}) {
  db.prepare(`
    INSERT INTO digest_config (guild_id) VALUES (?)
    ON CONFLICT(guild_id) DO NOTHING
  `).run(guildId);

  const allowed = ['enabled', 'channel_id', 'hour_utc'];
  const keys    = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;

  const setClauses = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE digest_config SET ${setClauses} WHERE guild_id = ?`)
    .run(...keys.map(k => fields[k]), guildId);
}

// ─── Digest builder ───────────────────────────────────────────────────────────
// NOTE on timestamp units: modlog_cases/warnings/ticket_cases store created_at/
// opened_at/closed_at as unixepoch() SECONDS, but analytics_joins/leaves store
// ts as Date.now() MILLISECONDS, these two families need different window
// bounds, they are not interchangeable in this codebase.
function buildDigest(guildId) {
  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const startS  = Math.floor(new Date(yesterday + 'T00:00:00Z').getTime() / 1000);
  const endS    = Math.floor(new Date(today     + 'T00:00:00Z').getTime() / 1000);
  const startMs = startS * 1000;
  const endMs   = endS   * 1000;

  // ── Mod log stats ─────────────────────────────────────────────────────────
  // Action strings written by ban/kick/mute/warn commands are mixed case and
  // descriptive ('Member Banned', 'Softban', 'Mass Ban', 'mute', 'kick',
  // 'tempban', 'unban', ...), so match with LOWER() rather than exact equality.
  let warns = 0, bans = 0, kicks = 0, mutes = 0, unbans = 0, unmutes = 0;
  try {
    // Older rows were stamped in milliseconds, so both units are matched.
    const modRows = db.prepare(`
      SELECT LOWER(action) AS action, COUNT(*) as count
      FROM modlog_cases
      WHERE guild_id = ? AND ((created_at >= ? AND created_at < ?) OR (created_at >= ? AND created_at < ?))
      GROUP BY LOWER(action)
    `).all(guildId, startS, endS, startMs, endMs);

    // Actions are stored by their canonical names (modLog.js normalizeAction):
    // ban, massban, tempban, softban, kick, mute, timeout, unban, unmute,
    // timeout-remove, plus free-text labels for non-moderation entries.
    for (const { action, count } of modRows) {
      if (action.includes('ban') && !action.includes('unban')) bans += count;
      else if (action.includes('unban')) unbans += count;
      else if (action.includes('kick')) kicks += count;
      else if (action === 'unmute' || action === 'timeout-remove' || action.includes('timeout removed')) unmutes += count;
      else if (action === 'mute' || action === 'timeout' || action.includes('timed out')) mutes += count;
    }
  } catch { /* modlog_cases may not exist yet */ }

  try {
    warns = db.prepare(`
      SELECT COUNT(*) as c FROM warnings
      WHERE guild_id = ? AND created_at >= ? AND created_at < ?
    `).get(guildId, startS, endS)?.c ?? 0;
  } catch { /* warnings table may not exist */ }

  // ── Ticket stats ──────────────────────────────────────────────────────────
  let ticketsOpened = 0, ticketsClosed = 0;
  try {
    ticketsOpened = db.prepare(`
      SELECT COUNT(*) as c FROM ticket_cases
      WHERE guild_id = ? AND opened_at >= ? AND opened_at < ?
    `).get(guildId, startS, endS)?.c ?? 0;

    ticketsClosed = db.prepare(`
      SELECT COUNT(*) as c FROM ticket_cases
      WHERE guild_id = ? AND closed_at >= ? AND closed_at < ?
    `).get(guildId, startS, endS)?.c ?? 0;
  } catch { /* tickets not configured */ }

  // ── Member change ─────────────────────────────────────────────────────────
  // Joins, leaves and activity only exist while the server has analytics on.
  let analytics = false;
  try { analytics = !!db.prepare('SELECT enabled FROM analytics_config WHERE guild_id = ?').get(guildId)?.enabled; } catch { /* no analytics table */ }
  let joins = 0, leaves = 0;
  try {
    joins  = db.prepare('SELECT COUNT(*) as c FROM analytics_joins  WHERE guild_id = ? AND ts >= ? AND ts < ?').get(guildId, startMs, endMs)?.c ?? 0;
    leaves = db.prepare('SELECT COUNT(*) as c FROM analytics_leaves WHERE guild_id = ? AND ts >= ? AND ts < ?').get(guildId, startMs, endMs)?.c ?? 0;
  } catch { /* analytics not enabled */ }

  // ── Active users ──────────────────────────────────────────────────────────
  let activeUsers = 0, messageCount = 0;
  try {
    const actRow = db.prepare(`
      SELECT COUNT(DISTINCT user_id) as au, SUM(msg_count) as mc
      FROM analytics_activity
      WHERE guild_id = ? AND date = ?
    `).get(guildId, yesterday);
    activeUsers  = actRow?.au ?? 0;
    messageCount = actRow?.mc ?? 0;
  } catch { /* analytics not enabled */ }

  return { yesterday, warns, bans, kicks, mutes, unbans, unmutes, ticketsOpened, ticketsClosed, analytics, joins, leaves, activeUsers, messageCount };
}

// ─── Embed builder ────────────────────────────────────────────────────────────
function buildEmbed(data) {
  const {
    yesterday, warns, bans, kicks, mutes, unbans, unmutes = 0,
    ticketsOpened, ticketsClosed,
    analytics = true, joins, leaves, activeUsers, messageCount,
  } = data;

  const net      = joins - leaves;
  const netStr   = net > 0 ? `+${net}` : String(net);
  const netColor = net > 0 ? 0x4ade80 : net < 0 ? 0xf87171 : 0x94a3b8;

  const modTotal = warns + bans + kicks + mutes + unbans + unmutes;
  const noAnalytics = '*Analytics is off. Turn it on in the dashboard to see this.*';

  return {
    color:       netColor,
    title:       `Daily Moderation Digest: ${yesterday}`,
    description: `Summary of server activity for **${yesterday}** (UTC). All figures are for the 24-hour window ending at midnight.`,
    fields: [
      {
        name:   'Members',
        value:  analytics ? [
          `Joined: **${joins}**`,
          `Left: **${leaves}**`,
          `Net: **${netStr}**`,
        ].join('\n') : noAnalytics,
        inline: true,
      },
      {
        name:   'Activity',
        value:  analytics ? [
          `Active users: **${activeUsers}**`,
          `Total messages: **${(messageCount ?? 0).toLocaleString()}**`,
        ].join('\n') : noAnalytics,
        inline: true,
      },
      { name: '​', value: '​', inline: true }, // spacer
      {
        name:   'Moderation',
        value:  modTotal === 0
          ? '*No mod actions taken.*'
          : [
              warns  > 0 ? `Warnings: **${warns}**`  : null,
              bans   > 0 ? `Bans: **${bans}**`   : null,
              kicks  > 0 ? `Kicks: **${kicks}**`  : null,
              mutes  > 0 ? `Timeouts: **${mutes}**`  : null,
              unmutes > 0 ? `Timeouts lifted: **${unmutes}**` : null,
              unbans > 0 ? `Unbans: **${unbans}**` : null,
            ].filter(Boolean).join('\n'),
        inline: true,
      },
      {
        name:   'Tickets',
        value:  ticketsOpened + ticketsClosed === 0
          ? '*No ticket activity.*'
          : [
              ticketsOpened > 0 ? `Opened: **${ticketsOpened}**` : null,
              ticketsClosed > 0 ? `Closed: **${ticketsClosed}**` : null,
            ].filter(Boolean).join('\n'),
        inline: true,
      },
    ],
    footer:    { text: 'Bloo · Moderation Digest · Configure via dashboard' },
    timestamp: new Date().toISOString(),
  };
}

// ─── Digest runner ────────────────────────────────────────────────────────────
export async function runDigestJob(client) {
  const hourNow = new Date().getUTCHours();
  const today   = new Date().toISOString().slice(0, 10);

  const guilds = db.prepare(`
    SELECT * FROM digest_config
    WHERE enabled = 1
      AND channel_id IS NOT NULL
      AND hour_utc = ?
      AND (last_posted IS NULL OR last_posted < ?)
  `).all(hourNow, today);

  for (const cfg of guilds) {
    try {
      const data  = buildDigest(cfg.guild_id);
      const embed = buildEmbed(data);

      // Raw REST, not client.channels.fetch() + channel.send(): confirmed
      // in production that pattern fails with "channel.send is not a
      // function" for at least one channel type on v2.0.1's SDK.
      await client.rest.post(`/channels/${cfg.channel_id}/messages`, { body: { embeds: [embed] } });

      db.prepare('UPDATE digest_config SET last_posted = ? WHERE guild_id = ?')
        .run(today, cfg.guild_id);

      logger.info(`[DIGEST] Posted daily digest for guild ${cfg.guild_id}`);
    } catch (err) {
      logger.warn(`[DIGEST] Digest failed for ${cfg.guild_id}: ${err.message}`);
    }
  }
}
