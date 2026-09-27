import { Events } from '@fluxerjs/core';

let _logMessageDelete   = null;
let _handleStarredDelete = null;
let _scanDeleted         = null;

export default {
  name: Events.MessageDelete,
  once: false,

  async execute(client, message) {
    // v3: message is a PartialMessage when it wasn't cached before deletion
    // (message.partial === true), guaranteeing only id/channelId. MESSAGE_DELETE
    // never carries a top-level guildId on the wire either way, so resolve it
    // via the cached channel first, falling back to a fetch by channelId if
    // v3 doesn't hydrate message.channel for a partial message the way v2 did.
    const channelId = message.channelId;
    if (!channelId) return;

    let guildId = message.guildId ?? message.channel?.guildId ?? null;
    if (!guildId) {
      const channel = client.channels?.cache?.get(channelId)
        ?? await client.channels.fetch(channelId).catch(() => null);
      guildId = channel?.guildId ?? null;
    }
    if (!guildId) return;

    if (!_logMessageDelete) {
      const mod = await import('../../handlers/messageLogger.js').catch(() => null);
      _logMessageDelete = mod?.logMessageDelete ?? (() => {});
    }
    try { await _logMessageDelete(client, message, guildId); } catch { /* non-fatal */ }

    if (!_scanDeleted) {
      const mod = await import('../../handlers/wordFilter.js').catch(() => null);
      _scanDeleted = mod?.scanDeletedMessage ?? (() => {});
    }
    try { await _scanDeleted(client, message, guildId); } catch { /* non-fatal */ }

    if (!_handleStarredDelete) {
      const mod = await import('../../handlers/starboard.js').catch(() => null);
      _handleStarredDelete = mod?.handleStarredMessageDelete ?? (() => {});
    }
    try { await _handleStarredDelete(client, guildId, message.id, channelId); } catch { /* non-fatal */ }
  },
};
