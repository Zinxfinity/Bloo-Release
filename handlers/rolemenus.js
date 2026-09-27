import db from '../db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../config/embeds.js';
import { emojiRoute } from './reactionRoles.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
// The one definition of role_menus / role_menu_entries. commands/moderation/
// rolemenu.js used to declare its own narrower copy (no name/max_picks/
// exclusive_group/label) and, since commands load at boot while this module
// loads lazily, won the race on a fresh install: `rolemenu add` and the
// dashboard's create then failed on missing columns. It now imports this file
// instead. name/label default to '' because the command's own inserts don't
// set them.
db.exec(`
  CREATE TABLE IF NOT EXISTS role_menus (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id        TEXT    NOT NULL,
    name            TEXT    NOT NULL DEFAULT '',
    title           TEXT    NOT NULL DEFAULT 'Role Menu',
    description     TEXT,
    color           INTEGER NOT NULL DEFAULT ${COLORS.INFO},
    max_picks       INTEGER NOT NULL DEFAULT 0,
    exclusive       INTEGER NOT NULL DEFAULT 0,
    exclusive_group TEXT,
    channel_id      TEXT,
    message_id      TEXT,
    post_channel_id TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS role_menu_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_id     INTEGER NOT NULL REFERENCES role_menus(id) ON DELETE CASCADE,
    guild_id    TEXT    NOT NULL,
    role_id     TEXT    NOT NULL,
    emoji       TEXT    NOT NULL,
    label       TEXT    NOT NULL DEFAULT '',
    description TEXT,
    position    INTEGER NOT NULL DEFAULT 0
  );
`);

// ─── Migrations ───────────────────────────────────────────────────────────────
for (const col of [
  `ALTER TABLE role_menus ADD COLUMN name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE role_menus ADD COLUMN title TEXT NOT NULL DEFAULT 'Role Menu'`,
  `ALTER TABLE role_menus ADD COLUMN description TEXT`,
  `ALTER TABLE role_menus ADD COLUMN color INTEGER NOT NULL DEFAULT ${COLORS.INFO}`,
  `ALTER TABLE role_menus ADD COLUMN max_picks INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE role_menus ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE role_menus ADD COLUMN exclusive_group TEXT`,
  `ALTER TABLE role_menus ADD COLUMN channel_id TEXT`,
  `ALTER TABLE role_menus ADD COLUMN message_id TEXT`,
  `ALTER TABLE role_menus ADD COLUMN post_channel_id TEXT`,
  `ALTER TABLE role_menus ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE role_menus ADD COLUMN max_roles INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE role_menu_entries ADD COLUMN menu_id INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE role_menu_entries ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE role_menu_entries ADD COLUMN role_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE role_menu_entries ADD COLUMN emoji TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE role_menu_entries ADD COLUMN label TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE role_menu_entries ADD COLUMN description TEXT`,
  `ALTER TABLE role_menu_entries ADD COLUMN position INTEGER NOT NULL DEFAULT 0`,
]) {
  try { db.exec(col); } catch { /* already exists */ }
}
// One entry per role per menu. `!rolemenu add` relies on this for its
// INSERT OR REPLACE; the live table already enforces it via its original
// UNIQUE(menu_id, role_id), this covers tables created from the schema above.
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_role_menu_entries_menu_role ON role_menu_entries (menu_id, role_id)`); } catch { /* pre-existing duplicates, leave as is */ }

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  create: db.prepare(`
    INSERT INTO role_menus (guild_id, name, title, description, color, max_picks, exclusive, exclusive_group)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getById: db.prepare(`SELECT * FROM role_menus WHERE id = ? AND guild_id = ?`),
  listGuild: db.prepare(`SELECT * FROM role_menus WHERE guild_id = ? ORDER BY created_at DESC`),
  update: db.prepare(`
    UPDATE role_menus SET title=?, description=?, color=?, max_picks=?, exclusive=?, exclusive_group=?, post_channel_id=?
    WHERE id = ? AND guild_id = ?
  `),
  delete: db.prepare(`DELETE FROM role_menus WHERE id = ? AND guild_id = ?`),
  setMessageId: db.prepare(`
    UPDATE role_menus SET message_id = ?, channel_id = ? WHERE id = ? AND guild_id = ?
  `),

  getEntries: db.prepare(`
    SELECT * FROM role_menu_entries WHERE menu_id = ? ORDER BY position ASC
  `),
  addEntry: db.prepare(`
    INSERT INTO role_menu_entries (menu_id, guild_id, role_id, emoji, label, description, position)
    VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM role_menu_entries WHERE menu_id = ?))
  `),
  removeEntry: db.prepare(`DELETE FROM role_menu_entries WHERE id = ? AND guild_id = ?`),
  updateEntry: db.prepare(`
    UPDATE role_menu_entries SET role_id=?, emoji=?, label=?, description=? WHERE id = ? AND guild_id = ?
  `),
  getEntryByRoleId: db.prepare(`
    SELECT * FROM role_menu_entries WHERE menu_id = ? AND role_id = ?
  `),
  getMenusForMessage: db.prepare(`
    SELECT * FROM role_menus WHERE message_id = ? AND guild_id = ?
  `),
  getMenusByGroup: db.prepare(`
    SELECT id FROM role_menus WHERE guild_id = ? AND exclusive_group = ? AND id != ?
  `),
};

