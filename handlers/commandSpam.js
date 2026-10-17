// ============================================================
//  handlers/commandSpam.js
//
//  Stops command spam that the per-command cooldown can't: someone cycling
//  through different commands to make Bloo post over and over.
//
//  More than BURST_MAX commands (or tags) in BURST_WINDOW_MS is a strike:
//    strike 1   a warning
//    strike 2+  commands paused for 1, 2, 4, 8... minutes, at most an hour
//    past that  locked out until staff lift it, if the server turned
//               lockout on (b!cooldown lockout on); otherwise another hour
//  An hour without a strike clears them. While paused or locked out, Bloo
//  ignores that person's commands without replying, so spam can't make it
//  post notices in a loop.
//
//  Every strike is a case in the server's mod log and a row in
//  command_spam_log, which bot owners can read across servers (b!spamwatch).
//  Bot owners are never limited; server staff (Administrator or Manage
//  Messages, and the server owner) are exempt unless the server says not
//  (b!cooldown staff include).
// ============================================================

import db from '../db.js';
import { Embed } from '../config/embeds.js';

export const BURST_MAX = 5;
export const BURST_WINDOW_MS = 10_000;
const STRIKE_RESET_MS = 60 * 60_000;
const MAX_PAUSE_MIN = 60;

db.exec(`
  CREATE TABLE IF NOT EXISTS command_spam (
    guild_id        TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    strikes         INTEGER NOT NULL DEFAULT 0,
    last_strike_at  INTEGER,
    paused_until    INTEGER,
    locked          INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS command_spam_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    guild_id  TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    strike    INTEGER NOT NULL,
    outcome   TEXT NOT NULL,
    commands  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_command_spam_log_at ON command_spam_log (at);
`);
for (const col of ['spam_lockout INTEGER NOT NULL DEFAULT 0', 'spam_staff_exempt INTEGER NOT NULL DEFAULT 1']) {
  try { db.exec(`ALTER TABLE guild_settings ADD COLUMN ${col}`); } catch { /* already there */ }
}

const q = {
  state:    db.prepare('SELECT * FROM command_spam WHERE guild_id = ? AND user_id = ?'),
  save:     db.prepare(`INSERT INTO command_spam (guild_id, user_id, strikes, last_strike_at, paused_until, locked) VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(guild_id, user_id) DO UPDATE SET strikes = excluded.strikes, last_strike_at = excluded.last_strike_at,
                        paused_until = excluded.paused_until, locked = excluded.locked`),
  lift:     db.prepare('DELETE FROM command_spam WHERE guild_id = ? AND user_id = ?'),
  log:      db.prepare('INSERT INTO command_spam_log (at, guild_id, user_id, strike, outcome, commands) VALUES (?, ?, ?, ?, ?, ?)'),
  settings: db.prepare('SELECT spam_lockout, spam_staff_exempt FROM guild_settings WHERE guild_id = ?'),
  setOpt:   {
    spam_lockout:      db.prepare('UPDATE guild_settings SET spam_lockout = ?, updated_at = unixepoch() WHERE guild_id = ?'),
    spam_staff_exempt: db.prepare('UPDATE guild_settings SET spam_staff_exempt = ?, updated_at = unixepoch() WHERE guild_id = ?'),
  },
};

// ── Server options ───────────────────────────────────────────────────────────
export function getSpamSettings(guildId) {
  const r = q.settings.get(guildId);
  return { lockout: !!r?.spam_lockout, staffExempt: r ? !!r.spam_staff_exempt : true };
}
export function setSpamSetting(guildId, key, on) {
  const col = key === 'lockout' ? 'spam_lockout' : key === 'staffExempt' ? 'spam_staff_exempt' : null;
  if (!col) throw new Error(`Unknown spam setting: ${key}`);
  db.prepare(`INSERT OR IGNORE INTO guild_settings (guild_id, prefix, updated_at) VALUES (?, ?, unixepoch())`).run(guildId, process.env.PREFIX ?? 'b!');
  q.setOpt[col].run(on ? 1 : 0, guildId);
}

// ── Pure rules (exported for tests) ──────────────────────────────────────────
// What strike number this burst is, given the stored state.
export function nextStrike(state, now) {
  const fresh = !state?.last_strike_at || now - state.last_strike_at > STRIKE_RESET_MS;
  return fresh ? 1 : (state.strikes ?? 0) + 1;
}
// What a strike does: warn, pause for N minutes, or lock out.
export function outcomeFor(strike, lockoutOn) {
  if (strike <= 1) return { kind: 'warn' };
  const minutes = 2 ** (strike - 2);
  if (minutes > MAX_PAUSE_MIN && lockoutOn) return { kind: 'lock' };
  return { kind: 'pause', minutes: Math.min(minutes, MAX_PAUSE_MIN) };
}

