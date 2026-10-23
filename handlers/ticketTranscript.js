import db from '../db.js';
import { getTicketByChannel } from './ticketSystem/index.js';
import { isStaff } from './staffSystem.js';
import { renderTranscriptHTML } from '../utils/transcriptHtml.js';

const BLOO_PFP_URL = process.env.BLOO_PFP_URL || 'https://bloo-bot.xyz/assets/bloo-pfp.png';

// ─── Schema ───────────────────────────────────────────────────────────────────
// One-time migration: this table (and dashboard/routes/tickets.js's own
// separate CREATE TABLE for the same table) used to declare embeds/
// attachments as NOT NULL DEFAULT '[]'. captureMessage() below sends a
// real JS `null` for either on an ordinary text-only message (the common
// case, nothing to store), which is a NOT NULL violation, silently
// swallowed by `INSERT OR IGNORE` (SQLite's IGNORE conflict resolution
// suppresses ANY constraint failure, not just UNIQUE, so this never even
// threw). A prior pass already fixed the CREATE TABLE declaration to be
// nullable, but that's a no-op against a table that already exists on
// disk, so every install created before that fix kept the old NOT NULL
// shape and kept silently recording zero messages for every plain-text
// reply in every ticket, with no exception and no log line anywhere.
// SQLite can't ALTER COLUMN to drop a NOT NULL, so this rebuilds the table
// the same way ticket_cases's own CHECK-constraint migration does in
// ticketSystem/schema.js, preserving every existing row exactly as-is.
try {
  const cols = db.prepare(`PRAGMA table_info(ticket_messages)`).all();
  const embedsCol = cols.find(c => c.name === 'embeds');
  if (embedsCol?.notnull) {
    db.exec(`
      CREATE TABLE ticket_messages_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id      TEXT    NOT NULL,
        guild_id     TEXT    NOT NULL,
        channel_id   TEXT    NOT NULL,
        message_id   TEXT    NOT NULL,
        user_id      TEXT    NOT NULL,
        username     TEXT    NOT NULL,
        display_name TEXT,
        avatar_hash  TEXT,
        is_bot       INTEGER NOT NULL DEFAULT 0,
        content      TEXT    NOT NULL DEFAULT '',
        embeds       TEXT,
        attachments  TEXT,
        created_at   INTEGER NOT NULL
      );
      INSERT INTO ticket_messages_new
        (id, case_id, guild_id, channel_id, message_id, user_id, username,
         display_name, avatar_hash, is_bot, content, embeds, attachments, created_at)
        SELECT id, case_id, guild_id, channel_id, message_id, user_id, username,
               display_name, avatar_hash, is_bot, COALESCE(content, ''), embeds, attachments, created_at
        FROM ticket_messages;
      DROP TABLE ticket_messages;
      ALTER TABLE ticket_messages_new RENAME TO ticket_messages;
    `);
  }
} catch { /* table doesn't exist yet on a fresh install, CREATE TABLE below handles it */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS ticket_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id      TEXT    NOT NULL,
    guild_id     TEXT    NOT NULL,
    channel_id   TEXT    NOT NULL,
    message_id   TEXT    NOT NULL,
    user_id      TEXT    NOT NULL,
    username     TEXT    NOT NULL,
    display_name TEXT,
    avatar_hash  TEXT,
    is_bot       INTEGER NOT NULL DEFAULT 0,
    content      TEXT    NOT NULL DEFAULT '',
    embeds       TEXT,
    attachments  TEXT,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tm_case ON ticket_messages (case_id, created_at ASC);
`);
try { db.exec(`ALTER TABLE ticket_messages ADD COLUMN avatar_hash TEXT`); } catch { /* already exists */ }
// The INSERT below relies on "OR IGNORE" to skip a message already captured
// (a message can be seen twice via edit/backfill paths), but no constraint
// here ever enforced that until now, the CREATE TABLE has no UNIQUE on
// message_id (only dashboard/routes/tickets.js's separate declaration did),
// so on a table this file created first, "OR IGNORE" was a silent no-op and
// duplicates were possible. An index achieves the same effect as a column
// UNIQUE constraint without a table rebuild.
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tm_message_id ON ticket_messages (message_id)`); } catch { /* pre-existing duplicate rows, needs manual cleanup */ }

