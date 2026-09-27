import { Events } from '@fluxerjs/core';

let _logMessageDelete    = null;
let _handleStarredDelete = null;

// Bulk deletes (e.g. !purge on more than one message) go through Discord's
// bulk-delete endpoint, which fires a single MessageDeleteBulk event instead
// of one MessageDelete per message, this codebase previously had no listener
// for it at all, so anything purged in bulk silently skipped mod-log
// delete-logging and starboard cleanup entirely, confirmed via live testing.
export default {
  name: Events.MessageDeleteBulk,
  once: false,

  async execute(client, payload) {
    const { ids, channelId, guildId: payloadGuildId, channel, messages } = payload ?? {};
    if (!channelId || !ids?.length) return;

    let guildId = payloadGuildId ?? channel?.guildId ?? null;
    if (!guildId) {
      const ch = client.channels?.cache?.get(channelId)
        ?? await client.channels.fetch(channelId).catch(() => null);
      guildId = ch?.guildId ?? null;
    }
    if (!guildId) return;

    if (!_logMessageDelete) {
      const mod = await import('../../handlers/messageLogger.js').catch(() => null);
      _logMessageDelete = mod?.logMessageDelete ?? (() => {});
    }
    if (!_handleStarredDelete) {
      const mod = await import('../../handlers/starboard.js').catch(() => null);
      _handleStarredDelete = mod?.handleStarredMessageDelete ?? (() => {});
    }

    // messages[i] is the PartialMessage for ids[i] (content/author/createdAt
    // filled only if that message was cached beforehand), same shape a
    // singular MessageDelete hands to logMessageDelete, so no special-casing
    // needed there. Run sequentially, not Promise.all, a large purge already
    // means many messages here and each iteration does its own REST calls
    // (author resolution, starboard lookup), no reason to burst them all at
    // once against rate limits for what's a background logging concern.
    for (let i = 0; i < ids.length; i++) {
      const id      = ids[i];
      const partial = messages?.[i] ?? { id, channelId };
      try { await _logMessageDelete(client, partial, guildId); } catch { /* non-fatal */ }
      try { await _handleStarredDelete(client, guildId, id, channelId); } catch { /* non-fatal */ }
    }
  },
};
