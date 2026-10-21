// ─── Advanced Polls ────────────────────────────────────────────────────────────
// Replaces !poll's fire-and-forget reaction-seeding with a tracked, live-
// updating poll: persistent vote tally (survives restarts, unlike an
// in-memory approach), single or multi-choice modes, a host/mod "Close
// Vote" reaction, and an expiry date. Votes aren't secret (per the design
// spec: Fluxer reactions already show who reacted to what), so the embed
// shows live percentages rather than revealing results only at the end.

import db from '../db.js';
import logger from '../utils/logger.js';
import * as resilience from './resilience.js';
import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../config/embeds.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS adv_polls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    channel_id  TEXT    NOT NULL,
    message_id  TEXT,
    host_id     TEXT    NOT NULL,
    mode        TEXT    NOT NULL DEFAULT 'single' CHECK (mode IN ('single','multiple')),
    question    TEXT    NOT NULL,
    description TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    ends_at     INTEGER NOT NULL,
    closed_at   INTEGER,
    closed_by   TEXT
  );

  CREATE TABLE IF NOT EXISTS adv_poll_options (
    poll_id INTEGER NOT NULL,
    idx     INTEGER NOT NULL,
    label   TEXT    NOT NULL,
    emoji   TEXT    NOT NULL,
    PRIMARY KEY (poll_id, idx)
  );

  CREATE TABLE IF NOT EXISTS adv_poll_votes (
    poll_id     INTEGER NOT NULL,
    option_idx  INTEGER NOT NULL,
    user_id     TEXT    NOT NULL,
    voted_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (poll_id, option_idx, user_id)
  );
