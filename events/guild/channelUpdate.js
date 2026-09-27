// ============================================================
//  events/guild/channelUpdate.js
//
//  Only concern right now: if a ticket channel gets manually renamed to
//  match a different option's keyword (e.g. ticket-partner-0001 renamed to
//  ticket-support-0023), recognise the category change and keep the ticket
//  system's own records (case ID, routing, channel category) in sync
//  rather than silently drifting from what the channel now says. See
//  handlers/ticketSystem/lifecycle.js's handleTicketRename for the actual
//  matching/update logic, this file just wires up the gateway event.
// ============================================================

import { Events } from '@fluxerjs/core';
import logger from '../../utils/logger.js';

let _handleTicketRename = null;

export default {
  name: Events.ChannelUpdate,
  once: false,

  async execute(client, oldChannel, newChannel) {
    const guildId = newChannel?.guild_id ?? newChannel?.guildId;
    const channelId = newChannel?.id;
    if (!guildId || !channelId) return;
    if (!newChannel?.name || oldChannel?.name === newChannel.name) return;

    if (!_handleTicketRename) {
      const mod = await import('../../handlers/ticketSystem/index.js').catch(() => null);
      _handleTicketRename = mod?.handleTicketRename ?? null;
    }
    if (!_handleTicketRename) return;

    try {
      const result = await _handleTicketRename(client, guildId, channelId, newChannel.name);
      if (result?.ok) {
        logger.info(`[CHANNELUPDATE] Ticket recategorised in ${guildId}: ${result.oldCaseId} -> ${result.newCaseId}`);
      }
    } catch (err) {
      logger.warn(`[CHANNELUPDATE] handleTicketRename failed for ${channelId} in ${guildId}:`, err.message);
    }
  },
};
