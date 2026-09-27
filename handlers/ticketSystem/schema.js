// ─── Ticket system schema ──────────────────────────────────────────────────────
// Table definitions, additive migrations, and the shared prepared-statement
// map used by the other files in this folder.

import db from '../../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS ticket_config (
    guild_id          TEXT PRIMARY KEY,
    channel_id        TEXT,
    panel_message_id  TEXT,
    support_role_id   TEXT,
    icon_url          TEXT,
    banner_url        TEXT,
    title             TEXT    NOT NULL DEFAULT 'Support Tickets',
    description       TEXT    NOT NULL DEFAULT 'React below to open a ticket.',
    category_id       TEXT,
    ticket_counter    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS ticket_options (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id         TEXT    NOT NULL,
    emoji            TEXT    NOT NULL,
    label            TEXT    NOT NULL,
    opening_message  TEXT,
    keyword          TEXT,
    position         INTEGER NOT NULL DEFAULT 0,
    support_role_id  TEXT,
    category_id      TEXT,
    enabled          INTEGER NOT NULL DEFAULT 1,
    disabled_message TEXT
  );

  CREATE TABLE IF NOT EXISTS ticket_cases (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     TEXT    NOT NULL,
    case_id      TEXT    NOT NULL UNIQUE,
    user_id      TEXT    NOT NULL,
    username     TEXT    NOT NULL,
    channel_id   TEXT,
    status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','creating','failed')),
    option_label TEXT,
    option_emoji TEXT,
    opened_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    closed_at    INTEGER,
    closed_by    TEXT,
    close_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS ticket_blacklist (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    reason   TEXT,
    added_by TEXT,
    added_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (guild_id, user_id)
  );
`);

// ─── Schema migrations ────────────────────────────────────────────────────────
// Rebuild ticket_cases if the status constraint is missing 'creating' and 'failed'.
// SQLite does not support ALTER TABLE to change CHECK constraints.
try {
  const colInfo = db.prepare(`PRAGMA table_info(ticket_cases)`).all();
  if (colInfo.length > 0) {
    const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'ticket_cases'`).get()?.sql ?? '';
    if (!schema.includes("'creating'")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ticket_cases_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id     TEXT    NOT NULL,
          case_id      TEXT    NOT NULL UNIQUE,
          user_id      TEXT    NOT NULL,
          username     TEXT    NOT NULL,
          channel_id   TEXT,
          status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','creating','failed')),
          option_label TEXT,
          option_emoji TEXT,
          opened_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          closed_at    INTEGER,
          closed_by    TEXT,
          close_reason TEXT,
          seq          INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO ticket_cases_new
          SELECT id, guild_id, case_id, user_id, username, channel_id,
                 CASE WHEN status IN ('open','closed','creating','failed') THEN status ELSE 'closed' END,
                 option_label, option_emoji, opened_at, closed_at, closed_by, close_reason,
                 COALESCE(seq, 0)
          FROM ticket_cases;
        DROP TABLE ticket_cases;
        ALTER TABLE ticket_cases_new RENAME TO ticket_cases;
      `);
    }
  }
} catch { /* table not yet created, CREATE TABLE above will handle it */ }

for (const col of [
  `ALTER TABLE ticket_cases ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ticket_config ADD COLUMN color INTEGER`,
  `ALTER TABLE ticket_blacklist ADD COLUMN reason TEXT`,
  `ALTER TABLE ticket_blacklist ADD COLUMN added_by TEXT`,
  `ALTER TABLE ticket_blacklist ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ticket_options ADD COLUMN keyword TEXT`,
  // Per-category routing: an option can override the guild-wide support
  // role and channel category, so e.g. "Partners" tickets can go to a
  // different staff role/channel group than "Support" ones. NULL means
  // "use the guild default", not "no role/no category", openTicket()
  // falls back to ticket_config's own columns when these are unset.
  `ALTER TABLE ticket_options ADD COLUMN support_role_id TEXT`,
  `ALTER TABLE ticket_options ADD COLUMN category_id TEXT`,
  // Per-guild emoji that closes a ticket when reacted, in place of typing
  // !close. NULL means "use the default ❌", stored in the same "name:id"
  // convention as ticket_options.emoji for custom emojis (converted from
  // the dashboard's <:name:id> display format at save time), or a raw
  // unicode glyph for a default emoji.
  `ALTER TABLE ticket_config ADD COLUMN close_emoji TEXT`,
  // Per-category on/off switch (e.g. temporarily closing "Partnerships"
  // without deleting the option) and an optional custom message DM'd to
  // whoever reacts while it's disabled, instead of opening a ticket.
  `ALTER TABLE ticket_options ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE ticket_options ADD COLUMN disabled_message TEXT`,
  // When set, this category's channel name skips the generic "ticket-"
  // label, e.g. "partner-0001" instead of "ticket-partner-0001", for
  // categories that don't read like a support request. Only affects the
  // channel name, not the internal case ID, which always keeps "Ticket-"
  // as its own separate identifier scheme.
  `ALTER TABLE ticket_options ADD COLUMN no_prefix INTEGER NOT NULL DEFAULT 0`,
  // Per-guild configurable delay before a closed ticket's channel gets
  // deleted, replacing the previous hardcoded 10s. Seconds, not ms, to
  // match how it's surfaced in commands/dashboard.
  `ALTER TABLE ticket_config ADD COLUMN close_delay_seconds INTEGER NOT NULL DEFAULT 10`,
  // When set, this closed ticket's channel is due for deletion at this unix
  // timestamp. A plain in-memory setTimeout doesn't survive a bot restart
  // within the delay window, the channel would just never get deleted,
  // this column plus deletionPoller.js's periodic sweep is the durable
  // fallback for exactly that case. Cleared back to NULL once the channel
  // is actually deleted (by whichever of the setTimeout or the poller gets
  // there first), channel_id itself is left alone for historical lookup.
  `ALTER TABLE ticket_cases ADD COLUMN delete_at INTEGER`,
]) { try { db.exec(col); } catch { /* already exists */ } }

// Best-effort atomic guard against two near-simultaneous ticket-open
// attempts from the same user racing past the explicit
// getOpenByUserOption/getCreatingByUserOption check in openTicket(). Scoped
// per-category (guild_id, user_id, option_label) rather than per-user-total,
// so a user can hold one open ticket per category simultaneously (e.g. one
// Support ticket and one Billing ticket at once) but not two of the same
// category. Note: SQLite treats each NULL as distinct in a unique index, so
// two option_label=NULL (no-category) tickets from the same user won't
// collide here, the explicit check in openTicket() is what actually catches
// that case. This can fail to create if pre-existing data already violates
// it; on an install where creation fails for that reason, this silently
// no-ops and openTicket()'s explicit check remains the sole guard, still
// correct for the overwhelmingly common case, just not fully race-proof
// until an admin resolves those specific pre-existing duplicates.
try {
  db.exec(`DROP INDEX IF EXISTS idx_ticket_one_active_per_user`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_one_active_per_user_category ON ticket_cases(guild_id, user_id, option_label) WHERE status IN ('open','creating')`);
} catch { /* pre-existing conflicting data, explicit check in openTicket() still guards */ }

