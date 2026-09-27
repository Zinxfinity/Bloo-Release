// ─── Ticket system, public API ────────────────────────────────────────────────
// Re-exports the split modules in this folder so existing imports of
// '../../handlers/ticketSystem/index.js' see the same surface the old single
// ticketSystem.js file exposed.

import './schema.js'; // runs table creation + migrations on first import

export {
  getTicketConfig, setTicketField,
  getTicketOptions, addTicketOption, removeTicketOption, editTicketOption,
  setOptionMessage, setOptionKeyword, normalizeKeyword,
  getOptionByEmoji, setOptionRole, setOptionCategory,
  setOptionEnabled, setOptionDisabledMessage, setOptionNoPrefix,
} from './config.js';

export {
  isTicketBlacklisted, addToTicketBlacklist, removeFromTicketBlacklist, getTicketBlacklist,
} from './blacklist.js';

export { buildTicketOverwrites } from './permissions.js';

export {
  registerExistingTicket, openTicket, closeTicket, closeTicketWithNotice, reopenTicket,
  getTicketByCase, getTicketByChannel, listOpenTickets, listTickets,
  getOpenTicketByUser, getTicketsByUser, getCreatingTicketByUser, failTicket,
  handleTicketRename, recategorizeTicket,
} from './lifecycle.js';

export { postTicketPanel, handleTicketReaction, handleCloseReaction } from './panels.js';
