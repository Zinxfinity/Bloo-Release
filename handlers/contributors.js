// ============================================================
//  handlers/contributors.js
//
//  People who helped shape Bloo: reported a bug that got fixed, or
//  suggested something that shipped. They get a 🏅 Contributor badge on
//  their rank and profile card and a line on the docs site's Contributors
//  page (public, served by dashboard/routes/community.js).
//
//  Added by bot owners with `b!contributor add`, from the dashboard
//  (Developer → Community), or automatically when a suggestion is marked
//  shipped (handlers/suggestions.js).
// ============================================================

import db from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS contributors (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('bug', 'idea', 'other')),
    note       TEXT,
    added_by   TEXT,
    added_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_contributors_user ON contributors (user_id);
`);

export const KINDS = { bug: 'Bug report', idea: 'Idea', other: 'Help' };

export class ContributorError extends Error {}

const q = {
  any:    db.prepare(`SELECT 1 FROM contributors WHERE user_id = ? LIMIT 1`),
  add:    db.prepare(`INSERT INTO contributors (user_id, name, kind, note, added_by) VALUES (?, ?, ?, ?, ?)`),
  del:    db.prepare(`DELETE FROM contributors WHERE id = ?`),
  all:    db.prepare(`SELECT * FROM contributors ORDER BY added_at DESC, id DESC`),
  rename: db.prepare(`UPDATE contributors SET name = ? WHERE user_id = ?`),
};

export const isContributor = userId => !!(userId && q.any.get(String(userId)));

export function addContributor({ userId, name, kind = 'other', note = null }, by = null) {
  if (!/^\d{15,22}$/.test(String(userId ?? ''))) throw new ContributorError('That isn\'t a valid user ID.');
  if (!KINDS[kind]) throw new ContributorError('Kind must be bug, idea or other.');
  const cleanName = String(name ?? '').trim().slice(0, 64);
  if (!cleanName) throw new ContributorError('A name is needed for the Contributors page.');
  const cleanNote = note ? String(note).trim().slice(0, 200) || null : null;
  const id = q.add.run(String(userId), cleanName, kind, cleanNote, by).lastInsertRowid;
  // Keep one name per person, so the page doesn't list someone twice under
  // an old and a new username.
  q.rename.run(cleanName, String(userId));
  return { id: Number(id) };
}

export function removeContribution(id) {
  return q.del.run(Number(id)).changes > 0;
}

export const listContributions = () => q.all.all();

// The public view: one row per person, newest contribution first, with
// what they helped with. No user IDs leave the server.
export function publicContributors() {
  const people = new Map();
  for (const r of q.all.all()) {
    if (!people.has(r.user_id)) people.set(r.user_id, { name: r.name, since: r.added_at, items: [] });
    const p = people.get(r.user_id);
    p.since = Math.min(p.since, r.added_at);
    p.items.push({ kind: r.kind, label: KINDS[r.kind], note: r.note, at: r.added_at });
  }
  return [...people.values()];
}
