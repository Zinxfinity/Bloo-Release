import db from '../db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from '@fluxerjs/core';
import { getCachedMemberCount, updateMemberCount } from './memberCountSync.js';
import { autoroleWaitsForVerification } from './autoroleGate.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
// Schema ownership consolidation: this file and dashboard/routes/welcome.js
// used to each declare their own, differently-named copy of this table
// (welcome_channel here vs welcome_channel_id there). Checked the real
// database rather than assuming either side is ground truth: the live table
// already has welcome_channel_id/goodbye_channel_id, meaning the dashboard's
// naming is what's actually deployed, and this file's own setWelcomeField()
// calls (from !welcome channel) have been throwing "no such column:
// welcome_channel" against it. Consolidating on the dashboard's real,
// working names; a fresh bot-only install that never saw the dashboard
// would still have the old welcome_channel/goodbye_channel names, migrated
// below.
export function ensureWelcomeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS welcome_config (
      guild_id            TEXT PRIMARY KEY,
      welcome_enabled     INTEGER NOT NULL DEFAULT 0,
      welcome_channel_id  TEXT,
      welcome_message     TEXT    NOT NULL DEFAULT 'Welcome {user} to {server}!',
      goodbye_enabled     INTEGER NOT NULL DEFAULT 0,
      goodbye_channel_id  TEXT,
      goodbye_message     TEXT    NOT NULL DEFAULT 'Goodbye {username}.',
      dm_enabled          INTEGER NOT NULL DEFAULT 0,
      dm_message          TEXT,
      autorole_id         TEXT,
      autorole_enabled    INTEGER NOT NULL DEFAULT 0,
      autorole_bot        INTEGER NOT NULL DEFAULT 0,
      updated_at          INTEGER NOT NULL DEFAULT 0
    )
  `);

  for (const col of [
    `ALTER TABLE welcome_config ADD COLUMN dm_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE welcome_config ADD COLUMN dm_message TEXT`,
    `ALTER TABLE welcome_config ADD COLUMN autorole_id TEXT`,
    `ALTER TABLE welcome_config ADD COLUMN autorole_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE welcome_config ADD COLUMN autorole_bot INTEGER NOT NULL DEFAULT 0`,
    // Dashboard-only embed styling, this file's own message-send logic
    // doesn't read these, they exist so the dashboard has somewhere real
    // to persist them instead of a second table declaration.
    `ALTER TABLE welcome_config ADD COLUMN welcome_embed INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE welcome_config ADD COLUMN welcome_color TEXT NOT NULL DEFAULT '#5865F2'`,
    `ALTER TABLE welcome_config ADD COLUMN goodbye_embed INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE welcome_config ADD COLUMN goodbye_color TEXT NOT NULL DEFAULT '#ED4245'`,
    // setField() below always touches this; the live table predates it.
    `ALTER TABLE welcome_config ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
  ]) {
    try { db.exec(col); } catch { /* column already exists */ }
  }

  const cols = db.prepare(`PRAGMA table_info(welcome_config)`).all().map(c => c.name);
  if (cols.includes('welcome_channel') && !cols.includes('welcome_channel_id')) {
    try { db.exec('ALTER TABLE welcome_config RENAME COLUMN welcome_channel TO welcome_channel_id'); } catch { /* already renamed */ }
  }
  if (cols.includes('goodbye_channel') && !cols.includes('goodbye_channel_id')) {
    try { db.exec('ALTER TABLE welcome_config RENAME COLUMN goodbye_channel TO goodbye_channel_id'); } catch { /* already renamed */ }
  }
}
ensureWelcomeSchema(db);

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  get: db.prepare(`SELECT * FROM welcome_config WHERE guild_id = ?`),
  ensure: db.prepare(`INSERT OR IGNORE INTO welcome_config (guild_id) VALUES (?)`),
  setField: (field) => db.prepare(
    `UPDATE welcome_config SET ${field} = ?, updated_at = unixepoch() WHERE guild_id = ?`
  ),
};