`);

export const NUMBER_EMOJIS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
export const CLOSE_EMOJI = '🛑';
export const MAX_CHOICES = 10;

const stmts = {
  insertPoll:    db.prepare(`INSERT INTO adv_polls (guild_id, channel_id, host_id, mode, question, description, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  setMessageId:  db.prepare(`UPDATE adv_polls SET message_id = ? WHERE id = ?`),
  insertOption:  db.prepare(`INSERT INTO adv_poll_options (poll_id, idx, label, emoji) VALUES (?, ?, ?, ?)`),
  getById:       db.prepare(`SELECT * FROM adv_polls WHERE id = ?`),
  getByMessage:  db.prepare(`SELECT * FROM adv_polls WHERE message_id = ?`),
  getOptions:    db.prepare(`SELECT * FROM adv_poll_options WHERE poll_id = ? ORDER BY idx`),
  listActive:    db.prepare(`SELECT * FROM adv_polls WHERE closed_at IS NULL AND message_id IS NOT NULL`),
  listExpiredOpen: db.prepare(`SELECT * FROM adv_polls WHERE closed_at IS NULL AND message_id IS NOT NULL AND ends_at <= unixepoch()`),
  close:         db.prepare(`UPDATE adv_polls SET closed_at = unixepoch(), closed_by = ? WHERE id = ?`),

  addVote:       db.prepare(`INSERT OR IGNORE INTO adv_poll_votes (poll_id, option_idx, user_id) VALUES (?, ?, ?)`),
  removeVote:    db.prepare(`DELETE FROM adv_poll_votes WHERE poll_id = ? AND option_idx = ? AND user_id = ?`),
  removeOtherVotesForUser: db.prepare(`DELETE FROM adv_poll_votes WHERE poll_id = ? AND user_id = ? AND option_idx != ?`),
  getUserVoteOptions: db.prepare(`SELECT option_idx FROM adv_poll_votes WHERE poll_id = ? AND user_id = ?`),
  countVotesByOption: db.prepare(`SELECT option_idx, COUNT(*) AS n FROM adv_poll_votes WHERE poll_id = ? GROUP BY option_idx`),
  countUniqueVoters:  db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM adv_poll_votes WHERE poll_id = ?`),
};

// ─── dd/MM/yyyy expiry parsing ────────────────────────────────────────────────
// No date-parsing helper exists anywhere else in this codebase (every other
// command rolls its own relative s|m|h|d duration regex), this is new.
// Deliberately not `new Date(str)`, ambiguous/locale-dependent for this
// format. End of that day, UTC, so "the 24th" means "through the 24th".
export function parseExpiryDate(str) {
  const m = str?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10), month = parseInt(m[2], 10), year = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day, 23, 59, 59));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null; // rejects e.g. 31/02
  const ts = Math.floor(date.getTime() / 1000);
  if (ts <= Math.floor(Date.now() / 1000)) return null; // must be in the future
  return ts;
}

// ─── Multi-line command body parsing ─────────────────────────────────────────
// message.content's first line is "<prefix><command> <mode> <date>", the
// rest is question / description / choices, one per line. Deliberately not
// using commandHandler's own `args` (it space-splits the WHOLE message,
// including later lines, losing line boundaries), callers pass raw
// message.content instead.
export function parseAdvPoll(rawContent) {
  const lines = rawContent.split('\n');
  const firstLineWords = lines[0].trim().split(/\s+/);
  const mode = firstLineWords[1]?.toLowerCase();
  if (mode !== 'single' && mode !== 'multiple') {
    return { ok: false, error: 'First line must be `<prefix>advpoll <single|multiple> <dd/MM/yyyy>`.' };
  }
  const endsAt = parseExpiryDate(firstLineWords[2]);
  if (!endsAt) {
    return { ok: false, error: 'Expiry date must be a valid `dd/MM/yyyy` date in the future.' };
  }

  const question = lines[1]?.trim();
  if (!question) return { ok: false, error: 'Line 2 must be the question to ask.' };

  const description = lines[2]?.trim() || null;

  const choices = lines.slice(3).map(l => l.trim()).filter(Boolean);
  if (choices.length < 2) return { ok: false, error: 'At least 2 choices are required (one per line after the description line).' };
  if (choices.length > MAX_CHOICES) return { ok: false, error: `At most ${MAX_CHOICES} choices are allowed.` };

  return { ok: true, mode, endsAt, question, description, choices };
}

// ─── Core ─────────────────────────────────────────────────────────────────────
export const createPoll = db.transaction((guildId, channelId, hostId, mode, question, description, endsAt, choices) => {
  const info = stmts.insertPoll.run(guildId, channelId, hostId, mode, question, description, endsAt);
  const pollId = info.lastInsertRowid;
  choices.forEach((label, i) => stmts.insertOption.run(pollId, i + 1, label, NUMBER_EMOJIS[i]));
  return { poll: stmts.getById.get(pollId), options: stmts.getOptions.all(pollId) };
});

export function attachMessage(pollId, messageId) {
  stmts.setMessageId.run(messageId, pollId);
}

export function getActivePollByMessage(messageId) {
  const poll = stmts.getByMessage.get(messageId);
  if (!poll || poll.closed_at) return null;
  return poll;
}

export function getPoll(pollId) {
  return stmts.getById.get(pollId);
}

export function getOptions(pollId) {
  return stmts.getOptions.all(pollId);
}

// Records a vote for optionIdx; in single mode also clears the user's other
// DB-side votes on this poll (the caller is responsible for also removing
// the user's other reactions on the actual message via REST, this only
// keeps the tally correct). Returns the option indexes that need their
// Fluxer reactions removed as a result (empty in multiple mode).
export const castVote = db.transaction((pollId, optionIdx, userId, mode) => {
  stmts.addVote.run(pollId, optionIdx, userId);
  if (mode !== 'single') return [];
  const others = stmts.getUserVoteOptions.all(pollId, userId).map(r => r.option_idx).filter(i => i !== optionIdx);
  stmts.removeOtherVotesForUser.run(pollId, userId, optionIdx);
  return others;
});

export function removeVote(pollId, optionIdx, userId) {
  stmts.removeVote.run(pollId, optionIdx, userId);
}

export function closePoll(pollId, closedBy) {
  stmts.close.run(closedBy, pollId);
}

// ─── Embed rendering ──────────────────────────────────────────────────────────
function progressBar(pct, width = 9) {
  const fill = Math.round(Math.min(Math.max(pct, 0), 100) / 100 * width);
  return '🟩'.repeat(fill) + '⬛'.repeat(width - fill);
}

export function buildPollEmbed(poll, options) {
  const counts = Object.fromEntries(stmts.countVotesByOption.all(poll.id).map(r => [r.option_idx, r.n]));
  const totalVotes = Object.values(counts).reduce((a, b) => a + b, 0);
  const uniqueVoters = stmts.countUniqueVoters.get(poll.id).n;
  // Each choice's share of the people who voted ("80% of voters picked
  // this"). In a multiple-choice poll the shares can add up past 100%; in a
  // single-choice poll voters and votes are the same, so it's the usual split.
  const base = uniqueVoters;

  const lines = [];
  if (poll.description) lines.push(poll.description, '');
  lines.push(poll.mode === 'multiple'
    ? '-# This is a multiple-choice poll, you can cast more than one choice.'
    : '-# This is a single-choice poll, casting a new choice replaces your previous one.');
  lines.push(poll.closed_at
    ? '-# **This poll is closed.**'
    : `-# This poll's expiry date is <t:${poll.ends_at}:F> <t:${poll.ends_at}:R>`);

  for (const opt of options) {
    const count = counts[opt.idx] ?? 0;
    const pct = base > 0 ? Math.round((count / base) * 100) : 0;
    lines.push(`#### ${opt.label}`, `-# ${opt.emoji} ${progressBar(pct)} **${pct}%**`);
  }

  lines.push('', `-# Votes count: ${totalVotes}`, `-# Unique voters: ${uniqueVoters}`);

  return new EmbedBuilder()
    .setColor(poll.closed_at ? COLORS.MUTED : COLORS.INFO)
    .setTitle(`📬 ${poll.question}`)
    .setDescription(lines.join('\n').slice(0, 4096))
    .setFooter({ text: poll.closed_at ? `Poll #${poll.id}` : `Poll #${poll.id} · Host or a mod can react ${CLOSE_EMOJI} to close early` })
    .toJSON();
}

