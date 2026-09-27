// ============================================================
//  handlers/aliasSystem.js
//
//  Per-guild command aliases. Staff can map a custom trigger
//  word to any existing bot command. The commandHandler checks
//  this table before looking up the command registry.
//
//  Table: guild_command_aliases
//    guild_id TEXT, alias TEXT, target TEXT, set_by TEXT, set_at INTEGER
//    PRIMARY KEY (guild_id, alias)
// ============================================================

import db from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_command_aliases (
    guild_id  TEXT    NOT NULL,
    alias     TEXT    NOT NULL,
    target    TEXT    NOT NULL,
    set_by    TEXT    NOT NULL,
    set_at    INTEGER NOT NULL,
    PRIMARY KEY (guild_id, alias)
  );
  CREATE INDEX IF NOT EXISTS idx_aliases_guild ON guild_command_aliases (guild_id);
`);

// ─── setAlias ─────────────────────────────────────────────────────────────────
// Create or overwrite an alias.
// Returns null on success, or an error string if validation fails.
export function setAlias(guildId, alias, target, setBy, commands = null) {
  alias  = alias.toLowerCase().trim();
  target = target.toLowerCase().trim();

  if (!/^[\w-]{1,32}$/.test(alias))  return 'Alias must be 1–32 alphanumeric/dash/underscore characters.';
  if (!/^[\w-]{1,32}$/.test(target)) return 'Target must be a valid command name (1–32 alphanumeric/dash/underscore).';
  if (alias === target)               return 'Alias cannot be the same as the target command.';

  // Prevent aliasing to another alias (only allow real commands)
  if (commands) {
    const cmd = commands.get(target);
    if (!cmd) return `\`${target}\` is not a recognised command.`;
  }

  // Prevent shadowing a real command with the alias trigger
  if (commands && commands.has(alias)) {
    return `\`${alias}\` is already a real command. Choose a different trigger.`;
  }

  // Max 50 aliases per guild
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM guild_command_aliases WHERE guild_id = ?'
  ).get(guildId).n;
  if (count >= 50) return 'This server has reached the maximum of 50 custom aliases.';

  db.prepare(`
    INSERT INTO guild_command_aliases (guild_id, alias, target, set_by, set_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, alias) DO UPDATE SET
      target = excluded.target,
      set_by = excluded.set_by,
      set_at = excluded.set_at
  `).run(guildId, alias, target, setBy, Date.now());

  return null; // success
}

// ─── removeAlias ─────────────────────────────────────────────────────────────
// Delete a single alias. Returns true if it existed.
export function removeAlias(guildId, alias) {
  const result = db.prepare(
    'DELETE FROM guild_command_aliases WHERE guild_id = ? AND alias = ?'
  ).run(guildId, alias.toLowerCase().trim());
  return result.changes > 0;
}

// ─── listAliases ─────────────────────────────────────────────────────────────
// Returns all aliases for a guild ordered alphabetically.
export function listAliases(guildId) {
  return db.prepare(
    'SELECT alias, target, set_by, set_at FROM guild_command_aliases WHERE guild_id = ? ORDER BY alias ASC'
  ).all(guildId);
}

// ─── clearAliases ────────────────────────────────────────────────────────────
// Remove all aliases for a guild. Returns count removed.
export function clearAliases(guildId) {
  return db.prepare(
    'DELETE FROM guild_command_aliases WHERE guild_id = ?'
  ).run(guildId).changes;
}

// ─── resolveAlias ────────────────────────────────────────────────────────────
// Returns the target command name for a given trigger, or null if no alias.
// Used by commandHandler.js to resolve aliases before command lookup.
export function resolveAlias(guildId, trigger) {
  const row = db.prepare(
    'SELECT target FROM guild_command_aliases WHERE guild_id = ? AND alias = ?'
  ).get(guildId, trigger.toLowerCase());
  return row?.target ?? null;
}
