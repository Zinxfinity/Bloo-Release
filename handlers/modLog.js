import db from '../db.js';
import logger from '../utils/logger.js';
import { Embed, COLORS } from '../config/embeds.js';
import { getModlogChannel, setModlogChannel } from './guildSettings.js';
import { handle as guardHandle, clear as guardClear } from './permissionGuard.js';
import { describeUser } from './messageLogger.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS modlog_cases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    case_number INTEGER NOT NULL,
    action      TEXT    NOT NULL,
    target_id   TEXT    NOT NULL,
    executor_id TEXT    NOT NULL,
    reason      TEXT,
    extra        TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (guild_id, case_number)
  );

  CREATE TABLE IF NOT EXISTS modlog_config (
    guild_id          TEXT PRIMARY KEY,
    log_joins         INTEGER NOT NULL DEFAULT 0,
    log_leaves        INTEGER NOT NULL DEFAULT 0,
    log_bans          INTEGER NOT NULL DEFAULT 0,
    log_kicks         INTEGER NOT NULL DEFAULT 0,
    log_mutes         INTEGER NOT NULL DEFAULT 0,
    log_warns         INTEGER NOT NULL DEFAULT 0,
    log_role_changes  INTEGER NOT NULL DEFAULT 0,
    log_nick_changes  INTEGER NOT NULL DEFAULT 0,
    log_msg_delete    INTEGER NOT NULL DEFAULT 0,
    log_msg_edit      INTEGER NOT NULL DEFAULT 0
  );
