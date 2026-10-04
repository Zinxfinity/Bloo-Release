// ============================================================
//  handlers/serverInsights.js
//
//  Why servers leave, learned without asking anyone. For the bot owner's
//  Developer → Server Insights page:
//    - when Bloo joined each server, and when it left, so we know how long
//      it stayed
//    - what that server had set up when it left (a short list of feature
//      names, never their contents)
//    - how many commands were used there in total
//    - bot-wide command counts per day (command names and counts only,
//      never who ran them or what they typed)
//    - b!feedback, which anyone can send if they want to
//
//  Retention: leave records 365 days, daily command counts 180 days,
//  feedback until a bot owner deletes it.
// ============================================================

import db from '../db.js';
import logger from '../utils/logger.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_presence (
    guild_id     TEXT PRIMARY KEY,
    name         TEXT,
    joined_at    INTEGER,           -- unix seconds; NULL until known
    joined_exact INTEGER NOT NULL DEFAULT 0,
    commands     INTEGER NOT NULL DEFAULT 0,
    last_command INTEGER
  );
  CREATE TABLE IF NOT EXISTS guild_leaves (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     TEXT NOT NULL,
    name         TEXT,
    members      INTEGER,
    joined_at    INTEGER,
    left_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    stayed_s     INTEGER,
    setup        TEXT NOT NULL DEFAULT '[]',
    commands     INTEGER NOT NULL DEFAULT 0,
    last_command INTEGER,
    welcomed     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_guild_leaves_left ON guild_leaves (left_at);
  CREATE TABLE IF NOT EXISTS command_usage_daily (
    day     TEXT NOT NULL,
    command TEXT NOT NULL,
    count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, command)
  );
  CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    username   TEXT NOT NULL,
    guild_id   TEXT,
    guild_name TEXT,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    seen       INTEGER NOT NULL DEFAULT 0
  );
`);

const q = {
  presence:  db.prepare(`SELECT * FROM guild_presence WHERE guild_id = ?`),
  joined:    db.prepare(`INSERT INTO guild_presence (guild_id, name, joined_at, joined_exact) VALUES (?, ?, unixepoch(), 1)
                         ON CONFLICT (guild_id) DO UPDATE SET name = excluded.name, joined_at = unixepoch(), joined_exact = 1, commands = 0, last_command = NULL`),
  known:     db.prepare(`INSERT OR IGNORE INTO guild_presence (guild_id, name) VALUES (?, ?)`),
  setJoined: db.prepare(`UPDATE guild_presence SET joined_at = ?, joined_exact = 1 WHERE guild_id = ?`),
  unknownJoins: db.prepare(`SELECT guild_id FROM guild_presence WHERE joined_at IS NULL`),
  bumpGuild: db.prepare(`UPDATE guild_presence SET commands = commands + ?, last_command = ? WHERE guild_id = ?`),
  bumpDay:   db.prepare(`INSERT INTO command_usage_daily (day, command, count) VALUES (?, ?, ?)
                         ON CONFLICT (day, command) DO UPDATE SET count = count + excluded.count`),
  leave:     db.prepare(`INSERT INTO guild_leaves (guild_id, name, members, joined_at, stayed_s, setup, commands, last_command, welcomed)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  forget:    db.prepare(`DELETE FROM guild_presence WHERE guild_id = ?`),
  addFb:     db.prepare(`INSERT INTO feedback (user_id, username, guild_id, guild_name, text) VALUES (?, ?, ?, ?, ?)`),
  recentFb:  db.prepare(`SELECT COUNT(*) n FROM feedback WHERE user_id = ? AND created_at > unixepoch() - 86400`),
};

// ── Joins ───────────────────────────────────────────────────────────────────
export function recordJoin(guildId, name) {
  q.joined.run(guildId, name ?? null);
}

