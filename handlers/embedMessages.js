// ============================================================
//  handlers/embedMessages.js
//
//  Saved embed messages: an embed Bloo posts for a server (rules, info,
//  announcements), kept so it can be edited later and the posted message
//  updated in place, like a role menu without the reactions.
//  Shared by b!embed and the dashboard's Embed Messages page.
// ============================================================

import db from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS embed_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT    NOT NULL,
    channel_id    TEXT,
    message_id    TEXT,
    content       TEXT,
    title         TEXT,
    url           TEXT,
    description   TEXT,
    color         INTEGER,
    author_name   TEXT,
    image_url     TEXT,
    thumbnail_url TEXT,
    footer        TEXT,
    fields        TEXT    NOT NULL DEFAULT '[]',
    timestamp     INTEGER NOT NULL DEFAULT 0,
    created_by    TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_embed_messages_guild ON embed_messages (guild_id);
`);

// A refusal with a message fit to show the person who asked.
export class EmbedMessageError extends Error {}

export const MAX_PER_GUILD = 100;
export const MAX_FIELDS = 25;
const LIMITS = { content: 2000, title: 256, description: 4096, author_name: 256, footer: 2048, field_name: 256, field_value: 1024 };
const TEXT_KEYS = ['content', 'title', 'description', 'author_name', 'footer'];
const URL_KEYS = ['url', 'image_url', 'thumbnail_url'];
export const EDITABLE = [...TEXT_KEYS, ...URL_KEYS, 'color', 'fields', 'timestamp'];

const blank = v => v == null || String(v).trim() === '';
const parseFields = raw => { try { const f = JSON.parse(raw || '[]'); return Array.isArray(f) ? f : []; } catch { return []; } };

// Checks and tidies a set of changes. Unknown keys are ignored; '' or null
// clears a value.
export function cleanChanges(changes = {}) {
  const out = {};
  for (const k of TEXT_KEYS) {
    if (!(k in changes)) continue;
    const v = blank(changes[k]) ? null : String(changes[k]).replace(/\r\n/g, '\n');
    if (v && v.length > LIMITS[k]) throw new EmbedMessageError(`The ${k.replace('_', ' ')} can be up to ${LIMITS[k]} characters.`);
    out[k] = v;
  }
  for (const k of URL_KEYS) {
    if (!(k in changes)) continue;
    const v = blank(changes[k]) ? null : String(changes[k]).trim();
    if (v && !/^https:\/\/\S+$/i.test(v)) throw new EmbedMessageError('Links and images must start with https://.');
    out[k] = v;
  }
  if ('color' in changes) {
    const c = changes.color;
    if (c == null || c === '') out.color = null;
    else {
      const n = typeof c === 'number' ? c : parseInt(String(c).replace(/^#/, ''), 16);
      if (!Number.isInteger(n) || n < 0 || n > 0xFFFFFF) throw new EmbedMessageError('Use a colour like #5865F2.');
      out.color = n;
    }
  }
  if ('timestamp' in changes) out.timestamp = changes.timestamp ? 1 : 0;
  if ('fields' in changes) {
    const list = Array.isArray(changes.fields) ? changes.fields : [];
    if (list.length > MAX_FIELDS) throw new EmbedMessageError(`An embed can have up to ${MAX_FIELDS} fields.`);
    out.fields = JSON.stringify(list.map((f, i) => {
      const name = String(f?.name ?? '').trim(), value = String(f?.value ?? '').trim();
      if (!name || !value) throw new EmbedMessageError(`Field ${i + 1} needs a name and a value.`);
      if (name.length > LIMITS.field_name) throw new EmbedMessageError(`Field ${i + 1}'s name can be up to ${LIMITS.field_name} characters.`);
      if (value.length > LIMITS.field_value) throw new EmbedMessageError(`Field ${i + 1}'s value can be up to ${LIMITS.field_value} characters.`);
      return { name, value, inline: !!f?.inline };
    }));
  }
  return out;
}

// The message Bloo posts for a saved embed.
export function buildPayload(row) {
  const fields = parseFields(row.fields);
  const embed = {};
  if (row.title) embed.title = row.title;
  if (row.url && row.title) embed.url = row.url;
  if (row.description) embed.description = row.description;
  if (row.color != null) embed.color = row.color;
  if (row.author_name) embed.author = { name: row.author_name };
  if (row.image_url) embed.image = { url: row.image_url };
  if (row.thumbnail_url) embed.thumbnail = { url: row.thumbnail_url };
  if (row.footer) embed.footer = { text: row.footer };
  if (fields.length) embed.fields = fields;
  if (row.timestamp) embed.timestamp = new Date().toISOString();
  const hasEmbed = Object.keys(embed).some(k => k !== 'color' && k !== 'timestamp');
  return {
    ...(row.content ? { content: row.content } : {}),
    embeds: hasEmbed ? [embed] : [],
    // Staff-written, so user and role mentions ping; @everyone/@here don't.
    allowed_mentions: { parse: ['users', 'roles'] },
  };
}

