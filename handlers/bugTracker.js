// ─── Bug tracker ────────────────────────────────────────────────────────────
// Bugs found via tickets (a user reports one in a ticket, staff confirms it)
// get logged here by staff afterward, numbered per-guild like modlog cases
// and ticket case IDs. Deliberately just a counter + description for now,
// no status/notes/removal workflow, that only gets built if it ends up
// actually needed by !bugreport or similar. reporter_id is still captured
// so a future economy reward for confirmed bug hunters has something to
// key off without a schema change later, no reward logic exists yet, this
// is just the hook.

import db from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS bug_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    bug_number  INTEGER NOT NULL,
    reporter_id TEXT,
    logged_by   TEXT    NOT NULL,
    description TEXT    NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (guild_id, bug_number)
  );
`);

const stmts = {
  nextNumber: db.prepare(`SELECT COALESCE(MAX(bug_number), 0) + 1 AS next FROM bug_reports WHERE guild_id = ?`),
  insert: db.prepare(`
    INSERT INTO bug_reports (guild_id, bug_number, reporter_id, logged_by, description, created_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
  `),
  list: db.prepare(`SELECT * FROM bug_reports WHERE guild_id = ? ORDER BY bug_number DESC`),
};

export function addBug(guildId, reporterId, loggedBy, description) {
  const { next } = stmts.nextNumber.get(guildId);
  stmts.insert.run(guildId, next, reporterId ?? null, loggedBy, description);
  return next;
}

export function listBugs(guildId) {
  return stmts.list.all(guildId);
}
