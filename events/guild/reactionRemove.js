import { Events } from '@fluxerjs/core';
import { emojiKey, sameEmoji, getRoleId, isReactionSuppressed } from '../../handlers/reactionRoles.js';

let _getMenuByMessage  = null;
let _getMenuEntries    = null;
let _handleStarRemove  = null;
let _advPoll           = null;

export default {
  name: Events.MessageReactionRemove,
  once: false,

  async execute(client, payload) {
    // Single payload object: { reaction, user, messageId, channelId, emoji,
    // userId }. `reaction` is the MessageReaction instance (carries guildId).
    const { reaction, emoji, userId, messageId, channelId } = payload;
    const guildId = reaction?.guildId;

    if (!guildId || !userId) return;

    const key = emojiKey(emoji);

    if (isReactionSuppressed(channelId, messageId, key, userId)) return;

    // ── Starboard ─────────────────────────────────────────────────────────
    if (!_handleStarRemove) {
      const mod = await import('../../handlers/starboard.js').catch(() => null);
      _handleStarRemove = mod?.handleStarRemove ?? null;
    }
    if (_handleStarRemove) {
      try { await _handleStarRemove(client, reaction); } catch { /* non-fatal */ }
    }

    // ── Advanced poll un-vote (!advpoll) ──────────────────────────────────
    if (!_advPoll) _advPoll = await import('../../handlers/advPoll.js').catch(() => null);
    if (_advPoll) {
      const poll = _advPoll.getActivePollByMessage(messageId);
      if (poll) {
        const options = _advPoll.getOptions(poll.id);
        const matchedOption = options.find(o => sameEmoji(o.emoji, key));
        if (matchedOption) {
          _advPoll.removeVote(poll.id, matchedOption.idx, userId);
          await _advPoll.refreshPollEmbed(client, poll.id);
        }
        return;
      }
    }

    // ── Simple reaction role removal ──────────────────────────────────────
    const simpleRoleId = getRoleId(guildId, messageId, key);
    if (simpleRoleId) {
      try {
        await client.rest.delete(
          `/guilds/${guildId}/members/${userId}/roles/${simpleRoleId}`
        );
      } catch { /* best effort */ }
      return;
    }

    // ── Role menu removal ─────────────────────────────────────────────────
    if (!_getMenuByMessage) {
      const mod = await import('../../handlers/rolemenus.js').catch(() => null);
      _getMenuByMessage = mod?.getMenuByMessage ?? (() => null);
      _getMenuEntries   = mod?.getMenuEntries   ?? (() => []);
    }

    const menu = _getMenuByMessage(guildId, messageId);
    if (!menu) return;

    const entries = _getMenuEntries(menu.id);
    const entry   = entries.find(e => sameEmoji(e.emoji, key));
    if (!entry) return;

    try {
      await client.rest.delete(
        `/guilds/${guildId}/members/${userId}/roles/${entry.role_id}`
      );
    } catch { /* best effort */ }
  },
};