// ─── Prepared statements ──────────────────────────────────────────────────────
export const stmts = {
  getConfig:    db.prepare(`SELECT * FROM ticket_config WHERE guild_id = ?`),
  ensureConfig: db.prepare(`INSERT OR IGNORE INTO ticket_config (guild_id) VALUES (?)`),
  setConfigField: (field) => db.prepare(
    `UPDATE ticket_config SET ${field} = ? WHERE guild_id = ?`
  ),

  getOptions:   db.prepare(`SELECT * FROM ticket_options WHERE guild_id = ? ORDER BY position ASC`),
  addOption:    db.prepare(`
    INSERT INTO ticket_options (guild_id, emoji, label, opening_message, keyword, position)
    VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM ticket_options WHERE guild_id = ?))
  `),
  removeOption: db.prepare(`DELETE FROM ticket_options WHERE id = ? AND guild_id = ?`),
  editOption:   db.prepare(`
    UPDATE ticket_options SET emoji = ?, label = ?, opening_message = ?, keyword = ?
    WHERE id = ? AND guild_id = ?
  `),
  setOptionRole:     db.prepare(`UPDATE ticket_options SET support_role_id = ? WHERE id = ? AND guild_id = ?`),
  setOptionCategory: db.prepare(`UPDATE ticket_options SET category_id = ? WHERE id = ? AND guild_id = ?`),
  setOptionEnabled:  db.prepare(`UPDATE ticket_options SET enabled = ? WHERE id = ? AND guild_id = ?`),
  setOptionDisabledMessage: db.prepare(`UPDATE ticket_options SET disabled_message = ? WHERE id = ? AND guild_id = ?`),
  setOptionNoPrefix: db.prepare(`UPDATE ticket_options SET no_prefix = ? WHERE id = ? AND guild_id = ?`),

  // Returns every case_id in the table. case_id is UNIQUE across ALL guilds
  // (ticket_messages and other lookups key on it without a guild filter), so
  // generateCaseId() scans globally per-category rather than per-guild to
  // pick the next sequence number, avoiding cross-guild collisions on the
  // new Ticket-{Category}-{####} format.
  getAllCaseIds: db.prepare(`
    SELECT case_id FROM ticket_cases
  `),
  insertCase: db.prepare(`
    INSERT INTO ticket_cases (guild_id, case_id, user_id, username, channel_id, option_label, option_emoji)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getCase:      db.prepare(`SELECT * FROM ticket_cases WHERE guild_id = ? AND case_id = ?`),
  getCaseByChannel: db.prepare(`SELECT * FROM ticket_cases WHERE channel_id = ?`),
  closeCase:    db.prepare(`
    UPDATE ticket_cases
    SET status = 'closed', closed_at = unixepoch(), closed_by = ?, close_reason = ?
    WHERE guild_id = ? AND case_id = ? AND status != 'closed'
  `),
  // delete_at cleared too: a ticket reopened inside its close delay kept the
  // pending deletion, so after a restart the poller deleted the new channel.
  reopenCase:   db.prepare(`
    UPDATE ticket_cases
    SET status = 'open', closed_at = NULL, closed_by = NULL, close_reason = NULL, channel_id = ?, delete_at = NULL
    WHERE guild_id = ? AND case_id = ?
  `),
  listOpen:     db.prepare(`SELECT * FROM ticket_cases WHERE guild_id = ? AND status = 'open'`),
  listAll:      db.prepare(`SELECT * FROM ticket_cases WHERE guild_id = ? ORDER BY opened_at DESC LIMIT 50`),
  // Short IDs like 'support-0003' match the tail of the full case id. Searches
  // every ticket in the guild (the old lookup only scanned the 50 newest).
  findByShortId: db.prepare(`
    SELECT * FROM ticket_cases
    WHERE guild_id = ? AND (case_id = ? OR case_id LIKE '%-' || ?)
    ORDER BY opened_at DESC LIMIT 1
  `),

  // Any open/creating ticket for this user, regardless of category. Used by
  // staff-facing lookup/repair tooling (lookup.js, ticketfix.js) that wants
  // "does this user have a ticket at all", not the per-category limiter.
  getOpenByUser:     db.prepare(`SELECT * FROM ticket_cases WHERE guild_id = ? AND user_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`),
  getCreatingByUser: db.prepare(`SELECT * FROM ticket_cases WHERE guild_id = ? AND user_id = ? AND status = 'creating' ORDER BY opened_at DESC LIMIT 1`),
  // Same as above but scoped to a specific category (option_label), used by
  // openTicket()'s actual one-per-category limiter. option_label IS ? (not
  // = ?) so a bound NULL still matches NULL rows correctly.
  getOpenByUserOption:     db.prepare(`SELECT * FROM ticket_cases WHERE guild_id = ? AND user_id = ? AND option_label IS ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`),
  getCreatingByUserOption: db.prepare(`SELECT * FROM ticket_cases WHERE guild_id = ? AND user_id = ? AND option_label IS ? AND status = 'creating' ORDER BY opened_at DESC LIMIT 1`),
  getByUser:         db.prepare(`SELECT * FROM ticket_cases WHERE guild_id = ? AND user_id = ? ORDER BY opened_at DESC LIMIT ?`),
  failCase:          db.prepare(`UPDATE ticket_cases SET status = 'failed', closed_at = unixepoch(), close_reason = ? WHERE case_id = ?`),

  // Atomic open-ticket guard: claimCase inserts with status='creating'
  // before any REST call happens, relying on idx_ticket_one_active_per_user
  // (below) to make "does this user already have one" a single atomic
  // insert instead of a separate check-then-create that two near-
  // simultaneous reactions could both slip through. activateCase promotes
  // a successful claim to 'open' once the channel actually exists.
  claimCase: db.prepare(`
    INSERT INTO ticket_cases (guild_id, case_id, user_id, username, status, option_label, option_emoji)
    VALUES (?, ?, ?, ?, 'creating', ?, ?)
  `),
  activateCase: db.prepare(`
    UPDATE ticket_cases SET status = 'open', channel_id = ? WHERE guild_id = ? AND case_id = ?
  `),

  // Used when a staff member manually renames a ticket's channel to match a
  // different option's keyword (e.g. ticket-partner-0001 -> ticket-support-),
  // detected by events/guild/channelUpdate.js. Reassigns the case to a fresh
  // case ID in the new category rather than just relabeling the old one, so
  // the sequence numbering stays correct per-category.
  recategorizeCase: db.prepare(`
    UPDATE ticket_cases SET case_id = ?, option_label = ?, option_emoji = ?
    WHERE guild_id = ? AND case_id = ?
  `),

  scheduleDelete: db.prepare(`UPDATE ticket_cases SET delete_at = ? WHERE id = ?`),
  clearDeleteSchedule: db.prepare(`UPDATE ticket_cases SET delete_at = NULL WHERE id = ?`),
  getDueForDeletion: db.prepare(`
    SELECT * FROM ticket_cases WHERE delete_at IS NOT NULL AND delete_at <= unixepoch() LIMIT 50
  `),

  isBlacklisted: db.prepare(`SELECT 1 FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?`),
  addBlacklist:  db.prepare(`
    INSERT INTO ticket_blacklist (guild_id, user_id, reason, added_by, added_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT (guild_id, user_id) DO UPDATE SET reason = excluded.reason, added_by = excluded.added_by, added_at = excluded.added_at
  `),
  removeBlacklist: db.prepare(`DELETE FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?`),
  listBlacklist: db.prepare(`SELECT * FROM ticket_blacklist WHERE guild_id = ?`),
};
