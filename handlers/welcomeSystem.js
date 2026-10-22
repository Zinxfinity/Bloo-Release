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
    // Welcome card: an image with the member's avatar and two optional lines.
    `ALTER TABLE welcome_config ADD COLUMN welcome_card INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE welcome_config ADD COLUMN card_theme TEXT NOT NULL DEFAULT 'bloo'`,
    `ALTER TABLE welcome_config ADD COLUMN card_title TEXT NOT NULL DEFAULT 'Welcome, {name}!'`,
    `ALTER TABLE welcome_config ADD COLUMN card_subtitle TEXT NOT NULL DEFAULT 'You are member #{count} of {server}'`,
    // Custom cards (handlers/welcomeBackgrounds.js): theme | server | custom,
    // optional colours over the theme, and who uploaded the custom image.
    `ALTER TABLE welcome_config ADD COLUMN card_background TEXT NOT NULL DEFAULT 'theme'`,
    `ALTER TABLE welcome_config ADD COLUMN card_accent TEXT`,
    `ALTER TABLE welcome_config ADD COLUMN card_title_color TEXT`,
    `ALTER TABLE welcome_config ADD COLUMN card_subtitle_color TEXT`,
    `ALTER TABLE welcome_config ADD COLUMN card_upload_by TEXT`,
    `ALTER TABLE welcome_config ADD COLUMN card_upload_at INTEGER`,
    `ALTER TABLE welcome_config ADD COLUMN card_upload_guild_name TEXT`,
    // Goodbye card: same look as the welcome card, its own two lines.
    `ALTER TABLE welcome_config ADD COLUMN goodbye_card INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE welcome_config ADD COLUMN goodbye_card_title TEXT NOT NULL DEFAULT 'Goodbye, {name}'`,
    `ALTER TABLE welcome_config ADD COLUMN goodbye_card_subtitle TEXT NOT NULL DEFAULT 'We now have {count} members'`,
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
// {name} is the display name, {count} the member count with thousands
// separators (1,234) and {ordinal} the same as a place (1,234th).
// asText: for the welcome card image, where a mention can't render, so
// {user}/{mention} become the display name instead.
export const PLACEHOLDERS = ['{user}', '{mention}', '{name}', '{username}', '{displayname}', '{server}', '{count}', '{membercount}', '{ordinal}'];
function formatCount(n) {
  const num = Number(n);
  return Number.isFinite(num) ? num.toLocaleString('en-US') : String(n);
}
function ordinal(n) {
  const num = Number(n);
  // Count not known yet: "our newest member" still reads right.
  if (!Number.isFinite(num) || num <= 0) return 'newest';
  const tens = num % 100, ones = num % 10;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th';
  return formatCount(num) + suffix;
}
// A name with nothing visible in it: empty, or only invisible or unassigned
// characters (some people use one, like U+1CBC, to look nameless).
const isVisible = s => /[^\p{Cf}\p{Cn}\p{Co}\p{Cc}\s]/u.test(String(s ?? ''));

export function resolvePlaceholders(template, member, guild, memberCount = '?', { asText = false } = {}) {
  const username    = member.user?.username      ?? member.user?.globalName ?? 'Unknown';
  // The first name that actually shows, so an invisible display name falls
  // back to the username instead of leaving "Welcome, !".
  const displayName = [member.displayName, member.nick, member.user?.globalName, member.user?.global_name, username]
    .find(isVisible) ?? 'New member';
  const serverName  = guild?.name                ?? 'this server';
  const mention     = asText ? displayName : `<@${member.user?.id ?? member.id}>`;

  return String(template ?? '')
    .replace(/{user}/g,        mention)
    .replace(/{mention}/g,     mention)
    .replace(/{name}/g,        displayName)
    .replace(/{username}/g,    username)
    .replace(/{displayname}/g, displayName)
    .replace(/{server}/g,      serverName)
    .replace(/{membercount}/g, formatCount(memberCount))
    .replace(/{count}/g,       formatCount(memberCount))
    .replace(/{ordinal}/g,     ordinal(memberCount));
}
const usesCount = t => /{membercount}|{count}|{ordinal}/.test(t ?? '');

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
  if (!text) return {};
  if (!embedOn) return { content: text };
  const embed = new EmbedBuilder().setDescription(text);
  const colorInt = hexToInt(color);
  if (colorInt != null) embed.setColor(colorInt);
  return { embeds: [embed.toJSON()] };
}

// ─── Welcome card ─────────────────────────────────────────────────────────────
// Draws the server's welcome card for this member. Returns null (send the
// message without it) if the card can't be drawn.
// A line for the card image. One that needs the member count is left off
// while the count isn't known, rather than printing "We now have ? members".
// ({ordinal} has its own wording for that: "newest".)
function cardLine(template, member, guild, memberCount) {
  const known = Number.isFinite(Number(memberCount)) && Number(memberCount) > 0;
  if (!known && /{count}|{membercount}/.test(template ?? '')) return '';
  return resolvePlaceholders(template, member, guild, memberCount, { asText: true });
}