// ─── Placeholder resolver ─────────────────────────────────────────────────────
// {mention} is an alias for {user}, both produce a real <@id> mention.
// Neither the dashboard nor !welcome ever documented which token names are
// valid, so a template using the very reasonable guess {mention} silently
// passed straight through unresolved instead of being replaced.
function resolvePlaceholders(template, member, guild, memberCount = '?') {
  const username    = member.user?.username      ?? member.user?.globalName ?? 'Unknown';
  const displayName = member.displayName         ?? username;
  const serverName  = guild?.name                ?? 'this server';
  const mention     = `<@${member.user?.id ?? member.id}>`;

  return template
    .replace(/{user}/g,        mention)
    .replace(/{mention}/g,     mention)
    .replace(/{username}/g,    username)
    .replace(/{displayname}/g, displayName)
    .replace(/{server}/g,      serverName)
    .replace(/{membercount}/g, String(memberCount));
}

// Cache-first: handlers/memberCountSync.js already keeps a per-guild count
// synced (on ready, every 30 min, or via !reseedcount), reading it is a
// synchronous DB lookup, no REST round-trip on every single join/leave.
// Only falls back to a live REST attempt when that cache is still empty
// (guild never synced yet). That live attempt itself isn't fully reliable:
// checked @fluxerjs/core's own type definitions, there's no
// approximate_member_count field or with_counts param anywhere in them,
// that's a Discord API convention that got carried over here without ever
// being verified against Fluxer's real behavior, which is why
// {membercount} kept showing its literal '?' fallback even after
// confirming this exact REST call was live and running. A successful live
// count still gets written back to the cache so later joins in that guild
// hit the fast synchronous path instead of repeating the same gamble.
async function resolveMemberCount(client, guildId) {
  const cached = getCachedMemberCount(guildId);
  if (cached) return cached;

  try {
    const data = await client.rest.get(`/guilds/${guildId}?with_counts=true`);
    const count = data?.approximate_member_count;
    if (count) {
      updateMemberCount(guildId, count);
      return count;
    }
  } catch { /* fall through to '?' below */ }

  return '?';
}