const stmts = {
  insert: db.prepare(`
    INSERT OR IGNORE INTO ticket_messages
      (case_id, guild_id, channel_id, message_id, user_id, username, display_name, is_bot, content, embeds, attachments, created_at, avatar_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  countByCase: db.prepare(`SELECT COUNT(*) AS n FROM ticket_messages WHERE case_id = ?`),
  deleteByCase: db.prepare(`DELETE FROM ticket_messages WHERE case_id = ?`),
  listByCase: db.prepare(`SELECT * FROM ticket_messages WHERE case_id = ? ORDER BY created_at ASC`),
  reassignCase: db.prepare(`UPDATE ticket_messages SET case_id = ? WHERE case_id = ?`),
};

// Called by ticketSystem/lifecycle.js's handleTicketRename when a ticket
// gets recategorised (case_id changes to a new category's sequence). Every
// message already captured under the old case_id would otherwise silently
// drop out of the transcript the moment the ticket's identity moves to the
// new one, this carries that history over so the transcript stays
// continuous across the change instead of appearing to start over.
export function reassignTranscript(oldCaseId, newCaseId) {
  return stmts.reassignCase.run(newCaseId, oldCaseId).changes;
}

// ─── captureMessage ───────────────────────────────────────────────────────────
export function captureMessage(message) {
  const channelId = message.channelId;
  if (!channelId) return;

  const ticket = getTicketByChannel(channelId);
  if (!ticket || ticket.status !== 'open') return;

  const userId  = message.author?.id ?? '0';
  const content = message.content ?? '';

  const embeds      = message.embeds?.length
    ? JSON.stringify(message.embeds)
    : null;
  // A gateway message keeps attachments in a Collection (.size, no .length),
  // a REST one in an array. Checking .length alone saved no attachments at
  // all from gateway messages, so transcripts lost every image and file.
  const attList = Array.isArray(message.attachments)
    ? message.attachments
    : [...(message.attachments?.values?.() ?? [])];
  const attachments = attList.length
    ? JSON.stringify(attList.map(a => ({ url: a.url ?? a, name: a.filename ?? null, size: a.size ?? null })))
    : null;

  try {
    stmts.insert.run(
      ticket.case_id,
      ticket.guild_id,
      channelId,
      message.id ?? String(Date.now()),
      userId,
      message.author?.username ?? 'Unknown',
      message.member?.nick ?? message.author?.global_name ?? null,
      message.author?.bot ? 1 : 0,
      content,
      embeds,
      attachments,
      Math.floor(Date.now() / 1000),
      message.author?.avatar ?? null,
    );
  } catch { /* non-fatal, duplicate message_id ignored by INSERT OR IGNORE */ }
}

// ─── flushTranscript ──────────────────────────────────────────────────────────
// Called by closeTicket before the channel is deleted. Since messages are
// written to the DB as they arrive, this is a no-op for data, it just returns
// the message count so the caller can log it.
export function flushTranscript(caseId) {
  return stmts.countByCase.get(caseId)?.n ?? 0;
}

// ─── generateFluxerTranscript ─────────────────────────────────────────────────
// Renders the same Fluxer/Discord-styled transcript the dashboard uses
// (utils/transcriptHtml.js), scoped for standalone DM delivery: only the
// ticket opener's and staff's messages are included (anyone else who ended up
// in the channel, e.g. a wrongly-added member, is left out of the record),
// the server icon bar shows this ticket's actual guild icon (or the bot's
// default avatar if the guild has none), and avatars/fallbacks use absolute
// URLs since the file has no origin to resolve relative paths against.
export async function generateFluxerTranscript(client, guildId, ticket) {
  const rawMessages = stmts.listByCase.all(ticket.case_id);

  const uniqueAuthors = [...new Set(rawMessages.map(m => m.user_id))];
  const staffIds = new Set();
  for (const userId of uniqueAuthors) {
    if (userId === ticket.user_id) continue;
    const staff = await isStaff(client, guildId, userId).catch(() => false);
    if (staff) staffIds.add(userId);
  }

  const filtered = rawMessages.filter(m => m.user_id === ticket.user_id || staffIds.has(m.user_id) || m.is_bot);

  // Prefer each participant's *current* avatar over whatever was captured at
  // message time, captured avatar_hash can be missing for messages recorded
  // before that column existed, or just stale if the user changed their
  // avatar since. A live fetch keeps every avatar consistent and populated.
  const participantIds = [...new Set(filtered.map(m => m.user_id))];
  const liveAvatars = new Map();
  await Promise.all(participantIds.map(async (userId) => {
    const user = await client.users.fetch(userId).catch(() => null);
    if (user) liveAvatars.set(userId, user.avatar ?? null);
  }));
  const messages = filtered.map(m => ({
    ...m,
    avatar_hash: liveAvatars.has(m.user_id) ? liveAvatars.get(m.user_id) : m.avatar_hash,
  }));

  const guild = client.guilds?.cache?.get(guildId)
             ?? await client.guilds.fetch(guildId).catch(() => null);

  return renderTranscriptHTML(ticket, messages, {
    guildName:        guild?.name ?? 'Support Server',
    guildIconUrl:     guild?.iconURL?.({ size: 128 }) ?? null,
    defaultAvatarUrl: BLOO_PFP_URL,
  });
}