// Servers Bloo was already in before this existed. Their real join date is
// on Bloo's own member record, fetched slowly in the background.
export async function backfillJoinDates(client) {
  for (const g of client.guilds.cache.values()) q.known.run(g.id, g.name ?? null);
  const missing = q.unknownJoins.all().map(r => r.guild_id);
  if (!missing.length) return;
  const botId = client.user?.id;
  if (!botId) return;
  logger.info(`[INSIGHTS] Looking up when Bloo joined ${missing.length} server(s), slowly.`);
  for (const id of missing) {
    try {
      const m = await client.rest.get(`/guilds/${id}/members/${botId}`);
      const at = m?.joined_at ? Math.floor(Date.parse(m.joined_at) / 1000) : null;
      if (at) q.setJoined.run(at, id);
    } catch { /* left already, or no access: stays unknown */ }
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ── Command counts (batched, written once a minute) ─────────────────────────
const pendingDay = new Map();   // command -> n
const pendingGuild = new Map(); // guildId -> n
export function recordCommand(guildId, command) {
  if (!command) return;
  pendingDay.set(command, (pendingDay.get(command) ?? 0) + 1);
  if (guildId) pendingGuild.set(guildId, (pendingGuild.get(guildId) ?? 0) + 1);
}

export function flushCommandCounts() {
  if (!pendingDay.size && !pendingGuild.size) return;
  const day = new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1000);
  const days = [...pendingDay], guilds = [...pendingGuild];
  pendingDay.clear(); pendingGuild.clear();
  db.transaction(() => {
    for (const [cmd, n] of days) q.bumpDay.run(day, cmd, n);
    for (const [g, n] of guilds) q.bumpGuild.run(n, now, g);
  })();
}

// ── Leaves ──────────────────────────────────────────────────────────────────
// Feature names only: whether each was set up, nothing about how.
const SETUP_CHECKS = [
  ['Mod log',        `SELECT 1 FROM guild_settings WHERE guild_id = ? AND modlog_channel_id IS NOT NULL AND modlog_channel_id != ''`],
  ['Verification',   `SELECT 1 FROM antiraid_config WHERE guild_id = ? AND (enabled = 1 OR captcha_enabled = 1)`],
  ['Welcome',        `SELECT 1 FROM welcome_config WHERE guild_id = ? AND (welcome_enabled = 1 OR goodbye_enabled = 1 OR autorole_enabled = 1)`],
  ['Automod',        `SELECT 1 FROM automod_config WHERE guild_id = ? AND enabled = 1`],
  ['Tickets',        `SELECT 1 FROM ticket_config WHERE guild_id = ? AND (channel_id IS NOT NULL OR panel_message_id IS NOT NULL)`],
  ['Level roles',    `SELECT 1 FROM xp_role_rewards WHERE guild_id = ? UNION SELECT 1 FROM xp_level_roles WHERE guild_id = ?`],
  ['Starboard',      `SELECT 1 FROM starboard_config WHERE guild_id = ? AND enabled = 1`],
  ['Reaction roles', `SELECT 1 FROM reaction_roles WHERE guild_id = ? UNION SELECT 1 FROM role_menus WHERE guild_id = ?`],
  ['Feeds',          `SELECT 1 FROM webhook_feeds WHERE guild_id = ?`],
  ['Tags',           `SELECT 1 FROM custom_commands WHERE guild_id = ?`],
  ['Giveaways',      `SELECT 1 FROM giveaways WHERE guild_id = ?`],
];

export function setupSnapshot(guildId) {
  const out = [];
  for (const [label, sql] of SETUP_CHECKS) {
    try {
      const args = Array(sql.split('?').length - 1).fill(guildId);
      if (db.prepare(sql).get(...args)) out.push(label);
    } catch { /* table or column not there in this build */ }
  }
  return out;
}

// Called from events/guild/guildDelete.js before any cleanup runs, so the
// snapshot still sees the server's settings.
export function recordLeave(guildId, name) {
  flushCommandCounts();
  const p = q.presence.get(guildId) ?? {};
  let members = null, welcomed = 0;
  try { members = db.prepare(`SELECT member_count FROM guild_member_counts WHERE guild_id = ?`).get(guildId)?.member_count ?? null; } catch { /* optional */ }
  try { welcomed = db.prepare(`SELECT delivered FROM guild_onboarding WHERE guild_id = ?`).get(guildId)?.delivered ?? 0; } catch { /* optional */ }
  const now = Math.floor(Date.now() / 1000);
  q.leave.run(
    guildId, name ?? p.name ?? null, members, p.joined_at ?? null,
    p.joined_at ? now - p.joined_at : null,
    JSON.stringify(setupSnapshot(guildId)), p.commands ?? 0, p.last_command ?? null, welcomed ? 1 : 0,
  );
  q.forget.run(guildId);
}

// ── Feedback ────────────────────────────────────────────────────────────────
export class FeedbackError extends Error {}
export async function addFeedback({ userId, username, guildId, guildName, text }) {
  const clean = String(text ?? '').trim();
  if (clean.length < 5) throw new FeedbackError('Write a little more, so it makes sense on its own.');
  if (clean.length > 1000) throw new FeedbackError('Keep it under 1000 characters.');
  if (q.recentFb.get(userId).n >= 5) throw new FeedbackError('You\'ve sent plenty today, thank you! Try again tomorrow.');
  const id = Number(q.addFb.run(userId, String(username).slice(0, 64), guildId ?? null, guildName ?? null, clean).lastInsertRowid);
  const hook = process.env.FEEDBACK_WEBHOOK_URL;
  if (hook) {
    fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Bloo Feedback',
        embeds: [{ color: 0x60a5fa, title: `📨 Feedback #${id}`, description: clean, footer: { text: `${username}${guildName ? ` · ${guildName}` : ''}` } }],
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
  }
  return id;
}

// ── Reading (dashboard) ─────────────────────────────────────────────────────
const STAY_BUCKETS = [
  ['Under an hour', 3600], ['Under a day', 86400], ['Under a week', 7 * 86400],
  ['Under a month', 30 * 86400], ['Under 6 months', 182 * 86400], ['Longer', Infinity],
];

export function insights(days = 90) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const leaves = db.prepare(`SELECT * FROM guild_leaves WHERE left_at >= ? ORDER BY left_at DESC`).all(since)
    .map(r => ({ ...r, setup: JSON.parse(r.setup || '[]') }));
  const joins = db.prepare(`SELECT COUNT(*) n FROM guild_presence WHERE joined_exact = 1 AND joined_at >= ?`).get(since).n;

  const stays = STAY_BUCKETS.map(([label]) => ({ label, n: 0 }));
  let unknownStay = 0;
  for (const l of leaves) {
    if (l.stayed_s == null) { unknownStay++; continue; }
    stays[STAY_BUCKETS.findIndex(([, max]) => l.stayed_s < max)].n++;
  }
  const setupCounts = {};
  for (const l of leaves) for (const s of l.setup) setupCounts[s] = (setupCounts[s] ?? 0) + 1;
  const sorted = leaves.map(l => l.stayed_s).filter(v => v != null).sort((a, b) => a - b);

  const sinceDay = new Date(since * 1000).toISOString().slice(0, 10);
  const commands = db.prepare(`SELECT command, SUM(count) n FROM command_usage_daily WHERE day >= ? GROUP BY command ORDER BY n DESC`).all(sinceDay);
  const perDay = db.prepare(`SELECT day, SUM(count) n FROM command_usage_daily WHERE day >= ? GROUP BY day ORDER BY day`).all(sinceDay);

  return {
    days,
    joins, leaves: leaves.length,
    medianStay: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    nothingSetUp: leaves.filter(l => !l.setup.length).length,
    neverUsed: leaves.filter(l => !l.commands).length,
    stays, unknownStay,
    setupCounts,
    recent: leaves.slice(0, 50),
    commands, perDay,
    servers: db.prepare(`SELECT COUNT(*) n FROM guild_presence`).get().n,
  };
}