async function renderAndUpdateEmbed(client, poll) {
  const options = stmts.getOptions.all(poll.id);
  const embed = buildPollEmbed(poll, options);
  try {
    await client.rest.patch(`/channels/${poll.channel_id}/messages/${poll.message_id}`, { body: { embeds: [embed] } });
  } catch (err) {
    logger.warn(`[ADVPOLL] Failed to update embed for poll #${poll.id}:`, err.message);
  }
}

// Exported so the reaction handlers can trigger an immediate refresh after a
// vote (debounced by nothing fancy, just the poller's own periodic sweep
// covers the steady-state case, this is only for the "someone just voted"
// path so results don't lag behind by a full tick).
export async function refreshPollEmbed(client, pollId) {
  const poll = stmts.getById.get(pollId);
  if (!poll || !poll.message_id) return;
  await renderAndUpdateEmbed(client, poll);
}

// ─── Poller ───────────────────────────────────────────────────────────────────
// Periodic sweep, same shape as giveaway/webhook pollers: (1) close and
// finalize any poll whose expiry has passed, (2) refresh every active
// poll's embed. The per-vote refresh above handles the common case
// immediately; this tick is the fallback/steady-state driver, same
// division of labor as this codebase's other tracked-message features.
const POLL_TICK_MS = 15_000;
let _pollTimer = null;

export function startAdvPollPoller(client) {
  if (_pollTimer) return;

  const tick = async () => {
    const expired = stmts.listExpiredOpen.all();
    for (const poll of expired) {
      stmts.close.run(null, poll.id);
      const fresh = stmts.getById.get(poll.id);
      await renderAndUpdateEmbed(client, fresh);
    }

    const active = stmts.listActive.all();
    for (const poll of active) {
      await renderAndUpdateEmbed(client, poll);
    }
  };

  resilience.runLight('advPoll.tick', tick);
  _pollTimer = setInterval(() => resilience.runLight('advPoll.tick', tick), POLL_TICK_MS);
  _pollTimer.unref?.();
  logger.info(`[ADVPOLL] Poller started (${POLL_TICK_MS / 1000}s interval).`);
}
