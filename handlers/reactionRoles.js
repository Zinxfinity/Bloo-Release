import db from '../db.js';

// reaction_roles table is created in db.js (global table)
// role_menu_entry_blocks table is also created in db.js

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  get: db.prepare(`
    SELECT role_id FROM reaction_roles
    WHERE guild_id = ? AND message_id = ? AND emoji = ?
  `),
  add: db.prepare(`
    INSERT OR REPLACE INTO reaction_roles (guild_id, message_id, emoji, role_id)
    VALUES (?, ?, ?, ?)
  `),
  remove: db.prepare(`
    DELETE FROM reaction_roles WHERE guild_id = ? AND message_id = ? AND emoji = ?
  `),
  removeMessage: db.prepare(`
    DELETE FROM reaction_roles WHERE guild_id = ? AND message_id = ?
  `),
  listMessage: db.prepare(`
    SELECT emoji, role_id FROM reaction_roles WHERE guild_id = ? AND message_id = ?
  `),
  listGuild: db.prepare(`
    SELECT message_id, emoji, role_id FROM reaction_roles WHERE guild_id = ?
  `),
  relink: db.prepare(`
    UPDATE reaction_roles SET message_id = ? WHERE guild_id = ? AND message_id = ?
  `),
  // Filtered by menu_id too, not just (guild_id, entry_role_id): the same
  // role can be offered by more than one menu, and a block/require rule
  // configured for one menu was previously applying to every OTHER menu
  // that happened to offer the same role as well.
  getBlocks: db.prepare(`
    SELECT blocking_role_id, type FROM role_menu_entry_blocks
    WHERE guild_id = ? AND menu_id = ? AND entry_role_id = ?
  `),
};

// ─── In-memory reaction suppression ──────────────────────────────────────────
// Prevents echo loops when the bot removes its own reactions. Scoped per-user
// (not just per channel+message+emoji), otherwise one user's reaction being
// cleaned up would also blind the handler to a different user's genuine
// interaction with the same emoji on the same message in that window.
//
// The window is short (covers the bot's own grant/revoke + delete round trip,
// which runs well under a second) rather than several seconds, since a longer
// window swallows a real, intentional quick re-click (e.g. testing a toggle)
// as if it were an echo of the first one, silently dropping the role change.
const suppressedReactions = new Set();
const SUPPRESSION_WINDOW_MS = 2000;

export function suppressReaction(channelId, messageId, emoji, userId) {
  const key = `${channelId}:${messageId}:${emojiMatchKey(emoji)}:${userId}`;
  suppressedReactions.add(key);
  setTimeout(() => suppressedReactions.delete(key), SUPPRESSION_WINDOW_MS);
}

export function isReactionSuppressed(channelId, messageId, emoji, userId) {
  return suppressedReactions.has(`${channelId}:${messageId}:${emojiMatchKey(emoji)}:${userId}`);
}

// ─── Emoji key normalisation ──────────────────────────────────────────────────
/**
 * Converts a FluxerJS emoji object to the storage key format: 'name:id',
 * 'a_name:id' for animated, or raw unicode. Must match dashboard/routes/
 * reactionroles.js's normEmoji() and commands/moderation/rolemenu.js's
 * emojiDisplay(), both already store/parse the a_ prefix, this used to
 * never add it, so any animated-emoji role menu entry or reaction role
 * configured via dashboard never matched at reaction time.
 */
export function emojiKey(emoji) {
  if (!emoji) return '';
  if (emoji.id) return `${emoji.animated ? 'a_' : ''}${emoji.name}:${emoji.id}`;
  return (emoji.name ?? '').replace(/\uFE0F/g, ''); // strip variation selector from unicode
}

