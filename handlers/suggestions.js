// ============================================================
//  handlers/suggestions.js
//
//  b!suggest: members send ideas from any server. Each one is saved, and
//  posted to the suggestions channel in Bloo's support server (when
//  SUGGESTIONS_CHANNEL_ID is set) with 👍 and 👎 for voting.
//
//  Bot owners set a status (open, planned, building, shipped, declined)
//  with `b!suggest status` or from the dashboard (Developer → Community).
//  The post is updated and the suggester gets a DM. Marking one shipped
//  also credits the suggester as a contributor (handlers/contributors.js).
//
//  Uses the Fluxer API directly with the bot token, so the bot and the
//  dashboard process share the same code.
// ============================================================

import db from '../db.js';
import logger from '../utils/logger.js';
import { COLORS } from '../config/embeds.js';
import { addContributor } from './contributors.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS suggestions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    username    TEXT NOT NULL,
    guild_id    TEXT,
    text        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    note        TEXT,
    channel_id  TEXT,
    message_id  TEXT,
    up          INTEGER NOT NULL DEFAULT 0,
    down        INTEGER NOT NULL DEFAULT 0,
    credited    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions (status, id);
  CREATE INDEX IF NOT EXISTS idx_suggestions_user   ON suggestions (user_id);
`);

export const STATUSES = {
  open:     { label: 'Open',     icon: '🗳️', color: COLORS.INFO,    dm: null },
  planned:  { label: 'Planned',  icon: '📌', color: COLORS.PURPLE,  dm: 'is planned' },
  building: { label: 'Building', icon: '🔨', color: COLORS.WARNING, dm: 'is being built' },
  shipped:  { label: 'Shipped',  icon: '✅', color: COLORS.SUCCESS, dm: 'has shipped' },
  declined: { label: 'Declined', icon: '✖️', color: COLORS.MUTED,   dm: 'won\'t be going ahead' },
};

export const MIN_LENGTH = 15;
export const MAX_LENGTH = 1000;
const MAX_OPEN_PER_USER = 5;

export class SuggestionError extends Error {}

const q = {
  get:       db.prepare(`SELECT * FROM suggestions WHERE id = ?`),
  insert:    db.prepare(`INSERT INTO suggestions (user_id, username, guild_id, text) VALUES (?, ?, ?, ?)`),
  posted:    db.prepare(`UPDATE suggestions SET channel_id = ?, message_id = ? WHERE id = ?`),
  status:    db.prepare(`UPDATE suggestions SET status = ?, note = ?, updated_at = unixepoch() WHERE id = ?`),
  votes:     db.prepare(`UPDATE suggestions SET up = ?, down = ? WHERE id = ?`),
  credited:  db.prepare(`UPDATE suggestions SET credited = 1 WHERE id = ?`),
  openBy:    db.prepare(`SELECT COUNT(*) n FROM suggestions WHERE user_id = ? AND status = 'open'`),
  list:      db.prepare(`SELECT * FROM suggestions WHERE (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?`),
  counts:    db.prepare(`SELECT status, COUNT(*) n FROM suggestions GROUP BY status`),
  del:       db.prepare(`DELETE FROM suggestions WHERE id = ?`),
};

// ── Fluxer API ──────────────────────────────────────────────────────────────
const API = () => (process.env.FLUXER_API || 'https://api.fluxer.app').replace(/\/+$/, '');
async function rest(method, path, body) {
  const token = process.env.FLUXER_BOT_TOKEN;
  if (!token) throw new Error('No bot token');
  const res = await fetch(API() + path, {
    method,
    headers: { Authorization: `Bot ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${method} ${path.split('/').slice(0, 3).join('/')} → ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

const channelId = () => process.env.SUGGESTIONS_CHANNEL_ID || null;
export const suggestionsChannelSet = () => !!channelId();

export function suggestionEmbed(s) {
  const st = STATUSES[s.status] ?? STATUSES.open;
  return {
    color: st.color,
    title: `💡 Suggestion #${s.id}`,
    description: s.text,
    fields: [{ name: 'Status', value: `${st.icon} **${st.label}**${s.note ? `\n${s.note}` : ''}`, inline: false }],
    footer: { text: `Suggested by ${s.username}${s.status === 'open' ? ' · Vote with 👍 or 👎' : ''}` },
    timestamp: new Date(s.created_at * 1000).toISOString(),
  };
}

// ── Creating ────────────────────────────────────────────────────────────────
export async function createSuggestion({ userId, username, guildId, text }) {
  const clean = String(text ?? '').replace(/\s+\n/g, '\n').trim();
  if (clean.length < MIN_LENGTH) throw new SuggestionError(`Give a little more detail: at least ${MIN_LENGTH} characters.`);
  if (clean.length > MAX_LENGTH) throw new SuggestionError(`Keep it under ${MAX_LENGTH} characters.`);
  if (q.openBy.get(userId).n >= MAX_OPEN_PER_USER) {
    throw new SuggestionError(`You have ${MAX_OPEN_PER_USER} open suggestions already. Once one gets a status you can send another.`);
  }
  const id = Number(q.insert.run(userId, String(username).slice(0, 64), guildId ?? null, clean).lastInsertRowid);
  const s = q.get.get(id);
  const ch = channelId();
  if (ch) {
    try {
      const msg = await rest('POST', `/channels/${ch}/messages`, { embeds: [suggestionEmbed(s)], allowed_mentions: { parse: [] } });
      if (msg?.id) {
        q.posted.run(ch, msg.id, id);
        for (const e of ['👍', '👎']) {
          await rest('PUT', `/channels/${ch}/messages/${msg.id}/reactions/${encodeURIComponent(e)}/@me`).catch(() => {});
        }
      }
    } catch (err) {
      logger.warn(`[SUGGEST] Couldn't post #${id} to the suggestions channel: ${err.message}`);
    }
  }
  return q.get.get(id);
}

// ── Votes (the reactions on the post, minus Bloo's own) ─────────────────────
export async function refreshVotes(id) {
  const s = q.get.get(id);
  if (!s?.message_id) return s;
  try {
    const msg = await rest('GET', `/channels/${s.channel_id}/messages/${s.message_id}`);
    const count = name => {
      const r = (msg?.reactions ?? []).find(x => x.emoji?.name === name);
      return r ? Math.max(0, r.count - (r.me ? 1 : 0)) : 0;
    };
    q.votes.run(count('👍'), count('👎'), id);
  } catch { /* keep the last known counts */ }
  return q.get.get(id);
}

// ── Status ──────────────────────────────────────────────────────────────────
export async function setStatus(id, status, note = null) {
  const s = q.get.get(Number(id));
  if (!s) throw new SuggestionError(`There's no suggestion #${id}.`);
  if (!STATUSES[status]) throw new SuggestionError(`Status must be one of: ${Object.keys(STATUSES).join(', ')}.`);
  const cleanNote = note ? String(note).trim().slice(0, 300) || null : null;
  q.status.run(status, cleanNote, s.id);
  const updated = q.get.get(s.id);

  if (updated.message_id) {
    await rest('PATCH', `/channels/${updated.channel_id}/messages/${updated.message_id}`, { embeds: [suggestionEmbed(updated)] })
      .catch(err => logger.warn(`[SUGGEST] Couldn't update the post for #${s.id}: ${err.message}`));
  }

  let credited = false;
  if (status === 'shipped' && !updated.credited) {
    try {
      addContributor({ userId: updated.user_id, name: updated.username, kind: 'idea', note: shortText(updated.text, 120) });
      q.credited.run(updated.id);
      credited = true;
    } catch (err) {
      logger.warn(`[SUGGEST] Couldn't credit the suggester of #${s.id}: ${err.message}`);
    }
  }

  // Let them know, unless it went back to open (nothing to tell).
  let dmSent = false;
  const st = STATUSES[status];
  if (st.dm && status !== s.status) {
    try {
      const dm = await rest('POST', '/users/@me/channels', { recipient_id: updated.user_id });
      const lines = [
        `Your suggestion #${updated.id} ${st.dm}. ${status === 'declined' ? 'Thanks for sending it in all the same.' : 'Thanks for the idea!'}`,
        `> ${shortText(updated.text, 300).replace(/\n/g, '\n> ')}`,
        cleanNote ? `\n${cleanNote}` : null,
        credited ? '\nYou\'re now on Bloo\'s Contributors list, and your rank card shows a 🏅 Contributor badge.' : null,
      ].filter(Boolean);
      await rest('POST', `/channels/${dm.id}/messages`, {
        embeds: [{ color: st.color, title: `${st.icon} Suggestion ${st.label.toLowerCase()}`, description: lines.join('\n') }],
        allowed_mentions: { parse: [] },
      });
      dmSent = true;
    } catch { /* closed DMs */ }
  }
  return { suggestion: updated, credited, dmSent, creditLine: status === 'shipped' ? `💡 Suggested by **${updated.username}**` : null };
}

export async function deleteSuggestion(id) {
  const s = q.get.get(Number(id));
  if (!s) return false;
  if (s.message_id) await rest('DELETE', `/channels/${s.channel_id}/messages/${s.message_id}`).catch(() => {});
  return q.del.run(s.id).changes > 0;
}

export const getSuggestion = id => q.get.get(Number(id)) ?? null;
export const listSuggestions = (status = null, limit = 50) => q.list.all(status, status, Math.min(200, limit));
export const statusCounts = () => Object.fromEntries(q.counts.all().map(r => [r.status, r.n]));

function shortText(t, n) {
  t = String(t).trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}