// ─── Menu CRUD ────────────────────────────────────────────────────────────────
export function createRoleMenu(guildId, name, opts = {}) {
  const result = stmts.create.run(
    guildId, name,
    opts.title        ?? 'Role Menu',
    opts.description  ?? null,
    opts.color        ?? COLORS.INFO,
    opts.maxPicks     ?? 0,
    opts.exclusive    ? 1 : 0,
    opts.exclusiveGroup ?? null,
  );
  return result.lastInsertRowid;
}

export function getRoleMenu(guildId, menuId) {
  return stmts.getById.get(menuId, guildId) ?? null;
}

export function listRoleMenus(guildId) {
  return stmts.listGuild.all(guildId);
}

export function updateRoleMenu(guildId, menuId, opts = {}) {
  const existing = getRoleMenu(guildId, menuId);
  if (!existing) throw new Error('Menu not found.');
  stmts.update.run(
    opts.title        ?? existing.title,
    opts.description  ?? existing.description,
    opts.color        ?? existing.color,
    opts.maxPicks     ?? existing.max_picks,
    opts.exclusive    != null ? (opts.exclusive ? 1 : 0) : existing.exclusive,
    opts.exclusiveGroup ?? existing.exclusive_group,
    opts.postChannelId  ?? existing.post_channel_id,
    menuId, guildId,
  );
}

export function deleteRoleMenu(guildId, menuId) {
  stmts.delete.run(menuId, guildId);
}

// ─── Entry CRUD ───────────────────────────────────────────────────────────────
export function getMenuEntries(menuId) {
  return stmts.getEntries.all(menuId);
}

export function addMenuEntry(guildId, menuId, roleId, emoji, label, description) {
  stmts.addEntry.run(menuId, guildId, roleId, emoji, label, description ?? null, menuId);
}

export function removeMenuEntry(guildId, entryId) {
  stmts.removeEntry.run(entryId, guildId);
}

export function updateMenuEntry(guildId, entryId, roleId, emoji, label, description) {
  stmts.updateEntry.run(roleId, emoji, label, description ?? null, entryId, guildId);
}

// ─── Menu lookup by message ID ────────────────────────────────────────────────
export function getMenuByMessage(guildId, messageId) {
  return stmts.getMenusForMessage.get(messageId, guildId) ?? null;
}

// ─── postRoleMenu ─────────────────────────────────────────────────────────────
export async function postRoleMenu(client, guildId, menuId) {
  const menu    = getRoleMenu(guildId, menuId);
  const entries = getMenuEntries(menuId);

  if (!menu) return { ok: false, reason: 'not-found' };

  const channelId = menu.post_channel_id ?? menu.channel_id;
  if (!channelId) return { ok: false, reason: 'no-channel' };

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return { ok: false, reason: 'channel-not-found' };

  const embed = new EmbedBuilder()
    .setColor(menu.color)
    .setTitle(menu.title);

  if (menu.description) embed.setDescription(menu.description);

  if (entries.length) {
    embed.setDescription(
      (menu.description ? menu.description + '\n\n' : '') +
      entries.map(e => `${e.emoji}, **${e.label}**${e.description ? `\n${e.description}` : ''}`).join('\n')
    );
  }

  try {
    const msg = await client.rest.post(
      `/channels/${channelId}/messages`,
      { body: { embeds: [embed.toJSON()] } }
    );

    for (const entry of entries) {
      try {
        const emojiEnc = emojiRoute(entry.emoji);
        await client.rest.put(
          `/channels/${channelId}/messages/${msg.id}/reactions/${emojiEnc}/@me`
        );
      } catch { /* non-fatal */ }
    }

    stmts.setMessageId.run(msg.id, channelId, menuId, guildId);
    return { ok: true, messageId: msg.id };
  } catch (err) {
    logger.warn(`[ROLEMENU] Failed to post menu ${menuId} in ${guildId}:`, err.message);
    return { ok: false, reason: err.message };
  }
}

// ─── Exclusive group stripping ────────────────────────────────────────────────
/**
 * When a user picks from an exclusive_group menu, remove roles from sibling menus.
 */
export async function stripExclusiveGroupRoles(client, guildId, menuId, userId, newRoleId) {
  const menu = getRoleMenu(guildId, menuId);
  if (!menu?.exclusive_group) return;

  const siblings = stmts.getMenusByGroup.all(guildId, menu.exclusive_group, menuId);
  for (const sibling of siblings) {
    const sibEntries = getMenuEntries(sibling.id);
    for (const entry of sibEntries) {
      if (entry.role_id === newRoleId) continue;
      try {
        await client.rest.delete(
          `/guilds/${guildId}/members/${userId}/roles/${entry.role_id}`
        );
      } catch (err) {
        logger.warn(`[RR] Exclusive-group strip failed for role ${entry.role_id} (sibling menu ${sibling.id}, user ${userId}, guild ${guildId}):`, err.message);
      }
    }
  }
}