// lines: { title, subtitle } templates to use instead of the welcome card's
// (the goodbye card passes its own).
export async function welcomeCardFor(client, member, guild, config, memberCount = '?', lines = null) {
  try {
    const { renderWelcomeCard } = await import('./profileCard.js');
    const { backgroundFor, cardColors } = await import('./welcomeBackgrounds.js');
    const userId = member.user?.id ?? member.id;
    // The server's banner/icon hashes, for the "server" background.
    const guildId = guild?.id ?? member.guild?.id ?? member.guildId;
    let bgGuild = { id: guildId, icon: guild?.icon ?? null, banner: guild?.banner ?? null };
    if (config.card_background === 'server' && !bgGuild.icon && !bgGuild.banner && guildId) {
      const g = await client.rest.get(`/guilds/${guildId}`).catch(() => null);
      bgGuild = { id: guildId, icon: g?.icon ?? null, banner: g?.banner ?? null };
    }
    let avatar = member.user?.avatar ?? null;
    if (!avatar && userId) avatar = (await client.rest.get(`/users/${userId}`).catch(() => null))?.avatar ?? null;
    const name = resolvePlaceholders('{name}', member, guild, memberCount, { asText: true });
    return await renderWelcomeCard({
      theme: config.card_theme,
      avatarUrl: avatar ? `https://fluxerusercontent.com/avatars/${userId}/${avatar}.png?size=256` : null,
      name,
      title: cardLine(lines ? lines.title : config.card_title, member, guild, memberCount),
      subtitle: cardLine(lines ? lines.subtitle : config.card_subtitle, member, guild, memberCount),
      colors: cardColors(config),
      background: guildId ? await backgroundFor(bgGuild, config) : null,
    });
  } catch (err) {
    logger.warn(`[WELCOME] Couldn't draw the welcome card: ${err.message}`);
    return null;
  }
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
    'welcome_card', 'card_theme', 'card_title', 'card_subtitle',
    'card_background', 'card_accent', 'card_title_color', 'card_subtitle_color',
    'goodbye_card', 'goodbye_card_title', 'goodbye_card_subtitle',
    'welcome_embed', 'welcome_color', 'goodbye_embed', 'goodbye_color',
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
  const needsCount = usesCount(config.welcome_message) || usesCount(config.dm_message)
                   || (config.welcome_card && (usesCount(config.card_title) || usesCount(config.card_subtitle)));
  const memberCount = needsCount ? await resolveMemberCount(client, guildId) : '?';

  // ── Channel welcome message ───────────────────────────────────────────────
  if (config.welcome_enabled && config.welcome_channel_id) {
    // Raw REST, not client.channels.fetch() + channel.send(): confirmed in
    // production that pattern fails with "channel.send is not a function"
    // for at least one channel type on v2.0.1's SDK.
    // The message (text outside the card) is optional when a card is on.
    const text = resolvePlaceholders(config.welcome_message, member, guild, memberCount).trim();
    const card = config.welcome_card ? await welcomeCardFor(client, member, guild, config, memberCount) : null;
    const body = buildMessagePayload(text, config.welcome_embed, config.welcome_color);
    if (card || body.content || body.embeds) {
      await client.rest.post(`/channels/${config.welcome_channel_id}/messages`, {
        body,
        ...(card ? { files: [{ name: 'welcome.png', data: card }] } : {}),
      }).catch(err =>
        logger.warn(`[WELCOME] Failed to send welcome message in ${guildId}:`, err.message)
      );
    }
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

  const lines = { title: config.goodbye_card_title, subtitle: config.goodbye_card_subtitle };
  const memberCount = usesCount(config.goodbye_message) || (config.goodbye_card && (usesCount(lines.title) || usesCount(lines.subtitle)))
    ? await resolveMemberCount(client, guildId)
    : '?';
  // The message is optional when a goodbye card is on, like welcomes.
  const text = resolvePlaceholders(config.goodbye_message, member, guild, memberCount).trim();
  const card = config.goodbye_card ? await welcomeCardFor(client, member, guild, config, memberCount, lines) : null;
  const body = buildMessagePayload(text, config.goodbye_embed, config.goodbye_color);
  if (!card && !body.content && !body.embeds) return;
  // Raw REST, not client.channels.fetch() + channel.send(): confirmed in
  // production that pattern fails with "channel.send is not a function"
  // for at least one channel type on v2.0.1's SDK.
  await client.rest.post(`/channels/${config.goodbye_channel_id}/messages`, {
    body,
    ...(card ? { files: [{ name: 'goodbye.png', data: card }] } : {}),
  }).catch(err =>
    logger.warn(`[GOODBYE] Failed to send goodbye message in ${guildId}:`, err.message)
  );
}
