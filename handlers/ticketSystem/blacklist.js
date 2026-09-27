// ─── Ticket blacklist CRUD ──────────────────────────────────────────────────────

import { stmts } from './schema.js';

export function isTicketBlacklisted(guildId, userId) {
  return !!stmts.isBlacklisted.get(guildId, userId);
}

export function addToTicketBlacklist(guildId, userId, addedBy, reason) {
  stmts.addBlacklist.run(guildId, userId, reason ?? null, addedBy ?? null);
}

export function removeFromTicketBlacklist(guildId, userId) {
  const result = stmts.removeBlacklist.run(guildId, userId);
  return result.changes > 0;
}

export function getTicketBlacklist(guildId) {
  return stmts.listBlacklist.all(guildId);
}
