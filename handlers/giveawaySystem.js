import db from '../db.js';
import logger from '../utils/logger.js';
import * as resilience from './resilience.js';
import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../config/embeds.js';

// An older release tracked completion with a plain `ended` boolean instead
// of the current `status` enum (scheduled/live/ended/cancelled). CREATE
// TABLE IF NOT EXISTS never touches the live table since it predates this
// file, so every query below and in commands/general/giveaway.js /
// dashboard/routes/giveaways.js that reads `status` throws "no such column:
// status" against it, giveaways.js's own gaRow() already derives `ended`
// from `status` defensively, but nothing derived `status` from `ended`.
// `ended` is left in place (not dropped), the dashboard still reads/writes
// it directly in its pause/resume/end-early routes.
{
  let cols = [];
  try { cols = db.prepare(`PRAGMA table_info(giveaways)`).all(); } catch { /* no table yet */ }
  const names = cols.map(c => c.name);
  if (names.includes('ended') && !names.includes('status')) {
    db.exec(`ALTER TABLE giveaways ADD COLUMN status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('scheduled','live','ended','cancelled'))`);
    const now = Math.floor(Date.now() / 1000);
    db.exec(`UPDATE giveaways SET status = 'ended' WHERE ended = 1`);
    db.exec(`UPDATE giveaways SET status = 'scheduled' WHERE ended = 0 AND starts_at IS NOT NULL AND starts_at > ${now}`);
    logger.warn(`[GIVEAWAY] Backfilled status from the legacy ended column.`);
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS giveaways (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id           TEXT    NOT NULL,
    channel_id         TEXT    NOT NULL,
    message_id         TEXT,
    host_id            TEXT    NOT NULL,
    prize              TEXT    NOT NULL,
    winner_count       INTEGER NOT NULL DEFAULT 1,
    ends_at            INTEGER NOT NULL,
    starts_at          INTEGER,
    status             TEXT    NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('scheduled','live','ended','cancelled')),
    required_role_id   TEXT,
    min_level          INTEGER NOT NULL DEFAULT 0,
    claim_window_s     INTEGER NOT NULL DEFAULT 0,
    repeat_interval_ms INTEGER,
    repeat_count       INTEGER NOT NULL DEFAULT 0,
    repeat_max         INTEGER NOT NULL DEFAULT 0,
    repeat_from_id     INTEGER,
    reminder_sent      INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS giveaway_entries (
    giveaway_id INTEGER NOT NULL,
    user_id     TEXT    NOT NULL,
    bonus       INTEGER NOT NULL DEFAULT 0,
    entered_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (giveaway_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS giveaway_winners (
    giveaway_id INTEGER NOT NULL,
    user_id     TEXT    NOT NULL,
    claimed     INTEGER NOT NULL DEFAULT 0,
    claimed_at  INTEGER,
    PRIMARY KEY (giveaway_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS giveaway_blacklist (
    giveaway_id INTEGER NOT NULL,
    user_id     TEXT    NOT NULL,
    PRIMARY KEY (giveaway_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS giveaway_bonus (
    giveaway_id    INTEGER NOT NULL,
    role_id        TEXT    NOT NULL,
    bonus_entries  INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (giveaway_id, role_id)
  );
`);

// Migrations, run before ANY db.prepare() call
for (const col of [
  `ALTER TABLE giveaways ADD COLUMN message_id TEXT`,
  `ALTER TABLE giveaways ADD COLUMN starts_at INTEGER`,
  `ALTER TABLE giveaways ADD COLUMN required_role_id TEXT`,
  `ALTER TABLE giveaways ADD COLUMN min_level INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE giveaways ADD COLUMN claim_window_s INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE giveaways ADD COLUMN repeat_interval_ms INTEGER`,
  `ALTER TABLE giveaways ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE giveaways ADD COLUMN repeat_max INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE giveaways ADD COLUMN repeat_from_id INTEGER`,
  `ALTER TABLE giveaways ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0`,
  // Dashboard-extended fields, stored by dashboard, ignored by bot logic
  `ALTER TABLE giveaways ADD COLUMN description TEXT`,
  `ALTER TABLE giveaways ADD COLUMN min_days INTEGER`,
  `ALTER TABLE giveaways ADD COLUMN dm_winners INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE giveaways ADD COLUMN bonus_roles TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE giveaways ADD COLUMN max_entries INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE giveaways ADD COLUMN entry_cooldown_s INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE giveaways ADD COLUMN winner_exclusion_days INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE giveaways ADD COLUMN hide_entries INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE giveaways ADD COLUMN ping_role_id TEXT`,
  `ALTER TABLE giveaways ADD COLUMN reminder_mins TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE giveaways ADD COLUMN draft INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE giveaways ADD COLUMN reroll_log TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE giveaways ADD COLUMN entries TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE giveaways ADD COLUMN winners TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE giveaways ADD COLUMN blacklist TEXT NOT NULL DEFAULT '[]'`,
  // Pausing: paused stops entries and holds the end; paused_at lets resume
  // push the end back by however long it was paused.
  `ALTER TABLE giveaways ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE giveaways ADD COLUMN paused_at INTEGER`,
  `ALTER TABLE giveaways ADD COLUMN extend_count INTEGER NOT NULL DEFAULT 0`,
]) {
  try { db.exec(col); } catch { /* already exists */ }
}

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  create: db.prepare(`
    INSERT INTO giveaways
      (guild_id, channel_id, host_id, prize, winner_count, ends_at, starts_at,
       required_role_id, min_level, claim_window_s, repeat_interval_ms, repeat_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  get:       db.prepare(`SELECT * FROM giveaways WHERE id = ?`),
  getByMsg:  db.prepare(`SELECT * FROM giveaways WHERE message_id = ?`),
  update:    db.prepare(`UPDATE giveaways SET status=?, message_id=? WHERE id=?`),
  setStatus: db.prepare(`UPDATE giveaways SET status = ? WHERE id = ?`),
  setMsg:    db.prepare(`UPDATE giveaways SET message_id = ? WHERE id = ?`),
  setReminder: db.prepare(`UPDATE giveaways SET reminder_sent = 1 WHERE id = ?`),
  listGuild: db.prepare(`SELECT * FROM giveaways WHERE guild_id = ? ORDER BY ends_at DESC LIMIT 20`),
  liveList:  db.prepare(`SELECT * FROM giveaways WHERE status = 'live' AND guild_id = ?`),

  scheduled: db.prepare(`
    SELECT * FROM giveaways WHERE status = 'scheduled' AND starts_at <= unixepoch()
  `),
  expired: db.prepare(`
    SELECT * FROM giveaways WHERE status = 'live' AND ends_at <= unixepoch() AND COALESCE(paused, 0) = 0
  `),
  needsReminder: db.prepare(`
    SELECT * FROM giveaways WHERE status = 'live' AND reminder_sent = 0 AND COALESCE(paused, 0) = 0
    AND ends_at <= unixepoch() + 300 AND ends_at > unixepoch()
  `),

  addEntry:    db.prepare(`INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)`),
  removeEntry: db.prepare(`DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?`),
  getEntries:  db.prepare(`SELECT user_id, bonus FROM giveaway_entries WHERE giveaway_id = ?`),
  entryCount:  db.prepare(`SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?`),
  isEntered:   db.prepare(`SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?`),

  addWinner:   db.prepare(`INSERT OR IGNORE INTO giveaway_winners (giveaway_id, user_id) VALUES (?, ?)`),
  getWinners:  db.prepare(`SELECT user_id, claimed FROM giveaway_winners WHERE giveaway_id = ?`),
  clearWinners: db.prepare(`DELETE FROM giveaway_winners WHERE giveaway_id = ?`),
  markClaimed:  db.prepare(`UPDATE giveaway_winners SET claimed=1, claimed_at=unixepoch() WHERE giveaway_id=? AND user_id=?`),

  isBlacklisted: db.prepare(`SELECT 1 FROM giveaway_blacklist WHERE giveaway_id = ? AND user_id = ?`),
  addBlacklist:  db.prepare(`INSERT OR IGNORE INTO giveaway_blacklist VALUES (?, ?)`),
  removeBlacklist: db.prepare(`DELETE FROM giveaway_blacklist WHERE giveaway_id = ? AND user_id = ?`),

  getBonusRoles: db.prepare(`SELECT role_id, bonus_entries FROM giveaway_bonus WHERE giveaway_id = ?`),
  setBonusRole:  db.prepare(`INSERT OR REPLACE INTO giveaway_bonus (giveaway_id, role_id, bonus_entries) VALUES (?, ?, ?)`),
};

// ─── Create giveaway ──────────────────────────────────────────────────────────
export function createGiveaway(opts) {
  const {
    guildId, channelId, hostId, prize, winnerCount = 1,
    endsAt, startsAt = null, requiredRoleId = null,
    minLevel = 0, claimWindowS = 0, repeatIntervalMs = null, repeatMax = 0,
  } = opts;

  const status = startsAt && startsAt > Math.floor(Date.now() / 1000) ? 'scheduled' : 'live';
  const result = stmts.create.run(
    guildId, channelId, hostId, prize, winnerCount,
    endsAt, startsAt, requiredRoleId, minLevel,
    claimWindowS, repeatIntervalMs, repeatMax,
  );
  const id = result.lastInsertRowid;
  if (status === 'live') stmts.setStatus.run('live', id);
  return id;
}

export function getGiveaway(id) {
  return stmts.get.get(id) ?? null;
}

export function getGiveawayByMessage(messageId) {
  return stmts.getByMsg.get(messageId) ?? null;
}

export function listGiveaways(guildId) {
  return stmts.listGuild.all(guildId);
}

// ─── Entry management ─────────────────────────────────────────────────────────
export function enterGiveaway(giveawayId, userId) {
  stmts.addEntry.run(giveawayId, userId);
}

export function leaveGiveaway(giveawayId, userId) {
  stmts.removeEntry.run(giveawayId, userId);
}

export function isEntered(giveawayId, userId) {
  return !!stmts.isEntered.get(giveawayId, userId);
}

export function getEntryCount(giveawayId) {
  return stmts.entryCount.get(giveawayId)?.n ?? 0;
}

// ─── Draw winners ─────────────────────────────────────────────────────────────
function drawWinners(giveawayId, count) {
  const entries = stmts.getEntries.all(giveawayId);
  if (!entries.length) return [];

  // Build weighted pool
  const pool = [];
  for (const e of entries) {
    const tickets = 1 + (e.bonus ?? 0);
    for (let i = 0; i < tickets; i++) pool.push(e.user_id);
  }

  // Shuffle and pick unique winners
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const winners = [];
  const seen    = new Set();
  for (const uid of pool) {
    if (!seen.has(uid)) { seen.add(uid); winners.push(uid); }
    if (winners.length >= count) break;
  }
  return winners;
}

// ─── End giveaway ─────────────────────────────────────────────────────────────
export async function endGiveaway(client, giveawayId) {
  const gw = getGiveaway(giveawayId);
  if (!gw || gw.status === 'ended' || gw.status === 'cancelled') return null;

  stmts.setStatus.run('ended', giveawayId);

  const winners = drawWinners(giveawayId, gw.winner_count);
  stmts.clearWinners.run(giveawayId);
  for (const uid of winners) stmts.addWinner.run(giveawayId, uid);

  const entryCount = getEntryCount(giveawayId);
  const winnerMentions = winners.length
    ? winners.map(u => `<@${u}>`).join(', ')
    : 'No valid entries.';

  // Update the original embed
  await updateGiveawayEmbed(client, gw, winners, entryCount);

  // Post result message. Raw REST, not client.channels.fetch() +
  // channel.send(): confirmed in production that pattern fails with
  // "channel.send is not a function" for at least one channel type.
  try {
    await client.rest.post(`/channels/${gw.channel_id}/messages`, {
      body: {
        content: winners.length
          ? `🎉 Congratulations ${winnerMentions}! You won **${gw.prize}**!`
          : `😔 No valid entries for **${gw.prize}**.`,
      },
    });
  } catch { /* non-fatal */ }

  // Schedule repeat if configured
  if (gw.repeat_interval_ms && (gw.repeat_max === 0 || gw.repeat_count < gw.repeat_max)) {
    const newEndsAt = Math.floor(Date.now() / 1000) + Math.floor(gw.repeat_interval_ms / 1000);
    db.prepare(`
      INSERT INTO giveaways
        (guild_id, channel_id, host_id, prize, winner_count, ends_at, status,
         required_role_id, min_level, claim_window_s, repeat_interval_ms, repeat_max,
         repeat_count, repeat_from_id)
      VALUES (?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      gw.guild_id, gw.channel_id, gw.host_id, gw.prize, gw.winner_count,
      newEndsAt, gw.required_role_id, gw.min_level, gw.claim_window_s,
      gw.repeat_interval_ms, gw.repeat_max,
      gw.repeat_count + 1, gw.repeat_from_id ?? giveawayId,
    );
  }

  return winners;
}

// ─── Reroll ───────────────────────────────────────────────────────────────────
export async function rerollGiveaway(client, giveawayId) {
  const gw = getGiveaway(giveawayId);
  if (!gw || gw.status !== 'ended') return null;

  const winners = drawWinners(giveawayId, gw.winner_count);
  stmts.clearWinners.run(giveawayId);
  for (const uid of winners) stmts.addWinner.run(giveawayId, uid);

  try {
    if (winners.length) {
      await client.rest.post(`/channels/${gw.channel_id}/messages`, {
        body: { content: `🔁 Reroll! New winner(s): ${winners.map(u => `<@${u}>`).join(', ')} for **${gw.prize}**!` },
      });
    }
  } catch { /* non-fatal */ }

  return winners;
}

// ─── Embed helpers ────────────────────────────────────────────────────────────
export async function postGiveawayEmbed(client, giveawayId) {
  const gw = getGiveaway(giveawayId);
  if (!gw) return null;

  const embed = buildGiveawayEmbed(gw, 0);

  try {
    const msg = await client.rest.post(`/channels/${gw.channel_id}/messages`, {
      body: {
        content: '🎉 **GIVEAWAY** 🎉',
        embeds:  [embed.toJSON()],
      },
    });
    stmts.setMsg.run(msg.id, giveawayId);

    // Add entry reaction
    await client.rest.put(
      `/channels/${gw.channel_id}/messages/${msg.id}/reactions/${encodeURIComponent('🎉')}/@me`
    ).catch(() => {});

    return msg.id;
  } catch (err) {
    logger.warn(`[GIVEAWAY] Failed to post embed for ${giveawayId}:`, err.message);
    return null;
  }
}

function buildGiveawayEmbed(gw, entryCount) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.SUCCESS)
    .setTitle(`🎉 ${gw.prize}`);
  // gw.description was collected by both the dashboard and !giveaway start
  // but never rendered anywhere until now, it only ever reached the DB.
  if (gw.description) embed.setDescription(gw.description);
  embed
    .addFields(
      { name: 'Ends',    value: `<t:${gw.ends_at}:R>`, inline: true },
      { name: 'Winners', value: String(gw.winner_count), inline: true },
      { name: 'Entries', value: String(entryCount),      inline: true },
      { name: 'Host',    value: `<@${gw.host_id}>`,     inline: true },
    );

  if (gw.required_role_id) {
    embed.addFields({ name: 'Required Role', value: `<@&${gw.required_role_id}>`, inline: true });
  }

  embed.setFooter({ text: 'React with 🎉 to enter!' }).setTimestamp();
  return embed;
}

async function updateGiveawayEmbed(client, gw, winners, entryCount) {
  if (!gw.message_id || !gw.channel_id) return;
  try {
    const winnerText = winners.length
      ? winners.map(u => `<@${u}>`).join(', ')
      : 'No valid entries.';

    const embed = new EmbedBuilder()
      .setColor(COLORS.MUTED)
      .setTitle(`🎉 ${gw.prize} (Ended)`)
      .addFields(
        { name: 'Winners', value: winnerText,            inline: false },
        { name: 'Entries', value: String(entryCount),   inline: true },
        { name: 'Host',    value: `<@${gw.host_id}>`,   inline: true },
      )
      .setTimestamp();

    await client.rest.patch(`/channels/${gw.channel_id}/messages/${gw.message_id}`, {
      body: { embeds: [embed.toJSON()] },
    });
  } catch { /* non-fatal */ }
}

// ─── Giveaway poller ──────────────────────────────────────────────────────────
const POLL_MS = 15_000;
let _gwTimer  = null;

export function startGiveawayPoller(client) {
  if (_gwTimer) return;

  const tick = async () => {
    // 1. Post scheduled giveaways
    const scheduled = stmts.scheduled.all();
    for (const gw of scheduled) {
      stmts.setStatus.run('live', gw.id);
      await postGiveawayEmbed(client, gw.id);
    }

    // 2. End expired giveaways
    const expired = stmts.expired.all();
    for (const gw of expired) {
      await endGiveaway(client, gw.id);
    }

    // 3. Send reminders (ends within 5 minutes)
    const reminders = stmts.needsReminder.all();
    for (const gw of reminders) {
      stmts.setReminder.run(gw.id);
      try {
        await client.rest.post(`/channels/${gw.channel_id}/messages`, {
          body: { content: `⏰ **${gw.prize}** giveaway ends <t:${gw.ends_at}:R>! React 🎉 to enter!` },
        });
      } catch { /* non-fatal */ }
    }

    // 4. Update active embeds (entry count refresh)
    const live = db.prepare(`SELECT * FROM giveaways WHERE status = 'live' AND message_id IS NOT NULL`).all();
    for (const gw of live) {
      const count = getEntryCount(gw.id);
      try {
        const embed = buildGiveawayEmbed(gw, count);
        await client.rest.patch(`/channels/${gw.channel_id}/messages/${gw.message_id}`, {
          body: { embeds: [embed.toJSON()] },
        });
      } catch { /* non-fatal, embed may have been deleted */ }
    }
  };

  resilience.runLight('giveawaySystem.tick', tick);
  _gwTimer = setInterval(() => resilience.runLight('giveawaySystem.tick', tick), POLL_MS);
  _gwTimer.unref?.();
  logger.info('[GIVEAWAY] Poller started (15s interval).');
}

// ─── Handle reaction entry ────────────────────────────────────────────────────
export async function handleGiveawayReaction(client, giveawayId, userId) {
  const gw = getGiveaway(giveawayId);
  if (!gw || gw.status !== 'live') return false;
  if (gw.paused) return false; // no entries while paused

  if (stmts.isBlacklisted.get(giveawayId, userId)) return false;
  if (isEntered(giveawayId, userId)) return false;

  // Required role check
  if (gw.required_role_id) {
    const member = await client.rest.get(`/guilds/${gw.guild_id}/members/${userId}`).catch(() => null);
    if (!member?.roles?.includes?.(gw.required_role_id) && !member?.roles?.some?.(r => r === gw.required_role_id)) {
      return false;
    }
  }

  enterGiveaway(giveawayId, userId);

  // Apply bonus entries from bonus roles
  const bonusRoles = stmts.getBonusRoles.all(giveawayId);
  if (bonusRoles.length) {
    const member = await client.rest.get(`/guilds/${gw.guild_id}/members/${userId}`).catch(() => null);
    const memberRoles = member?.roles ?? [];
    let bonus = 0;
    for (const br of bonusRoles) {
      if (memberRoles.includes(br.role_id)) bonus += br.bonus_entries;
    }
    if (bonus > 0) {
      db.prepare(`UPDATE giveaway_entries SET bonus = ? WHERE giveaway_id = ? AND user_id = ?`)
        .run(bonus, giveawayId, userId);
    }
  }

  return true;
}

// ─── Managing a giveaway (b!giveaway and the dashboard share these) ──────────
// Each works on the tables the bot actually reads: giveaway_entries,
// giveaway_winners, giveaway_blacklist and giveaway_bonus. The dashboard
// used to write JSON columns on giveaways instead, which nothing read, so
// its blacklist, bonus entries, reroll and entry list did nothing.
export class GiveawayError extends Error {}
function ownGiveaway(guildId, id) {
  const gw = getGiveaway(Number(id));
  if (!gw || gw.guild_id !== guildId) throw new GiveawayError(`No giveaway #${id} in this server.`);
  return gw;
}
const running = gw => { if (gw.status === 'ended') throw new GiveawayError(`Giveaway #${gw.id} has already ended.`); return gw; };

export function pauseGiveaway(guildId, id) {
  const gw = running(ownGiveaway(guildId, id));
  if (gw.paused) throw new GiveawayError(`Giveaway #${gw.id} is already paused.`);
  db.prepare('UPDATE giveaways SET paused = 1, paused_at = unixepoch() WHERE id = ?').run(gw.id);
}

// The end moves back by however long it was paused, so nobody loses time.
export function resumeGiveaway(guildId, id) {
  const gw = running(ownGiveaway(guildId, id));
  if (!gw.paused) throw new GiveawayError(`Giveaway #${gw.id} isn't paused.`);
  db.prepare(`UPDATE giveaways SET paused = 0, ends_at = ends_at + MAX(0, unixepoch() - COALESCE(paused_at, unixepoch())), paused_at = NULL WHERE id = ?`).run(gw.id);
  return getGiveaway(gw.id);
}

export function extendGiveaway(guildId, id, seconds) {
  const gw = running(ownGiveaway(guildId, id));
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 90 * 86400) throw new GiveawayError('Extend by a length from 1 minute to 90 days, like 30m, 2h or 3d.');
  db.prepare('UPDATE giveaways SET ends_at = ends_at + ?, extend_count = COALESCE(extend_count, 0) + 1 WHERE id = ?').run(Math.round(seconds), gw.id);
  return getGiveaway(gw.id);
}

// Fields a running giveaway can change.
export function editGiveaway(guildId, id, field, value) {
  const gw = running(ownGiveaway(guildId, id));
  const cols = { prize: 'prize', description: 'description', winners: 'winner_count', role: 'required_role_id', level: 'min_level', days: 'min_days', ping: 'ping_role_id' };
  const col = cols[field];
  if (!col) throw new GiveawayError(`You can change: ${Object.keys(cols).join(', ')}.`);
  if (col === 'winner_count' && !(Number.isInteger(value) && value >= 1 && value <= 20)) throw new GiveawayError('Winners must be from 1 to 20.');
  if ((col === 'min_level' || col === 'min_days') && value != null && !(Number.isInteger(value) && value >= 0 && value <= 10000)) throw new GiveawayError('Use a whole number, or off.');
  if (col === 'prize' && (!value || String(value).length > 200)) throw new GiveawayError('The prize needs a name, up to 200 characters.');
  db.prepare(`UPDATE giveaways SET ${col} = ? WHERE id = ?`).run(value ?? null, gw.id);
  return getGiveaway(gw.id);
}

export function setGiveawayBlacklist(guildId, id, userId, add) {
  const gw = ownGiveaway(guildId, id);
  if (add) {
    stmts.addBlacklist.run(gw.id, userId);
    stmts.removeEntry.run(gw.id, userId); // someone blocked can't stay entered
  } else {
    stmts.removeBlacklist.run(gw.id, userId);
  }
}

// Extra entries for members with a role (0 or null removes the bonus).
export function setGiveawayBonus(guildId, id, roleId, extraEntries) {
  const gw = ownGiveaway(guildId, id);
  if (!extraEntries) { db.prepare('DELETE FROM giveaway_bonus WHERE giveaway_id = ? AND role_id = ?').run(gw.id, roleId); return; }
  if (!Number.isInteger(extraEntries) || extraEntries < 1 || extraEntries > 19) throw new GiveawayError('Bonus entries must be from 1 to 19 extra.');
  stmts.setBonusRole.run(gw.id, roleId, extraEntries);
}

export function listGiveawayBonuses(giveawayId) {
  return stmts.getBonusRoles.all(Number(giveawayId));
}

export function listGiveawayEntries(giveawayId) {
  return stmts.getEntries.all(Number(giveawayId));
}

export function listGiveawayBlacklist(giveawayId) {
  return db.prepare('SELECT user_id FROM giveaway_blacklist WHERE giveaway_id = ?').all(Number(giveawayId)).map(r => r.user_id);
}

export function deleteGiveaway(guildId, id) {
  const gw = ownGiveaway(guildId, id);
  db.transaction(() => {
    for (const t of ['giveaway_entries', 'giveaway_winners', 'giveaway_blacklist', 'giveaway_bonus']) {
      try { db.prepare(`DELETE FROM ${t} WHERE giveaway_id = ?`).run(gw.id); } catch { /* table may not exist on old installs */ }
    }
    db.prepare('DELETE FROM giveaways WHERE id = ?').run(gw.id);
  })();
  return gw;
}

export { stmts as _giveawayStmts };