// ── Recent commands per person, in memory ────────────────────────────────────
const recent = new Map(); // `${guildId}:${userId}` -> [{ at, name }]

function blockedNow(state, now) {
  if (!state) return false;
  if (state.locked) return true;
  return !!state.paused_until && now < state.paused_until;
}

const describe = o => o.kind === 'warn' ? 'warned' : o.kind === 'lock' ? 'locked out until lifted' : `paused for ${o.minutes} min`;

/**
 * Call for every command or tag before running it.
 * Returns true when the command should be dropped.
 * isExemptStaff is only called when a burst is detected.
 */
export async function checkSpam({ client, message, guildId, userId, commandName, prefix, isBotOwner, isExemptStaff }) {
  if (!guildId || isBotOwner) return false;
  const now = Date.now();
  const state = q.state.get(guildId, userId);
  if (blockedNow(state, now)) return true;

  const key = `${guildId}:${userId}`;
  const list = (recent.get(key) ?? []).filter(e => now - e.at < BURST_WINDOW_MS);
  list.push({ at: now, name: commandName });
  recent.set(key, list);
  if (recent.size > 20_000) recent.delete(recent.keys().next().value);
  if (list.length <= BURST_MAX) return false;

  // A burst. Staff may be exempt; only now is it worth looking that up.
  const settings = getSpamSettings(guildId);
  if (settings.staffExempt && await isExemptStaff()) { recent.set(key, []); return false; }

  const strike = nextStrike(state, now);
  const outcome = outcomeFor(strike, settings.lockout);
  q.save.run(guildId, userId, strike, now,
    outcome.kind === 'pause' ? now + outcome.minutes * 60_000 : null,
    outcome.kind === 'lock' ? 1 : 0);
  const commands = [...new Set(list.map(e => e.name))].join(', ');
  q.log.run(now, guildId, userId, strike, describe(outcome), commands);
  // Strikes are kept 90 days (the privacy policy says so); prune now and then.
  if (Math.random() < 0.05) db.prepare('DELETE FROM command_spam_log WHERE at < ?').run(now - 90 * 86_400_000);
  recent.set(key, []);

  // One notice per strike; nothing more while paused.
  const P = prefix ?? 'b!';
  const text = outcome.kind === 'warn'
    ? `You're sending commands too fast. Slow down, or your commands will be paused for a while.`
    : outcome.kind === 'lock'
      ? `You've kept spamming commands, so you're locked out of Bloo's commands in this server until a staff member lifts it.`
      : `You're still sending commands too fast, so your commands are paused for **${outcome.minutes} minute${outcome.minutes === 1 ? '' : 's'}**.`;
  try { await message.reply({ embeds: [Embed.warning(text, '⏳ Slow down').toJSON()] }); } catch { /* best effort */ }

  // A case in the server's own mod log.
  try {
    const { logAction } = await import('./modLog.js');
    await logAction({
      client, guildId, action: 'Command Spam', targetId: userId,
      targetTag: message.author?.username ?? userId,
      executorId: client?.user?.id ?? 'bloo', executorTag: 'Bloo',
      reason: `Strike ${strike}: ${describe(outcome)}. ${list.length} commands in ${BURST_WINDOW_MS / 1000}s (${commands}).` +
        (outcome.kind === 'lock' || outcome.kind === 'pause' ? ` Lift with ${P}cooldown lift <@${userId}>.` : ''),
      color: 0xf59e0b,
    });
  } catch { /* the strike still counts if the mod log can't be posted */ }

  return outcome.kind !== 'warn';
}

// Staff command: clear someone's strikes, pause and lockout.
export function liftSpam(guildId, userId) {
  recent.delete(`${guildId}:${userId}`);
  return q.lift.run(guildId, userId).changes > 0;
}

export function spamState(guildId, userId, now = Date.now()) {
  const s = q.state.get(guildId, userId);
  if (!s) return null;
  return { ...s, active: blockedNow(s, now), strikesCount: now - (s.last_strike_at ?? 0) > STRIKE_RESET_MS ? 0 : s.strikes };
}

export const blockedInGuild = (guildId, now = Date.now()) =>
  db.prepare('SELECT * FROM command_spam WHERE guild_id = ? AND (locked = 1 OR paused_until > ?) ORDER BY last_strike_at DESC').all(guildId, now);

// For bot owners: recent strikes across every server.
export const recentStrikes = (limit = 25) =>
  db.prepare('SELECT * FROM command_spam_log ORDER BY at DESC LIMIT ?').all(Math.min(Number(limit) || 25, 100));
