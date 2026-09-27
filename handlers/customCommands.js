import db from '../db.js';

// ─── Schema migrations, run before ANY db.prepare() call ────────────────────
// Handle the name→trigger column rename: check if the old 'name' column exists.
// If it does, rebuild the table. SQLite's RENAME COLUMN requires v3.25+; doing
// it via CREATE/INSERT/DROP works on any version.
// Rename legacy `name` column to `trigger` if needed, then add missing columns.
// Uses separate exec() calls (better-sqlite3 does not allow DML + DDL in one exec).
{
  let cols = [];
  try { cols = db.prepare('PRAGMA table_info(custom_commands)').all(); } catch { /* no table yet */ }
  const hasName    = cols.some(c => c.name === 'name');
  const hasTrigger = cols.some(c => c.name === 'trigger');
  if (hasName && !hasTrigger) {
    // Step-by-step table rebuild, works on all SQLite versions. The SELECT
    // below only references source columns confirmed to exist via the
    // `cols` list above, an even older shape (no `embed`, `creator_id`
    // instead of `created_by`) would otherwise fail to resolve those
    // columns at all (COALESCE can't rescue a column that doesn't exist),
    // silently falling through to the RENAME-only fallback and leaving
    // created_by/embed missing forever, since nothing below ever added them.
    const has = (name) => cols.some(c => c.name === name);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS custom_commands_new (
          guild_id   TEXT NOT NULL,
          trigger    TEXT NOT NULL,
          response   TEXT NOT NULL,
          embed      INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          uses       INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (guild_id, trigger)
        )
      `);
      db.exec(`
        INSERT OR IGNORE INTO custom_commands_new (guild_id, trigger, response, embed, created_by, created_at)
          SELECT guild_id, name, response,
                 ${has('embed') ? 'COALESCE(embed, 0)' : '0'},
                 ${has('created_by') ? 'COALESCE(created_by, \'unknown\')' : has('creator_id') ? 'COALESCE(creator_id, \'unknown\')' : "'unknown'"},
                 ${has('created_at') ? 'COALESCE(created_at, unixepoch())' : 'unixepoch()'}
          FROM custom_commands
      `);
      db.exec('DROP TABLE custom_commands');
      db.exec('ALTER TABLE custom_commands_new RENAME TO custom_commands');
    } catch (err) {
      // If rebuild fails for any reason, try a simple RENAME COLUMN (SQLite >= 3.25)
      try { db.exec('ALTER TABLE custom_commands RENAME COLUMN name TO trigger'); } catch { /* too old */ }
    }
  }
  // Add any other missing columns to existing table
  for (const col of [
    'ALTER TABLE custom_commands ADD COLUMN uses INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE custom_commands ADD COLUMN embed INTEGER NOT NULL DEFAULT 0',
    `ALTER TABLE custom_commands ADD COLUMN created_by TEXT NOT NULL DEFAULT 'unknown'`,
  ]) { try { db.exec(col); } catch { /* already exists */ } }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS custom_commands (
    guild_id   TEXT NOT NULL,
    trigger    TEXT NOT NULL,
    response   TEXT NOT NULL,
    embed      INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    uses       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, trigger)
  )
`);

const stmts = {
  get:    db.prepare(`SELECT * FROM custom_commands WHERE guild_id = ? AND trigger = ?`),
  list:   db.prepare(`SELECT trigger, response, embed FROM custom_commands WHERE guild_id = ? ORDER BY trigger`),
  add:    db.prepare(`
    INSERT OR REPLACE INTO custom_commands (guild_id, trigger, response, embed, created_by)
    VALUES (?, ?, ?, ?, ?)
  `),
  remove: db.prepare(`DELETE FROM custom_commands WHERE guild_id = ? AND trigger = ?`),
};

export function addCustomCommand(guildId, trigger, response, embed, createdBy) {
  stmts.add.run(guildId, trigger.toLowerCase(), response, embed ? 1 : 0, createdBy);
}

export function removeCustomCommand(guildId, trigger) {
  stmts.remove.run(guildId, trigger.toLowerCase());
}

export function listCustomCommands(guildId) {
  return stmts.list.all(guildId);
}

// Tags are triggered by handlers/commandHandler.js's fallback, after real
// commands and aliases fail to match.

// Renames in place so uses/embed/created_at survive. Returns false if the new
// name is already taken (never silently overwrites another tag).
export function renameTag(guildId, oldName, newName) {
  if (getTag(guildId, newName.toLowerCase())) return false;
  const r = db.prepare('UPDATE custom_commands SET trigger = ? WHERE guild_id = ? AND trigger = ?')
    .run(newName.toLowerCase(), guildId, oldName.toLowerCase());
  return r.changes > 0;
}

// ─── addTag / removeTag / getTag / listTags ───────────────────────────────────
// Aliases for the tag command which uses different function names.
export function addTag(guildId, name, response, creatorId) {
  db.prepare(`
    INSERT INTO custom_commands (guild_id, trigger, response, embed, created_by)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(guild_id, trigger) DO UPDATE SET response = excluded.response, created_by = excluded.created_by
  `).run(guildId, name.toLowerCase(), response, creatorId ?? 'unknown');
}

export function removeTag(guildId, name) {
  const result = db.prepare('DELETE FROM custom_commands WHERE guild_id = ? AND trigger = ?').run(guildId, name.toLowerCase());
  return result.changes > 0;
}

export function getTag(guildId, name) {
  const row = db.prepare(
    'SELECT *, trigger AS name, created_by AS creator_id FROM custom_commands WHERE guild_id = ? AND trigger = ?'
  ).get(guildId, name) ?? null;
  return row;
}

export function listTags(guildId) {
  return db.prepare(
    'SELECT *, trigger AS name, created_by AS creator_id FROM custom_commands WHERE guild_id = ? ORDER BY trigger ASC'
  ).all(guildId);
}
