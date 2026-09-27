import db from '../db.js';
import { isStaff } from './staffSystem.js';
import logger from '../utils/logger.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS word_blacklist (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT    NOT NULL,
    word     TEXT    NOT NULL,
    added_by TEXT,
    added_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (guild_id, word)
  );

  CREATE TABLE IF NOT EXISTS word_blacklist_config (
    guild_id         TEXT PRIMARY KEY,
    enabled          INTEGER NOT NULL DEFAULT 0,
    action           TEXT    NOT NULL DEFAULT 'delete',
    log_channel_id   TEXT,
    exempt_roles     TEXT    NOT NULL DEFAULT '[]',
    exempt_channels  TEXT    NOT NULL DEFAULT '[]',
    scan_messages    INTEGER NOT NULL DEFAULT 1,
    scan_edited      INTEGER NOT NULL DEFAULT 1,
    scan_deleted     INTEGER NOT NULL DEFAULT 0,
    scan_names       INTEGER NOT NULL DEFAULT 0,
    silent           INTEGER NOT NULL DEFAULT 0
  );
`);

// word_blacklist.added_at is NOT NULL on the live table with no default
// (this CREATE TABLE's own default is a no-op against it), and the
// scan_*/silent columns below didn't exist in this file's declaration at
// all before, only in dashboard/routes/wordfilter.js's separate copy.
// `!wordfilter set silent|scan-messages|scan-edited|scan-deleted|scan-names`
// all threw "Unknown word filter field" because setWordFilterField's
// allowlist never included them either (fixed below).
for (const col of [
  `ALTER TABLE word_blacklist ADD COLUMN added_by TEXT`,
  // SQLite rejects a non-constant default like (unixepoch()) on ADD COLUMN,
  // so this ALTER used to fail silently and leave added_at missing; addWord
  // always supplies the value, the 0 only backfills pre-existing rows.
  `ALTER TABLE word_blacklist ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE word_blacklist_config ADD COLUMN scan_messages INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE word_blacklist_config ADD COLUMN scan_edited INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE word_blacklist_config ADD COLUMN scan_deleted INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE word_blacklist_config ADD COLUMN scan_names INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE word_blacklist_config ADD COLUMN silent INTEGER NOT NULL DEFAULT 0`,
]) {
  try { db.exec(col); } catch { /* already exists */ }
}

const stmts = {
  getConfig:    db.prepare(`SELECT * FROM word_blacklist_config WHERE guild_id = ?`),
  ensureConfig: db.prepare(`INSERT OR IGNORE INTO word_blacklist_config (guild_id) VALUES (?)`),
  setField:     (field) => db.prepare(
    `UPDATE word_blacklist_config SET ${field} = ? WHERE guild_id = ?`
  ),
  getWords:  db.prepare(`SELECT word FROM word_blacklist WHERE guild_id = ?`),
  // added_at supplied explicitly: the live table's added_at is NOT NULL
  // with no default, and INSERT OR IGNORE's conflict resolution silently
  // swallows NOT NULL violations exactly like it does UNIQUE ones, so
  // omitting it here meant every single new word "failed" with changes=0
  // and no error, indistinguishable from "word already exists". Every
  // guild's blacklist was effectively frozen, unable to ever gain a word,
  // while reporting success/already-exists instead of the real cause.
  addWord:   db.prepare(`INSERT OR IGNORE INTO word_blacklist (guild_id, word, added_by, added_at) VALUES (?, ?, ?, unixepoch())`),
  removeWord: db.prepare(`DELETE FROM word_blacklist WHERE guild_id = ? AND word = ?`),
  clearWords: db.prepare(`DELETE FROM word_blacklist WHERE guild_id = ?`),
};

// ─── Word list cache per guild ────────────────────────────────────────────────
// The dashboard edits word_blacklist from its own process, so in-process
// invalidation alone never saw those changes (dashboard adds/removes only took
// effect after a bot restart). Each lookup compares a cheap signature (row
// count + highest rowid, served by the (guild_id, word) index) and rebuilds
// the pattern when it moved.
const wordCache = new Map(); // Map<guildId, { sig, pattern: RegExp | null }>
const sigStmt = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m FROM word_blacklist WHERE guild_id = ?`);

function getPattern(guildId) {
  const s = sigStmt.get(guildId);
  const sig = `${s.n}:${s.m}`;
  const hit = wordCache.get(guildId);
  if (hit && hit.sig === sig) return hit.pattern;

  const words = stmts.getWords.all(guildId).map(r => r.word);
  let pattern = null;
  if (words.length) {
    const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    pattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'i');
  }
  wordCache.set(guildId, { sig, pattern });
  return pattern;
}

function invalidateCache(guildId) {
  wordCache.delete(guildId);
}

// ─── Config ───────────────────────────────────────────────────────────────────
export function getWordFilterConfig(guildId) {
  stmts.ensureConfig.run(guildId);
  return stmts.getConfig.get(guildId);
}

export function setWordFilterField(guildId, field, value) {
  const allowed = [
    'enabled', 'action', 'log_channel_id', 'exempt_roles', 'exempt_channels',
    'scan_messages', 'scan_edited', 'scan_deleted', 'scan_names', 'silent',
  ];
  if (!allowed.includes(field)) throw new Error(`Unknown word filter field: ${field}`);
  stmts.ensureConfig.run(guildId);
  stmts.setField(field).run(value, guildId);
}

export function addWord(guildId, word, addedBy = null) {
  const { changes } = stmts.addWord.run(guildId, word.toLowerCase().trim(), addedBy);
  invalidateCache(guildId);
  return changes > 0;
}

export function removeWord(guildId, word) {
  const { changes } = stmts.removeWord.run(guildId, word.toLowerCase().trim());
  invalidateCache(guildId);
  return changes > 0;
}

