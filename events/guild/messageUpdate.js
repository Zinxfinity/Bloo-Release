import { Events } from '@fluxerjs/core';
import * as resilience from '../../handlers/resilience.js';

let _logMessageEdit    = null;
let _runWordFilter     = null;
let _handleStarredEdit = null;
let _runAutomod        = null;
let _enforceLink       = null;

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(client, oldMessage, newMessage) {
    if (newMessage.author?.bot) return;

    // v3: an uncached update delivers newMessage as a PartialMessage too, not
    // just oldMessage. Fall back to a channel fetch for guildId the same way
    // messageDelete.js does, rather than trusting newMessage.guildId alone to
    // still be populated the way v2 always guaranteed.
    const channelId = newMessage.channelId;
    if (!channelId) return;

    let guildId = newMessage.guildId ?? newMessage.channel?.guildId ?? null;
    if (!guildId) {
      const channel = client.channels?.cache?.get(channelId)
        ?? await client.channels.fetch(channelId).catch(() => null);
      guildId = channel?.guildId ?? null;
    }
    if (!guildId) return;

    // Content unchanged, skip (e.g. embed unfurl). oldMessage is null when
    // the message wasn't in the local cache, can't diff, so fall through.
    if (oldMessage && oldMessage.content === newMessage.content) return;

    if (!_logMessageEdit) {
      const mod = await import('../../handlers/messageLogger.js').catch(() => null);
      _logMessageEdit = mod?.logMessageEdit ?? (() => {});
    }
    await resilience.runLight('messageLogger.logMessageEdit', () => _logMessageEdit(client, oldMessage, newMessage, guildId));

    if (!_runWordFilter) {
      const mod = await import('../../handlers/wordFilter.js').catch(() => null);
      _runWordFilter = mod?.runWordFilter ?? (() => false);
    }
    const wordFilterBlocked = await resilience.runCritical('wordFilter.run', () => _runWordFilter(client, newMessage, guildId, { edited: true }), { fallback: false });
    if (wordFilterBlocked) return;

    // Automod's content checks and link enforcement used to run on new
    // messages only, so posting "hi" and editing a blocked link or invite
    // into it got straight past both. They take guildId from the message,
    // which an uncached edit may not carry, so it's filled in here.
    const msg = newMessage.guildId ? newMessage : Object.assign(Object.create(newMessage), { guildId });
    if (!_runAutomod) {
      const mod = await import('../../handlers/automod.js').catch(() => null);
      _runAutomod = mod?.runAutomod ?? (() => false);
    }
    if (await resilience.runCritical('automod.run', () => _runAutomod(client, msg, { edited: true }), { fallback: false })) return;
    if (!_enforceLink) {
      const mod = await import('../../handlers/linkEnforcement.js').catch(() => null);
      _enforceLink = mod?.enforceLink ?? (() => false);
    }
    if (await resilience.runCritical('linkEnforcement.enforceLink', () => _enforceLink(client, msg), { fallback: false })) return;

    if (!_handleStarredEdit) {
      const mod = await import('../../handlers/starboard.js').catch(() => null);
      _handleStarredEdit = mod?.handleStarredMessageEdit ?? (() => {});
    }
    await resilience.runLight('starboard.handleStarredMessageEdit', () => _handleStarredEdit(client, newMessage, guildId));
  },
};