`);

// ─── Schema migrations, run before ANY db.prepare() call ────────────────────
for (const col of [
  `ALTER TABLE modlog_cases ADD COLUMN case_number INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE modlog_cases ADD COLUMN extra TEXT`,
  // 'detailed' (default, a card per case) or 'minimal' (one line per case).
  `ALTER TABLE modlog_config ADD COLUMN log_style TEXT NOT NULL DEFAULT 'detailed'`,
]) { try { db.exec(col); } catch { /* already exists */ } }

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  nextCase: db.prepare(`
    SELECT COALESCE(MAX(case_number), 0) + 1 AS next
    FROM modlog_cases WHERE guild_id = ?
  `),
  // created_at supplied explicitly rather than relying on the table's
  // DEFAULT (unixepoch()) clause, a live production modlog_cases table can
  // predate this file (CREATE TABLE IF NOT EXISTS never touches an already-
  // existing table) and have created_at as NOT NULL with no usable default,
  // confirmed via a real crash: NOT NULL constraint failed: modlog_cases.created_at.
  insertCase: db.prepare(`
    INSERT INTO modlog_cases (guild_id, case_number, action, target_id, executor_id, reason, extra, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
  `),
  getCase: db.prepare(`
    SELECT * FROM modlog_cases WHERE guild_id = ? AND case_number = ?
  `),
  listCases: db.prepare(`
    SELECT * FROM modlog_cases WHERE guild_id = ? AND target_id = ?
    ORDER BY case_number DESC LIMIT 20
  `),
  getConfig: db.prepare(`
    SELECT * FROM modlog_config WHERE guild_id = ?
  `),
  ensureConfig: db.prepare(`
    INSERT OR IGNORE INTO modlog_config (guild_id) VALUES (?)
  `),
};

// ─── Per-channel send queue ───────────────────────────────────────────────────
// Chains promises per channel so concurrent events don't race.
const sendQueues = new Map(); // Map<channelId, Promise>

function queueSend(channelId, fn) {
  const prev = sendQueues.get(channelId) ?? Promise.resolve();
  const next  = prev.then(fn).catch(() => {}); // individual failures don't break the chain
  sendQueues.set(channelId, next);
  // Prevent memory leak, clear resolved chain periodically
  next.finally(() => {
    if (sendQueues.get(channelId) === next) sendQueues.delete(channelId);
  });
  return next;
}

// ─── Retry send with exponential backoff ──────────────────────────────────────
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];

async function sendWithRetry(client, channelId, payload) {
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    try {
      // Raw REST, not client.channels.fetch() + channel.send(): confirmed
      // in production that pattern fails with "channel.send is not a
      // function" for at least one channel type on v2.0.1's SDK.
      return await client.rest.post(`/channels/${channelId}/messages`, { body: payload });
    } catch (err) {
      const isTimeout = err.message?.toLowerCase().includes('timeout')
                     || err.message?.toLowerCase().includes('gateway')
                     || err.code === 'ETIMEDOUT';
      if (!isTimeout || i === RETRY_DELAYS.length - 1) throw err;
      await new Promise(r => setTimeout(r, RETRY_DELAYS[i]));
    }
  }
}

// ─── Audit log executor fetch ─────────────────────────────────────────────────
const AUDIT_TRUST_WINDOW_MS = 15_000;
const AUDIT_RETRY_DELAYS    = [0, 1500, 3000];

async function fetchAuditExecutor(client, guildId, actionType, targetId) {
  for (const delay of AUDIT_RETRY_DELAYS) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    try {
      const entries = await client.rest.get(
        `/guilds/${guildId}/audit-logs?action_type=${actionType}&limit=5`
      );
      const logs = entries?.audit_log_entries ?? entries?.entries ?? [];
      const now  = Date.now();

      for (const entry of logs) {
        if (entry.target_id !== targetId) continue;
        const ts = snowflakeToMs(entry.id);
        if (now - ts <= AUDIT_TRUST_WINDOW_MS) {
          return entry.user_id ?? null;
        }
      }
    } catch { /* audit log fetch is best-effort */ }
  }
  return null;
}

function snowflakeToMs(id) {
  return Number(BigInt(id) >> 22n) + 1420070400000;
}

// ─── Code-block sanitising ─────────────────────────────────────────────────────
// Reason text is free-form user input and gets wrapped in a code block below.
// A reason containing its own ``` would otherwise close the fence early and
// let the rest of the string render as unformatted embed content (or open a
// new fence), breaking the modlog's layout. Splitting every backtick with a
// zero-width space defuses any run of backticks structurally while staying
// visually identical, since the zero-width space doesn't render.
// Written via fromCharCode rather than a literal character in this file,
// an invisible U+200B pasted directly into source is impossible to verify
// by reading the code and fragile against tools that strip invisible chars.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
function sanitizeForCodeBlock(text) {
  if (!text) return text;
  return String(text).replace(/`/g, '`' + ZERO_WIDTH_SPACE);
}

// ─── Mention sanitizing ───────────────────────────────────────────────────────
// Modlog fields must never contain a live user/role/channel mention, even a
// channel one (embeds render all three as the same special mention-styled
// text, not plain text, which reads as "tagging" regardless of whether it
// actually pings anyone). Every field that isn't free-form reason text (which
// stays inside a code block and can't render a mention anyway) gets passed
// through this before the embed is built, so no caller, current or future,
// has to remember to pre-format its own tags correctly.
const MENTION_RE = /<(@&|@!?|#)(\d+)>/g;

// Bare display name only (no id suffix), or null if unresolvable. `kind` is
// '@&' for a role, '#' for a channel, anything else ('@' or '@!') for a user.
async function fetchMentionName(client, guildId, kind, id, cache) {
  const cacheKey = `${kind === '#' ? '#' : kind === '@&' ? '@&' : '@'}:${id}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let name = null;
  try {
    if (kind === '#') {
      const ch = await client.channels.fetch(id).catch(() => null);
      name = ch?.name ? `#${ch.name}` : null;
    } else if (kind === '@&') {
      const roles = await client.rest.get(`/guilds/${guildId}/roles`).catch(() => []);
      name = (Array.isArray(roles) ? roles.find(r => r.id === id) : null)?.name ?? null;
    } else {
      const user = await client.rest.get(`/users/${id}`).catch(() => null);
      name = user?.username ?? null;
    }
  } catch { /* leave unresolved, cached as null so callers fall back to the id */ }

  cache.set(cacheKey, name);
  return name;
}

// Replaces every mention inside a string with "Name (`id`)", used for
// extraFields values that may run several mentions together (e.g. a
// space-separated list of role mentions). Safe on plain text with no
// mentions (returned unchanged) or non-string values (passed through as-is).
async function stripMentionsInline(client, guildId, text, cache) {
  if (typeof text !== 'string' || !text.includes('<')) return text;
  const matches = [...text.matchAll(MENTION_RE)];
  if (!matches.length) return text;

  let result = text;
  for (const [full, kind, id] of matches) {
    const name = await fetchMentionName(client, guildId, kind, id, cache);
    result = result.split(full).join(name ? `${name} (\`${id}\`)` : `\`${id}\``);
  }
  return result;
}

// Target/Executor: resolves to a bare display name (no id suffix, the caller
// wraps it in "name (`id`)" itself exactly once). Handles a caller passing a
// clean plain name already (used as-is), a caller passing a single raw
// mention instead of a name (unwrapped to just its resolved name, so the
// id doesn't end up doubled), or a caller passing nothing at all (falls back
// to a live user lookup so this never renders the literal string
// "undefined").
async function resolveDisplayName(client, guildId, id, rawTag, cache) {
  if (typeof rawTag === 'string' && rawTag.trim()) {
    // Some callers (sendModLog's shim already does this itself, but a
    // direct logAction() caller might not) pass an already-suffixed tag
    // like "<@&123> (`123`)" or "Name (`123`)". Strip that trailing suffix
    // first so it isn't left dangling in front of the outer field
    // template's own "(`id`)", and so the bare-mention check below actually
    // matches.
    rawTag = stripIdSuffix(rawTag.trim(), id);
    const soleMention = rawTag.trim().match(/^<(@&|@!?|#)(\d+)>$/);
    if (soleMention) {
      const name = await fetchMentionName(client, guildId, soleMention[1], soleMention[2], cache);
      return name ?? id;
    }
    // Not a bare mention. Shouldn't normally happen for target/executor, but
    // strip defensively in case one is embedded mid-string.
    return stripMentionsInline(client, guildId, rawTag, cache);
  }
  const name = await fetchMentionName(client, guildId, '@', id, cache);
  return name ?? id;
}

// ─── Action → color map ───────────────────────────────────────────────────────
const ACTION_COLORS = {
  ban:           COLORS.DANGER,
  unban:         COLORS.SUCCESS,
  kick:          COLORS.WARNING,
  mute:          COLORS.WARNING,
  unmute:        COLORS.SUCCESS,
  tempban:       COLORS.DANGER,
  warn:          COLORS.WARNING,
  'warn-remove': COLORS.INFO,
  softban:       COLORS.DANGER,
  hardban:       COLORS.DANGER,
  timeout:       COLORS.WARNING,
  'timeout-remove': COLORS.SUCCESS,
  'role-add':    COLORS.INFO,
  'role-remove': COLORS.INFO,
  'nick-change': COLORS.INFO,
  'msg-delete':  COLORS.MUTED,
  'msg-edit':    COLORS.MUTED,
  join:          COLORS.SUCCESS,
  leave:         COLORS.MUTED,
  massban:       COLORS.DANGER,
  note:          COLORS.INFO,
};

// ─── logAction ────────────────────────────────────────────────────────────────
/**
 * Record a mod action and post it to the guild's modlog channel.
 *
 * @param {object} opts
 * @param {import('@fluxerjs/core').Client} opts.client
 * @param {string}  opts.guildId
 * @param {string}  opts.action      , e.g. 'ban', 'kick', 'warn'
 * @param {string}  opts.targetId    , user being acted on
 * @param {string}  opts.targetTag   , display string for target
 * @param {string}  opts.executorId  , who did it
 * @param {string}  opts.executorTag , display string for executor
 * @param {string}  [opts.reason]
 * @param {string}  [opts.extra]     , JSON string for additional data
 * @param {object}  [opts.extraFields], additional embed fields { name, value, inline? }[]
 */

// Exported so callers that can't use the full logAction() (no live bot
// `client` to fetch/post the embed with, e.g. the dashboard process) can
// still record a case with a correctly-computed case_number instead of
// reimplementing this insert. Every case-recording call site, bot or
// dashboard, must go through this, guild_id+case_number is UNIQUE, a
// caller that guesses (or omits) case_number will throw on that guild's
// second case, not its first, since a stale/legacy row often already
// occupies case_number 0 or 1.
// Canonical action names. Commands and the dashboard used different labels
// for the same thing ('Member Banned' vs 'ban', 'TIMEOUT' vs 'Member Timed
// Out'), so filtering the dashboard modlog by "ban" missed half the bans.
const ACTION_ALIASES = {
  'member banned': 'ban', 'ban approved': 'ban', 'banned': 'ban',
  'member unbanned': 'unban',
  'member kicked': 'kick', 'kicked': 'kick',
  'warning issued': 'warn', 'warning': 'warn',
  'member timed out': 'timeout', 'timeout applied': 'timeout',
  'timeout removed': 'timeout-remove', 'timeout_remove': 'timeout-remove',
  'temp ban': 'tempban', 'temp-ban': 'tempban',
  'mass ban': 'massban',
};
export function normalizeAction(action) {
  const key = String(action ?? '').trim().toLowerCase();
  if (ACTION_ALIASES[key]) return ACTION_ALIASES[key];
  if (key in ACTION_COLORS || key === 'note' || key === 'massban') return key;
  return String(action ?? ''); // free-text labels (e.g. "Role Rule Added") stay as written
}

// One-time: rewrite existing rows to the canonical names. The WHERE makes it
// idempotent, a second run matches nothing.
try {
  const update = db.prepare('UPDATE modlog_cases SET action = ? WHERE lower(action) = ?');
  db.transaction(() => {
    for (const [from, to] of Object.entries(ACTION_ALIASES)) update.run(to, from);
    for (const k of [...Object.keys(ACTION_COLORS), 'note']) update.run(k, k);
  })();
} catch { /* modlog_cases not created yet */ }

export function recordCase(guildId, action, targetId, executorId, reason, extra) {
  action = normalizeAction(action);
  const { next: caseNumber } = stmts.nextCase.get(guildId);
  // extra is stored as a JSON string (column doc says so). better-sqlite3
  // treats a bare array as the *last* positional bind argument as shorthand
  // for "the remaining parameters as a batch", not as a literal value, an
  // empty array there silently contributes zero bound values, one short of
  // what the SQL needs, throwing "Too few parameter values were provided".
  // Stringify first so it's always a plain bindable value (or null).
  const extraValue = extra == null
    ? null
    : (typeof extra === 'string' ? extra : JSON.stringify(extra));
  stmts.insertCase.run(
    guildId, caseNumber, action,
    targetId, executorId,
    reason ?? null,
    extraValue,
  );
  return caseNumber;
}

export async function logAction({
  client,
  guildId,
  action,
  targetId,
  targetTag,
  executorId,
  executorTag,
  reason,
  extra,
  extraFields = [],
  color,
}) {
  action = normalizeAction(action);
  const caseNumber = recordCase(guildId, action, targetId, executorId, reason, extra);

  // Watched users: alert on any moderation action against them (this used to
  // fire only from !stripranks). Best-effort, never blocks the case post.
  if (client && targetId && /^\d{15,22}$/.test(String(targetId))) {
    import('./watchlist.js')
      .then(m => m.alertWatchlist(client, guildId, targetId, action, reason))
      .catch(() => {});
  }

  // ── Resolve modlog channel ────────────────────────────────────────────────
  const channelId = getModlogChannel(guildId);
  if (!channelId) return caseNumber;

  // ── Build embed ───────────────────────────────────────────────────────────
  // `color` lets a caller override the ACTION_COLORS lookup for an ad-hoc
  // action label that isn't one of the keys below (e.g. sendModLog's
  // shim callers use free-text titles like "Role Persist Enabled", which
  // never matched anything here, always silently falling back to blue).
  const resolvedColor = color ?? ACTION_COLORS[action] ?? COLORS.INFO;
  const label  = action.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const embed  = new (await import('@fluxerjs/core').then(m => m.EmbedBuilder))()
    .setColor(resolvedColor)
    .setTitle(`${label}, Case #${caseNumber}`)
    .setTimestamp();

  // Never tag the target/executor here, whether user, role, or channel,
  // this posts to a shared modlog channel, not a DM or the command's own
  // reply, and every mention type renders as the same special mention-styled
  // text regardless of whether it actually pings anyone. Displayable name
  // plus the raw ID (in inline code, so it can't be misread as a mention or
  // broken by markdown in the name) covers everything a moderator actually
  // needs from this field. Resolved here rather than trusted from the
  // caller, so no command has to remember to pre-format its own tag
  // correctly, and a caller that passes a raw mention (or nothing at all)
  // still ends up with a clean name instead of a live tag or "undefined".
  const mentionCache = new Map();
  const resolvedTargetTag   = await resolveDisplayName(client, guildId, targetId, targetTag, mentionCache);
  const resolvedExecutorTag = await resolveDisplayName(client, guildId, executorId, executorTag, mentionCache);
  const cleanedExtraFields  = [];
  for (const f of extraFields) {
    cleanedExtraFields.push({
      ...f,
      name:  await stripMentionsInline(client, guildId, f.name, mentionCache),
      value: await stripMentionsInline(client, guildId, f.value, mentionCache),
    });
  }

  // People are shown as username#0000 (id), so a case still identifies them
  // after they rename. Roles, channels or unknown IDs keep the resolved name.
  const userLabel = async (id, fallback) => {
    if (!/^\d{15,25}$/.test(String(id ?? ''))) return fallback;
    const u = await describeUser(client, guildId, id).catch(() => null);
    return u && u.tag !== 'Unknown user' ? u.tag : fallback;
  };
  const targetLabel   = await userLabel(targetId, resolvedTargetTag);
  const executorLabel = await userLabel(executorId, resolvedExecutorTag);

  // Minimal style: the whole case on one line, plain text.
  if ((getModlogConfig(guildId)?.log_style ?? 'detailed') === 'minimal') {
    const flat   = t => String(t ?? '').replace(/```/g, '').replace(/\s+/g, ' ').trim();
    const extras = cleanedExtraFields.map(f => `${flat(f.name)}: ${flat(f.value)}`).join(' · ');
    const line   = `**${label}** #${caseNumber} · ${targetLabel} (\`${targetId}\`) by ${executorLabel} (\`${executorId}\`)` +
      ` · ${flat(reason || 'No reason provided.')}${extras ? ` · ${extras}` : ''}`;
    queueSend(channelId, () =>
      sendWithRetry(client, channelId, { content: line.slice(0, 2000), allowed_mentions: { parse: [] } }).then(() => {
        guardClear('MODLOG', guildId);
      }).catch(err => {
        guardHandle('MODLOG', guildId, channelId, err, () => setModlogChannel(guildId, null));
        logger.warn(`[MODLOG] Failed to send case #${caseNumber} for guild ${guildId}:`, err.message);
      })
    );
    return caseNumber;
  }

  const fields = [
    { name: 'Target',   value: `${targetLabel} (\`${targetId}\`)`,   inline: true },
    { name: 'Executor', value: `${executorLabel} (\`${executorId}\`)`, inline: true },
    { name: 'Reason',   value: '```\n' + sanitizeForCodeBlock(reason || 'No reason provided.') + '\n```', inline: false },
    ...cleanedExtraFields,
  ];

  embed.addFields(...fields);

  // ── Queue send ────────────────────────────────────────────────────────────
  queueSend(channelId, () =>
    sendWithRetry(client, channelId, { embeds: [embed.toJSON()] }).then(() => {
      guardClear('MODLOG', guildId);
    }).catch(err => {
      guardHandle('MODLOG', guildId, channelId, err, () => setModlogChannel(guildId, null));
      logger.warn(`[MODLOG] Failed to send case #${caseNumber} for guild ${guildId}:`, err.message);
    })
  );

  return caseNumber;
}

// ─── getCase ──────────────────────────────────────────────────────────────────
export function getCase(guildId, caseNumber) {
  return stmts.getCase.get(guildId, caseNumber) ?? null;
}

// ─── getCaseHistory ───────────────────────────────────────────────────────────
export function getCaseHistory(guildId, targetId) {
  return stmts.listCases.all(guildId, targetId);
}

// ─── getModlogConfig ──────────────────────────────────────────────────────────
export function getModlogConfig(guildId) {
  stmts.ensureConfig.run(guildId);
  return stmts.getConfig.get(guildId);
}

// ─── setModlogFlag ────────────────────────────────────────────────────────────
export function setModlogStyle(guildId, style) {
  if (!['detailed', 'minimal'].includes(style)) throw new Error('Log style must be detailed or minimal.');
  stmts.ensureConfig.run(guildId);
  db.prepare('UPDATE modlog_config SET log_style = ? WHERE guild_id = ?').run(style, guildId);
}

const VALID_FLAGS = new Set([
  'log_joins', 'log_leaves', 'log_bans', 'log_kicks',
  'log_mutes', 'log_warns', 'log_role_changes',
  'log_nick_changes', 'log_msg_delete', 'log_msg_edit',
]);

export function setModlogFlag(guildId, flag, value) {
  if (!VALID_FLAGS.has(flag)) throw new Error(`Unknown modlog flag: ${flag}`);
  stmts.ensureConfig.run(guildId);
  db.prepare(`UPDATE modlog_config SET ${flag} = ? WHERE guild_id = ?`).run(value ? 1 : 0, guildId);
}

// ─── Re-export audit helper for handlers that need it ────────────────────────
export { fetchAuditExecutor, sanitizeForCodeBlock };

// ─── getCasesForUser ──────────────────────────────────────────────────────────
// Alias used by lookup.js, returns up to `limit` most recent cases for a user.
export function getCasesForUser(guildId, targetId, limit = 10) {
  return db.prepare(`
    SELECT * FROM modlog_cases WHERE guild_id = ? AND target_id = ?
    ORDER BY case_number DESC LIMIT ?
  `).all(guildId, targetId, limit);
}

// ─── getCasesByExecutor ───────────────────────────────────────────────────────
export function getCasesByExecutor(guildId, executorId, limit = 10) {
  return db.prepare(`
    SELECT * FROM modlog_cases WHERE guild_id = ? AND executor_id = ?
    ORDER BY case_number DESC LIMIT ?
  `).all(guildId, executorId, limit);
}

// ─── getCaseCount ─────────────────────────────────────────────────────────────
export function getCaseCount(guildId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM modlog_cases WHERE guild_id = ?`).get(guildId)?.n ?? 0;
}

// Color names this shim's callers pass (rolepersist.js, stripranks.js),
// mapped onto the real hex palette. logAction's own ACTION_COLORS is keyed
// on lowercase-hyphenated action strings like 'ban'/'role-add', which
// never matches these callers' free-text titles ('Role Rule Added' etc.),
// so their color was always silently discarded in favor of generic blue.
const COLOR_NAME_MAP = { orange: COLORS.WARNING, green: COLORS.SUCCESS, red: COLORS.DANGER, blue: COLORS.INFO };

// target/executor here are pre-formatted display strings that already
// include the ID, e.g. `<@&123> (\`123\`)`, this strips that suffix back
// off so logAction's own `${tag} (\`${id}\`)` formatting doesn't double it.
function stripIdSuffix(tag, id) {
  if (!tag || !id) return tag;
  const suffix = ` (\`${id}\`)`;
  return tag.endsWith(suffix) ? tag.slice(0, -suffix.length) : tag;
}

// ─── sendModLog ───────────────────────────────────────────────────────────────
// Compatibility shim used by stripranks.js and similar commands that call
// sendModLog(client, guildId, { action, color, target, targetId, executorId,
//            executor, reason, fields[] }).
// Maps to the canonical logAction() call. Previously dropped `target`
// entirely and never destructured `executor` at all, so every case logged
// through this shim rendered "undefined" for both the Target and Executor
// fields; `fields` was routed to `extra` (a DB-only JSON column nothing
// displays) instead of `extraFields` (what actually renders in the
// embed); and `color` was accepted but never forwarded, always rendering
// generic blue regardless of what the caller asked for.
export async function sendModLog(client, guildId, {
  action, target, targetId, executor, executorId, reason = 'No reason provided', fields = [], color,
} = {}) {
  return logAction({
    client, guildId, action, targetId, executorId,
    targetTag: stripIdSuffix(target, targetId) ?? 'Unknown',
    executorTag: stripIdSuffix(executor, executorId) ?? 'Unknown',
    reason,
    extraFields: fields,
    color: COLOR_NAME_MAP[color] ?? color,
  });
}