function hexToInt(hex) {
  const n = parseInt(String(hex ?? '').replace(/^#/, ''), 16);
  return isNaN(n) ? null : n;
}

// Builds either a plain-content payload or a real embed payload depending
// on the guild's embed toggle, previously welcome_embed/welcome_color
// (and the goodbye equivalents) were saved by the dashboard but never
// actually read here, the message always sent as plain text regardless.
function buildMessagePayload(text, embedOn, color) {
  if (!embedOn) return { content: text };
  const embed = new EmbedBuilder().setDescription(text);
  const colorInt = hexToInt(color);
  if (colorInt != null) embed.setColor(colorInt);
  return { embeds: [embed.toJSON()] };
}

// ─── getConfig ────────────────────────────────────────────────────────────────
export function getWelcomeConfig(guildId) {
  stmts.ensure.run(guildId);
  return stmts.get.get(guildId);
}

// ─── setField ─────────────────────────────────────────────────────────────────
// Valid fields: welcome_enabled, welcome_channel_id, welcome_message,
//               goodbye_enabled, goodbye_channel_id, goodbye_message,
//               dm_enabled, dm_message, autorole_id
export function setWelcomeField(guildId, field, value) {
  const allowed = [
    'welcome_enabled', 'welcome_channel_id', 'welcome_message',
    'goodbye_enabled', 'goodbye_channel_id', 'goodbye_message',
    'dm_enabled', 'dm_message', 'autorole_id', 'autorole_enabled',
  ];
  if (!allowed.includes(field)) throw new Error(`Unknown welcome config field: ${field}`);
  stmts.ensure.run(guildId);
  stmts.setField(field).run(value, guildId);
}

// ─── sendWelcome ──────────────────────────────────────────────────────────────
// skipAutorole: used by `!welcome test` so the person testing doesn't get
// the join role granted to them.
export async function sendWelcome(client, member, { skipAutorole = false } = {}) {
  // Guard: member.user may be null on partial objects
  if (!member?.user?.id && !member?.id) return;

  const guildId = member.guild?.id ?? member.guildId;
  if (!guildId) return;

  const config = getWelcomeConfig(guildId);
  if (!config) return;

  const guild = member.guild
    ?? client.guilds?.cache?.get(guildId)
    ?? await client.guilds.fetch(guildId).catch(() => null);

  // Only pay for the extra REST call when a configured template actually
  // uses {membercount}, most guilds' welcome/DM text won't reference it.
  const needsCount = (config.welcome_message ?? '').includes('{membercount}')
                   || (config.dm_message ?? '').includes('{membercount}');
  const memberCount = needsCount ? await resolveMemberCount(client, guildId) : '?';

  // ── Channel welcome message ───────────────────────────────────────────────
  if (config.welcome_enabled && config.welcome_channel_id) {
    // Raw REST, not client.channels.fetch() + channel.send(): confirmed in
    // production that pattern fails with "channel.send is not a function"
    // for at least one channel type on v2.0.1's SDK.
    const text = resolvePlaceholders(config.welcome_message, member, guild, memberCount);
    await client.rest.post(`/channels/${config.welcome_channel_id}/messages`, {
      body: buildMessagePayload(text, config.welcome_embed, config.welcome_color),
    }).catch(err =>
      logger.warn(`[WELCOME] Failed to send welcome message in ${guildId}:`, err.message)
    );
  }

  // ── DM welcome ────────────────────────────────────────────────────────────
  if (config.dm_enabled && config.dm_message) {
    const text = resolvePlaceholders(config.dm_message, member, guild, memberCount);
    try {
      const dm = await member.user?.createDM?.().catch(() => null)
              ?? await client.users.fetch(member.user?.id ?? member.id)
                         .then(u => u.createDM?.()).catch(() => null);
      if (dm) await dm.send({ content: text });
    } catch { /* DMs may be closed */ }
  }

  // ── Auto-role ─────────────────────────────────────────────────────────────
  // autorole_enabled was never actually checked here, only whether a role
  // id happened to be set, so the role got applied on every join regardless
  // of the master toggle. autorole_bot (whether bot accounts should also get
  // it, usually left off) was never checked either, no bot/human
  // distinction existed at all, so bots always got it too.
  if (!skipAutorole && config.autorole_enabled && config.autorole_id) {
    const isBot = member.user?.bot ?? member.bot ?? false;
    // With verification on, humans get it once they pass (handlers/autoroleGate.js).
    if ((!isBot || config.autorole_bot) && !autoroleWaitsForVerification(db, guildId, isBot)) {
      try {
        await client.rest.put(
          `/guilds/${guildId}/members/${member.user?.id ?? member.id}/roles/${config.autorole_id}`
        );
      } catch (err) {
        logger.warn(`[WELCOME] Failed to assign autorole in ${guildId}:`, err.message);
      }
    }
  }
}

// ─── sendGoodbye ──────────────────────────────────────────────────────────────
export async function sendGoodbye(client, member) {
  if (!member?.user?.id && !member?.id) return;

  const guildId = member.guild?.id ?? member.guildId;
  if (!guildId) return;

  const config = getWelcomeConfig(guildId);
  if (!config?.goodbye_enabled || !config.goodbye_channel_id) return;

  const guild = member.guild
    ?? client.guilds?.cache?.get(guildId)
    ?? await client.guilds.fetch(guildId).catch(() => null);

  const memberCount = (config.goodbye_message ?? '').includes('{membercount}')
    ? await resolveMemberCount(client, guildId)
    : '?';
  const text = resolvePlaceholders(config.goodbye_message, member, guild, memberCount);
  // Raw REST, not client.channels.fetch() + channel.send(): confirmed in
  // production that pattern fails with "channel.send is not a function"
  // for at least one channel type on v2.0.1's SDK.
  await client.rest.post(`/channels/${config.goodbye_channel_id}/messages`, {
    body: buildMessagePayload(text, config.goodbye_embed, config.goodbye_color),
  }).catch(err =>
    logger.warn(`[GOODBYE] Failed to send goodbye message in ${guildId}:`, err.message)
  );
}