export const listFeedback = (limit = 100) => db.prepare(`SELECT * FROM feedback ORDER BY id DESC LIMIT ?`).all(limit);
export const markFeedbackSeen = id => db.prepare(`UPDATE feedback SET seen = 1 WHERE id = ?`).run(Number(id)).changes > 0;
export const deleteFeedback = id => db.prepare(`DELETE FROM feedback WHERE id = ?`).run(Number(id)).changes > 0;

// ── Background job ──────────────────────────────────────────────────────────
let started = false;
export function startInsights(client) {
  if (started) return;
  started = true;
  setInterval(() => { try { flushCommandCounts(); } catch (e) { logger.warn(`[INSIGHTS] flush failed: ${e.message}`); } }, 60_000).unref?.();
  const prune = () => {
    try {
      db.prepare(`DELETE FROM guild_leaves WHERE left_at < unixepoch() - 365 * 86400`).run();
      db.prepare(`DELETE FROM command_usage_daily WHERE day < ?`).run(new Date(Date.now() - 180 * 86400_000).toISOString().slice(0, 10));
    } catch (e) { logger.warn(`[INSIGHTS] prune failed: ${e.message}`); }
  };
  prune();
  setInterval(prune, 24 * 3600_000).unref?.();
  backfillJoinDates(client).catch(e => logger.warn(`[INSIGHTS] join date lookup failed: ${e.message}`));
  // Synchronous, so it still runs when index.js's shutdown calls process.exit.
  process.once('exit', () => { try { flushCommandCounts(); } catch { /* shutting down */ } });
}