// Stored emoji come in several spellings depending on who wrote them:
// 'name:id', 'a_name:id', '<:name:id>', '<a:name:id>', unicode with or without
// U+FE0F. Comparing raw strings meant an animated emoji added by command
// ('name:id') never matched the reaction's 'a_name:id'. A custom emoji is
// identified by its ID alone; unicode by the glyph minus the variation selector.
export function emojiMatchKey(k) {
  if (!k) return '';
  const s = String(k);
  const id = s.match(/:(\d{15,22})>?$/)?.[1];
  return id ? `id:${id}` : s.replace(/\uFE0F/g, '');
}

export function sameEmoji(a, b) {
  return emojiMatchKey(a) === emojiMatchKey(b);
}

// URL-encoded form for the /reactions/{emoji} REST routes, which take
// 'name:id' for custom emoji (no a_ prefix, no <> wrapper) or the unicode glyph.
export function emojiRoute(k) {
  const s = String(k ?? '');
  const m = s.match(/^(?:<a?:|a_)?(\w+):(\d{15,22})>?$/);
  return encodeURIComponent(m ? `${m[1]}:${m[2]}` : s.replace(/️/g, ''));
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────
export function getRoleId(guildId, messageId, emoji) {
  const key = typeof emoji === 'string' ? emoji : emojiKey(emoji);
  const exact = stmts.get.get(guildId, messageId, key)?.role_id;
  if (exact) return exact;
  // Stored under a different spelling of the same emoji (see emojiMatchKey).
  return stmts.listMessage.all(guildId, messageId).find(r => sameEmoji(r.emoji, key))?.role_id ?? null;
}

export function addReactionRole(guildId, messageId, emoji, roleId) {
  const key = typeof emoji === 'string' ? emoji : emojiKey(emoji);
  stmts.add.run(guildId, messageId, key, roleId);
}

export function removeReactionRole(guildId, messageId, emoji) {
  const key = typeof emoji === 'string' ? emoji : emojiKey(emoji);
  stmts.remove.run(guildId, messageId, key);
}

export function removeAllForMessage(guildId, messageId) {
  stmts.removeMessage.run(guildId, messageId);
}

// Moves every mapping from one message onto another, e.g. the original
// message was reposted or moved and its old ID is now dead. Caller is
// responsible for checking the new message_id isn't already in use (see
// !rr relink), an unconditional move would otherwise merge two groups
// together silently.
export function relinkMessage(guildId, oldMessageId, newMessageId) {
  stmts.relink.run(newMessageId, guildId, oldMessageId);
}

export function listForMessage(guildId, messageId) {
  return stmts.listMessage.all(guildId, messageId);
}

export function listForGuild(guildId) {
  return stmts.listGuild.all(guildId);
}

// ─── Role access block checks ─────────────────────────────────────────────────
/**
 * Returns { allowed: boolean, reason: 'blocked'|'missing-required'|null }
 */
export function checkRoleAccess(guildId, menuId, entryRoleId, memberRoleIds) {
  const blocks = stmts.getBlocks.all(guildId, menuId, entryRoleId);
  if (!blocks.length) return { allowed: true, reason: null };

  const memberRoleSet = new Set(memberRoleIds);

  for (const block of blocks) {
    if (block.type === 'block' && memberRoleSet.has(block.blocking_role_id)) {
      return { allowed: false, reason: 'blocked' };
    }
  }

  const requires = blocks.filter(b => b.type === 'require');
  if (requires.length && !requires.some(r => memberRoleSet.has(r.blocking_role_id))) {
    return { allowed: false, reason: 'missing-required' };
  }

  return { allowed: true, reason: null };
}

// ─── canonicalEmoji ───────────────────────────────────────────────────────────
// Alias for emojiKey, reactionrole.js command uses this name.
export function canonicalEmoji(raw) { return emojiKey(raw); }

// ─── Convenience aliases used by commands ─────────────────────────────────────
export function clearReactionRoles(guildId, messageId) { return removeAllForMessage(guildId, messageId); }
export function getMappings(guildId, messageId)        { return listForMessage(guildId, messageId); }
export function getAllForGuild(guildId)                 { return listForGuild(guildId); }