function checkSendable(row) {
  const p = buildPayload(row);
  if (!p.content && !p.embeds.length) throw new EmbedMessageError('Give it a title, some text or an image first.');
  const e = p.embeds[0];
  if (e) {
    const total = [e.title, e.description, e.author?.name, e.footer?.text, ...(e.fields ?? []).flatMap(f => [f.name, f.value])]
      .reduce((n, s) => n + (s?.length ?? 0), 0);
    if (total > 6000) throw new EmbedMessageError('All the text in one embed can add up to 6000 characters at most.');
  }
  return p;
}

const row = (guildId, id) => db.prepare('SELECT * FROM embed_messages WHERE id = ? AND guild_id = ?').get(Number(id), guildId);
export function getEmbedMessage(guildId, id) {
  const r = row(guildId, id);
  return r ? { ...r, fields: parseFields(r.fields) } : null;
}
function own(guildId, id) {
  const r = row(guildId, id);
  if (!r) throw new EmbedMessageError(`No embed message #${id} in this server.`);
  return r;
}

export function listEmbedMessages(guildId) {
  return db.prepare('SELECT * FROM embed_messages WHERE guild_id = ? ORDER BY id DESC').all(guildId)
    .map(r => ({ ...r, fields: parseFields(r.fields) }));
}

export function createEmbedMessage(guildId, changes, createdBy) {
  const { n } = db.prepare('SELECT COUNT(*) n FROM embed_messages WHERE guild_id = ?').get(guildId);
  if (n >= MAX_PER_GUILD) throw new EmbedMessageError(`A server can keep up to ${MAX_PER_GUILD} embed messages. Delete one first.`);
  const c = cleanChanges(changes);
  checkSendable({ fields: '[]', ...c });
  const cols = Object.keys(c);
  const id = db.prepare(`INSERT INTO embed_messages (guild_id, created_by${cols.map(k => `, ${k}`).join('')}) VALUES (?, ?${cols.map(() => ', ?').join('')})`)
    .run(guildId, createdBy ?? null, ...cols.map(k => c[k])).lastInsertRowid;
  return Number(id);
}

// Saves changes. The posted message, if any, is left for refresh/post.
export function updateEmbedMessage(guildId, id, changes) {
  const r = own(guildId, id);
  const c = cleanChanges(changes);
  if (!Object.keys(c).length) return getEmbedMessage(guildId, id);
  checkSendable({ ...r, ...c });
  const cols = Object.keys(c);
  db.prepare(`UPDATE embed_messages SET ${cols.map(k => `${k} = ?`).join(', ')}, updated_at = unixepoch() WHERE id = ?`)
    .run(...cols.map(k => c[k]), r.id);
  return getEmbedMessage(guildId, id);
}

// Posts it, or updates the posted message in place. A different channel
// than last time posts a new message there and removes the old one.
// client needs rest.post/patch/delete. Returns { posted, edited, channelId, messageId }.
export async function publishEmbedMessage(client, guildId, id, channelId = null) {
  const r = own(guildId, id);
  const payload = checkSendable(r);
  const target = channelId ?? r.channel_id;
  if (!target) throw new EmbedMessageError('Pick a channel to post it in.');

  if (r.message_id && r.channel_id === target) {
    try {
      await client.rest.patch(`/channels/${target}/messages/${r.message_id}`, { body: { content: payload.content ?? '', embeds: payload.embeds, allowed_mentions: payload.allowed_mentions } });
      db.prepare('UPDATE embed_messages SET updated_at = unixepoch() WHERE id = ?').run(r.id);
      return { posted: false, edited: true, channelId: target, messageId: r.message_id };
    } catch { /* the posted message is gone: post it again below */ }
  }
  let msg;
  try {
    msg = await client.rest.post(`/channels/${target}/messages`, { body: payload });
  } catch {
    throw new EmbedMessageError(`Bloo couldn't post in <#${target}>. Check it can view the channel, send messages and embed links there.`);
  }
  if (!msg?.id) throw new EmbedMessageError('Fluxer didn\'t confirm the post. Try again.');
  if (r.message_id && r.channel_id && (r.channel_id !== target)) {
    await client.rest.delete(`/channels/${r.channel_id}/messages/${r.message_id}`).catch(() => {});
  }
  db.prepare('UPDATE embed_messages SET channel_id = ?, message_id = ?, updated_at = unixepoch() WHERE id = ?').run(target, msg.id, r.id);
  return { posted: true, edited: false, channelId: target, messageId: msg.id };
}

// Removes the saved embed, and its posted message unless keepPost.
export async function deleteEmbedMessage(client, guildId, id, { keepPost = false } = {}) {
  const r = own(guildId, id);
  if (!keepPost && r.message_id && r.channel_id) {
    await client.rest.delete(`/channels/${r.channel_id}/messages/${r.message_id}`).catch(() => {});
  }
  db.prepare('DELETE FROM embed_messages WHERE id = ?').run(r.id);
  return { id: r.id };
}