export function clearWords(guildId) {
  const { changes } = stmts.clearWords.run(guildId);
  invalidateCache(guildId);
  return changes;
}

export function listWords(guildId) {
  return stmts.getWords.all(guildId).map(r => r.word);
}

// ─── runWordFilter ────────────────────────────────────────────────────────────
/**
 * Check a message for blacklisted words.
 * Returns true if message was acted upon (blocked).
 */
export async function runWordFilter(client, message, guildIdOverride, { edited = false } = {}) {
  const guildId   = guildIdOverride ?? message.guildId;
  const channelId = message.channelId;
  const userId    = message.author?.id;
  if (!guildId || !userId) return false;

  const config = getWordFilterConfig(guildId);
  if (!config?.enabled) return false;
  if (edited ? !config.scan_edited : !config.scan_messages) return false;

  // Staff exempt
  if (await isStaff(client, guildId, userId)) return false;

  // Channel exempt
  let exemptChannels = [];
  try { exemptChannels = JSON.parse(config.exempt_channels || '[]'); } catch { /* malformed config */ }
  if (exemptChannels.includes(channelId)) return false;

  // Role exempt, check member roles
  let exemptRoles = [];
  try { exemptRoles = JSON.parse(config.exempt_roles || '[]'); } catch { /* malformed config */ }
  if (exemptRoles.length) {
    const member = message.member;
    const roleIds = member?.roles?.roleIds
      ?? member?.roles?.cache?.keys?.()
      ?? (Array.isArray(member?.roles) ? member.roles : []);
    if ([...roleIds].some(id => exemptRoles.includes(id))) return false;
  }

  const pattern = getPattern(guildId);
  if (!pattern) return false;

  if (!pattern.test(message.content ?? '')) return false;

  // Act
  markFilterDeleted(message.id);
  try { await message.delete(); } catch { /* message may be gone */ }

  await applyWordFilterAction(client, message, config);
  await sendWordFilterLog(client, guildId, userId, message.content, channelId, config);

  // Silent mode off means the member gets a short in-channel notice.
  if (!config.silent) {
    await client.rest.post(`/channels/${channelId}/messages`, {
      body: {
        content: `⚠️ <@${userId}>, your message was removed because it contained a blocked word.`,
        allowed_mentions: { parse: [], users: [userId] },
      },
    }).catch(() => {});
  }

  return true;
}

// ─── Deleted-message scan (scan_deleted) ───────────────────────────────────────
// Catches blocked words posted and then deleted before anyone saw them: when
// a cached message is deleted and it contained a blocked word, it's logged to
// the filter's log channel. Messages the filter removed itself are skipped.
const filterDeleted = new Set();
function markFilterDeleted(id) {
  if (!id) return;
  filterDeleted.add(id);
  setTimeout(() => filterDeleted.delete(id), 60_000).unref?.();
}

export async function scanDeletedMessage(client, message, guildId) {
  if (!message?.content || message.author?.bot || filterDeleted.has(message.id)) return;
  const config = getWordFilterConfig(guildId);
  if (!config?.enabled || !config.scan_deleted) return;
  const pattern = getPattern(guildId);
  if (!pattern?.test(message.content)) return;
  await sendWordFilterLog(client, guildId, message.author?.id ?? 'unknown', message.content, message.channelId, config, '(deleted by the author)');
}

// ─── runWordFilterOnName ──────────────────────────────────────────────────────
/**
 * Check a display name / nickname on join or update.
 * Does not return a boolean, actions are best-effort.
 */
export async function runWordFilterOnName(client, guildId, userId, name) {
  const config = getWordFilterConfig(guildId);
  if (!config?.enabled || !config.scan_names || !name) return;

  const pattern = getPattern(guildId);
  if (!pattern || !pattern.test(name)) return;

  // Best-effort: nickname the member to something clean
  try {
    await client.rest.patch(`/guilds/${guildId}/members/${userId}`, {
      body: { nick: '[filtered]' },
    });
  } catch { /* we may not have permission, non-fatal */ }
}

async function applyWordFilterAction(client, message, config) {
  const action  = config.action ?? 'delete';
  const guildId = message.guildId;
  const userId  = message.author?.id;

  if (action === 'delete') return; // already deleted above

  try {
    const { autoWarn, recordAutoCase } = await import('./autoModCase.js');
    const user = { id: userId, username: message.author?.username };
    if (action === 'warn') {
      await autoWarn(client, guildId, user, 'Word filter violation', 'Word filter');
    } else if (action === 'mute') {
      const until = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await client.rest.patch(`/guilds/${guildId}/members/${userId}`, {
        body: { communication_disabled_until: until },
      });
      await recordAutoCase(client, guildId, user, 'mute', 'Word filter violation', 'Word filter', [{ name: 'Duration', value: '10m', inline: true }]);
    }
  } catch (err) {
    logger.warn(`[WORDFILTER] Action ${action} failed for ${userId} in ${guildId}:`, err.message);
  }
}

async function sendWordFilterLog(client, guildId, userId, content, channelId, config, note = '') {
  if (!config.log_channel_id) return;
  try {
    // Raw REST, not client.channels.fetch() + channel.send(): confirmed in
    // production that pattern fails with "channel.send is not a function"
    // for at least one channel type on v2.0.1's SDK.
    await client.rest.post(`/channels/${config.log_channel_id}/messages`, {
      body: {
        content: `🚫 **Word filter triggered**${note ? ` ${note}` : ''}, <@${userId}> in <#${channelId}>\n> ${(content ?? '').slice(0, 500)}`,
        allowed_mentions: { parse: [] },
      },
    });
  } catch { /* non-fatal */ }
}
