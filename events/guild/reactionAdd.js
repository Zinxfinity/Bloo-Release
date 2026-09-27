import { Events } from '@fluxerjs/core';
import {
  emojiKey,
  sameEmoji,
  emojiRoute,
  getRoleId,
  isReactionSuppressed,
  suppressReaction,
  checkRoleAccess,
} from '../../handlers/reactionRoles.js';
import { getMemberRoleIds } from '../../config/guildPermissions.js';
import * as resilience from '../../handlers/resilience.js';
import logger from '../../utils/logger.js';

let _getMenuByMessage          = null;
let _getMenuEntries            = null;
let _stripExclusiveGroup       = null;
let _handleTicketReaction      = null;
let _handleCloseReaction       = null;
let _handleGiveawayReaction    = null;
let _handleStarReaction        = null;
let _getStarboardConfig        = null;
let _handleBanApprovalReaction = null;
let _handlePagination          = null;
let _antiRaid                  = null;
let _tempConvert               = null;
let _advPoll                   = null;

// Fluxer's thermometer emoji, no variation selector: emojiKey already
// strips U+FE0F from the incoming reaction (same reasoning as emojiKey
// itself), so the comparison target needs to be pre-stripped too.
const TEMP_EMOJI = '🌡️'.replace(/️/g, '');

export default {
  name: Events.MessageReactionAdd,
  once: false,

  async execute(client, payload) {
    // The SDK emits a single payload object: { reaction, user, messageId,
    // channelId, emoji, userId }. `reaction` is the MessageReaction instance
    // (it carries guildId, the top-level payload does not).
    const { reaction, user, emoji, userId, messageId, channelId } = payload;
    const guildId = reaction?.guildId;

    if (!guildId || !userId) return;

    // Ignore bot reactions
    const reactingUser = user ?? await client.users.fetch(userId).catch(() => null);
    if (reactingUser?.bot) return;

    // ── Pagination ────────────────────────────────────────────────────────
    if (!_handlePagination) {
      const mod = await import('../../handlers/paginationManager.js').catch(() => null);
      _handlePagination = mod?.handlePaginationReaction ?? null;
    }
    if (_handlePagination) {
      try {
        const handled = await _handlePagination(reaction, userId);
        if (handled) return;
      } catch { /* non-fatal */ }
    }

    const key = emojiKey(emoji);

    // ── Suppression check (bot-initiated reactions) ───────────────────────
    // Some clients re-send a reaction add a couple of seconds after the
    // first one (observed consistently in testing, looks like a client-side
    // retry), which lands here as a duplicate while we're still suppressed
    // from cleaning up the first one. Still remove the lingering reaction
    // (harmless no-op via the API if it's already gone) so it doesn't sit on
    // the message forever, just don't re-toggle/re-grant/re-revoke anything
    // a second time. Covers both simple reaction-roles and role menus, any
    // reaction that interacts with a role can produce this duplicate.
    if (isReactionSuppressed(channelId, messageId, key, userId)) {
      if (!_getMenuByMessage) {
        const mod = await import('../../handlers/rolemenus.js').catch(() => null);
        _getMenuByMessage    = mod?.getMenuByMessage    ?? (() => null);
        _getMenuEntries      = mod?.getMenuEntries      ?? (() => []);
        _stripExclusiveGroup = mod?.stripExclusiveGroupRoles ?? (() => {});
      }
      const dupMenu       = _getMenuByMessage(guildId, messageId);
      const dupIsMenuEntry = dupMenu && _getMenuEntries(dupMenu.id).some(e => sameEmoji(e.emoji, key));
      const dupRoleId      = getRoleId(guildId, messageId, key);

      if (dupRoleId || dupIsMenuEntry) {
        try {
          const emojiEnc = emojiRoute(key);
          await client.rest.delete(`/channels/${channelId}/messages/${messageId}/reactions/${emojiEnc}/${userId}`);
        } catch { /* best effort */ }
      }
      return;
    }

    // ── Ban approval reactions (✅ / ❌ on approval embeds) (critical) ──────
    if (!_handleBanApprovalReaction) {
      const mod = await import('../../handlers/banApproval.js').catch(() => null);
      _handleBanApprovalReaction = mod?.handleBanApprovalReaction ?? null;
    }
    if (_handleBanApprovalReaction) {
      const handled = await resilience.runCritical(
        'banSystem.handleBanApprovalReaction',
        () => _handleBanApprovalReaction(client, reaction, userId, guildId, channelId, messageId, emoji),
        { fallback: false }
      );
      if (handled) return;
    }

    // ── Ticket panel reaction (critical) ──────────────────────────────────
    if (!_handleTicketReaction) {
      const mod = await import('../../handlers/ticketSystem/index.js').catch(() => null);
      _handleTicketReaction = mod?.handleTicketReaction ?? null;
    }
    if (_handleTicketReaction) {
      const handled = await resilience.runCritical(
        'ticketSystem.handleTicketReaction',
        () => _handleTicketReaction(client, reaction, userId, guildId, channelId, messageId, emoji),
        { fallback: false }
      );
      if (handled) return;
    }

    // ── Ticket close reaction (guild-configurable emoji, default ❌) ───────
    // Works on any message in an open ticket channel, not a specific
    // registered one, matching how !close targets the channel itself.
    if (!_handleCloseReaction) {
      const mod = await import('../../handlers/ticketSystem/index.js').catch(() => null);
      _handleCloseReaction = mod?.handleCloseReaction ?? null;
    }
    if (_handleCloseReaction) {
      const handled = await resilience.runCritical(
        'ticketSystem.handleCloseReaction',
        () => _handleCloseReaction(client, guildId, channelId, key, userId, reactingUser),
        { fallback: false }
      );
      if (handled) return;
    }

    // ── React-to-verify (✅ on !verify's one-off prompt, or the standing
    // antiraid panel) ───────────────────────────────────────────────────────
    // Previously dead code: postVerifyPanel never registered its message and
    // this handler never checked the registry at all, so reacting did
    // nothing on either the prompt or the panel.
    if (key === '✅') {
      if (!_antiRaid) _antiRaid = await import('../../handlers/antiRaid/index.js').catch(() => null);
      const verifyGuildId = _antiRaid?.getVerifyMessageGuildId?.(channelId, messageId);
      if (verifyGuildId) {
        try {
          const config = _antiRaid.getAntiRaidConfig(verifyGuildId);
          const member = await client.rest.get(`/guilds/${verifyGuildId}/members/${userId}`).catch(() => null);
          await _antiRaid.sendVerification(client, verifyGuildId, userId, member, config);
        } catch (err) {
          logger.warn(`[VERIFY] react-to-verify dispatch failed for ${userId} in ${verifyGuildId}:`, err.message);
        }
        // Never unregister the standing panel, every future member needs to
        // react on the same persistent message.
        if (!_antiRaid.isVerifyMessagePersistent(channelId, messageId)) {
          _antiRaid.unregisterVerifyMessage(channelId, messageId);
        }
        try {
          const emojiEnc = emojiRoute(key);
          await client.rest.delete(`/channels/${channelId}/messages/${messageId}/reactions/${emojiEnc}/${userId}`);
        } catch { /* best effort, never touches the bot's own ✅ */ }
        return;
      }
    }

    // ── Temperature conversion (🌡️ react on a message mentioning one) ──────
    // Not tied to any registered panel/menu, unlike the branches above, so
    // this always re-parses the reacted-on message fresh rather than
    // needing a lookup table. Doesn't return early on a miss (no
    // temperature found, or an excluded channel), so 🌡️ can still double
    // as a normal reaction-role emoji if a guild happens to use it as one.
    if (key === TEMP_EMOJI) {
      if (!_tempConvert) _tempConvert = await import('../../handlers/tempConvert.js').catch(() => null);
      if (_tempConvert) {
        try {
          const channel = await client.rest.get(`/channels/${channelId}`).catch(() => null);
          if (!_tempConvert.isTempConversionDisabledChannel(channel)) {
            const message = await client.rest.get(`/channels/${channelId}/messages/${messageId}`).catch(() => null);
            const conversions = _tempConvert.parseTemperatures(message?.content ?? '');
            if (conversions.length) {
              const content = conversions.map(c => `🌡️ ${c.original} → **${c.converted}**`).join('\n');
              const sent = await client.rest.post(`/channels/${channelId}/messages`, {
                body: { content, message_reference: { message_id: messageId } },
              }).catch(() => null);
              if (sent?.id) {
                // Auto-delete after 10s, this is a quick drive-by reply,
                // not meant to linger in the channel permanently.
                setTimeout(() => {
                  client.rest.delete(`/channels/${channelId}/messages/${sent.id}`).catch(() => {});
                }, 10_000);
              }
              return;
            }
          }
        } catch (err) {
          logger.warn(`[TEMPCONVERT] Failed for message ${messageId} in ${channelId}:`, err.message);
        }
      }
    }

    // ── Advanced poll voting (!advpoll) ───────────────────────────────────
    // Tracked by message id like giveaways/starboard below, checked here
    // (before simple reaction-roles) since a poll's numbered emoji could in
    // principle collide with an unrelated reaction-role setup on the same
    // guild, message-id-scoped lookup makes that safe either way.
    if (!_advPoll) _advPoll = await import('../../handlers/advPoll.js').catch(() => null);
    if (_advPoll) {
      const poll = _advPoll.getActivePollByMessage(messageId);
      if (poll) {
        if (key === _advPoll.CLOSE_EMOJI) {
          let allowed = poll.host_id === userId;
          if (!allowed) {
            try {
              const { resolveAccess } = await import('../../handlers/commandPermissions.js');
              const { Permissions } = await import('../../config/guildPermissions.js');
              allowed = await resolveAccess(client, guildId, userId, 'advpoll', Permissions.KICK_MEMBERS);
            } catch { /* non-fatal, defaults to denied */ }
          }
          if (allowed) {
            _advPoll.closePoll(poll.id, userId);
            await _advPoll.refreshPollEmbed(client, poll.id);
          } else {
            try {
              const emojiEnc = emojiRoute(key);
              await client.rest.delete(`/channels/${channelId}/messages/${messageId}/reactions/${emojiEnc}/${userId}`);
            } catch { /* best effort */ }
          }
          return;
        }

        const options = _advPoll.getOptions(poll.id);
        const matchedOption = options.find(o => sameEmoji(o.emoji, key));
        if (!matchedOption) {
          // Not one of this poll's own numbered reactions, strip it so
          // people can't clutter the poll with random emoji.
          try {
            const emojiEnc = emojiRoute(key);
            await client.rest.delete(`/channels/${channelId}/messages/${messageId}/reactions/${emojiEnc}/${userId}`);
          } catch { /* best effort */ }
          return;
        }

        const removedOthers = _advPoll.castVote(poll.id, matchedOption.idx, userId, poll.mode);
        for (const otherIdx of removedOthers) {
          const otherOpt = options.find(o => o.idx === otherIdx);
          if (!otherOpt) continue;
          try {
            // Suppress first, same reasoning as reaction-roles below: this
            // delete fires its own MessageReactionRemove, without
            // suppression the remove handler would read that echo as a
            // genuine un-vote and delete the vote we just recorded above.
            suppressReaction(channelId, messageId, otherOpt.emoji, userId);
            const emojiEnc = encodeURIComponent(otherOpt.emoji);
            await client.rest.delete(`/channels/${channelId}/messages/${messageId}/reactions/${emojiEnc}/${userId}`);
          } catch { /* best effort */ }
        }
        await _advPoll.refreshPollEmbed(client, poll.id);
        return;
      }
    }

    // ── Simple reaction roles ─────────────────────────────────────────────
    // Toggle: react to get the role, react again (the reaction gets cleared
    // below each time, so re-reacting is how you take it off) to remove it.
    // The reaction itself never sticks around either way.
    const simpleRoleId = getRoleId(guildId, messageId, key);
    if (simpleRoleId) {
      try {
        const member  = await client.rest.get(`/guilds/${guildId}/members/${userId}`).catch(() => null);
        const hasRole = member?.roles?.includes(simpleRoleId) ?? false;

        if (hasRole) {
          await client.rest.delete(`/guilds/${guildId}/members/${userId}/roles/${simpleRoleId}`);
        } else {
          await client.rest.put(`/guilds/${guildId}/members/${userId}/roles/${simpleRoleId}`);
        }

        // Suppress first, the delete below fires its own
        // MessageReactionRemove, and without this the remove-event handler
        // would read that echo as a real unreact and immediately revoke
        // whatever we just did here.
        suppressReaction(channelId, messageId, key, userId);
        const emojiEnc = emojiRoute(key);
        await client.rest.delete(
          `/channels/${channelId}/messages/${messageId}/reactions/${emojiEnc}/${userId}`
        );
      } catch (err) {
        logger.warn(`[RR] Reaction-role toggle failed for role ${simpleRoleId} in guild ${guildId}:`, err.message);
      }
      return;
    }

    // ── Giveaway entry ────────────────────────────────────────────────────
    if (!_handleGiveawayReaction) {
      const mod = await import('../../handlers/giveawaySystem.js').catch(() => null);
      _handleGiveawayReaction = mod?.handleGiveawayReaction ?? null;
    }
    if (_handleGiveawayReaction && key === '🎉') {
      try {
        const { getGiveawayByMessage } = await import('../../handlers/giveawaySystem.js');
        const gw = getGiveawayByMessage(messageId);
        if (gw) {
          await _handleGiveawayReaction(client, gw.id, userId);
          return;
        }
      } catch { /* non-fatal */ }
    }

    // ── Starboard, only fire when the emoji matches the guild's configured emoji
    if (!_handleStarReaction) {
      const mod = await import('../../handlers/starboard.js').catch(() => null);
      _handleStarReaction = mod?.handleStarReaction ?? null;
      _getStarboardConfig = mod?.getStarboardConfig ?? null;
    }
    if (_handleStarReaction && _getStarboardConfig) {
      try {
        const sbCfg = _getStarboardConfig(guildId);
        if (sbCfg?.enabled && sbCfg.channel_id) {
          const { resolveConfigEmoji } = await import('../../handlers/starboard.js');
          if (key === resolveConfigEmoji(sbCfg.emoji)) {
            await _handleStarReaction(client, reaction, userId);
          }
        }
      } catch { /* non-fatal */ }
    }

    // ── Role menus ────────────────────────────────────────────────────────
    if (!_getMenuByMessage) {
      const mod = await import('../../handlers/rolemenus.js').catch(() => null);
      _getMenuByMessage    = mod?.getMenuByMessage    ?? (() => null);
      _getMenuEntries      = mod?.getMenuEntries      ?? (() => []);
      _stripExclusiveGroup = mod?.stripExclusiveGroupRoles ?? (() => {});
    }

    const menu = _getMenuByMessage(guildId, messageId);
    if (!menu) return;

    const entries = _getMenuEntries(menu.id);
    const entry   = entries.find(e => sameEmoji(e.emoji, key));
    if (!entry) return;

    // Fetch member for role list
    const member = await client.rest.get(`/guilds/${guildId}/members/${userId}`).catch(() => null);
    const memberRoleIds = member
      ? (member.roles ?? [])
      : [];

    // Toggle: already have this entry's role → remove it and the reaction,
    // same shape as simple reaction-roles. Skips the access/max-picks checks
    // below, those only gate granting a new role, not giving one up.
    if (memberRoleIds.includes(entry.role_id)) {
      try {
        await client.rest.delete(`/guilds/${guildId}/members/${userId}/roles/${entry.role_id}`);
        suppressReaction(channelId, messageId, key, userId);
        const emojiEnc = emojiRoute(key);
        await client.rest.delete(
          `/channels/${channelId}/messages/${messageId}/reactions/${emojiEnc}/${userId}`
        );
      } catch (err) {
        logger.warn(`[RR] Role-menu toggle-off failed for role ${entry.role_id} in guild ${guildId}:`, err.message);
      }
      return;
    }

    // Role access block check
    const access = checkRoleAccess(guildId, menu.id, entry.role_id, memberRoleIds);
    if (!access.allowed) {
      // Remove the reaction silently
      try {
        suppressReaction(channelId, messageId, key, userId);
        const emojiEnc = emojiRoute(key);
        await client.rest.delete(
          `/channels/${channelId}/messages/${messageId}/reactions/${emojiEnc}/${userId}`
        );
      } catch { /* best effort */ }
      return;
    }

    // Max picks enforcement. Skipped when the menu is also exclusive:
    // exclusive already means "at most one role, picking a new one swaps
    // out the old", a stronger constraint that subsumes max_picks. Without
    // this, a menu configured with both (the dashboard's own config form
    // shows Exclusive and Max Roles side by side, nothing stops setting
    // both) would hit this check first, see the member already at the cap
    // from their current pick, and silently reject the swap, reaction
    // deleted, before the exclusive-swap logic below ever runs.
    if (menu.max_picks > 0 && !menu.exclusive) {
      const currentPicks = entries.filter(e => memberRoleIds.includes(e.role_id)).length;
      if (currentPicks >= menu.max_picks) {
        try {
          suppressReaction(channelId, messageId, key, userId);
          const emojiEnc = emojiRoute(key);
          await client.rest.delete(
            `/channels/${channelId}/messages/${messageId}/reactions/${emojiEnc}/${userId}`
          );
        } catch { /* best effort */ }
        return;
      }
    }

    // Exclusive mode, remove other roles from same menu
    if (menu.exclusive) {
      for (const other of entries) {
        if (other.role_id === entry.role_id) continue;
        if (!memberRoleIds.includes(other.role_id)) continue;
        try {
          await client.rest.delete(
            `/guilds/${guildId}/members/${userId}/roles/${other.role_id}`
          );
          // Remove the other reaction too
          suppressReaction(channelId, messageId, other.emoji, userId);
          const otherEnc = emojiRoute(other.emoji);
          await client.rest.delete(
            `/channels/${channelId}/messages/${messageId}/reactions/${otherEnc}/${userId}`
          );
        } catch (err) {
          // Was fully silent before, a hierarchy/permission failure here
          // (bot's top role sitting below `other.role_id`) looks identical
          // to "nothing happened" from the user's side with zero trace in
          // the logs. Surface it instead of swallowing it.
          logger.warn(`[RR] Exclusive-mode role removal failed for role ${other.role_id} (menu ${menu.id}, user ${userId}, guild ${guildId}):`, err.message);
        }
      }
    }

    // Assign role
    try {
      await client.rest.put(
        `/guilds/${guildId}/members/${userId}/roles/${entry.role_id}`
      );
    } catch (err) {
      logger.warn(`[RR] Role-menu grant failed for role ${entry.role_id} (menu ${menu.id}, user ${userId}, guild ${guildId}):`, err.message);
    }

    // Exclusive group stripping (sibling menus)
    try {
      await _stripExclusiveGroup(client, guildId, menu.id, userId, entry.role_id);
    } catch (err) {
      logger.warn(`[RR] Exclusive-group role stripping failed (menu ${menu.id}, user ${userId}, guild ${guildId}):`, err.message);
    }

    // Remove the triggering reaction now that the role is granted, mirroring
    // simple reaction-roles. Re-reacting (toggle branch above) is how picks
    // get removed, since the reaction never lingers either way.
    try {
      suppressReaction(channelId, messageId, key, userId);
      const emojiEnc = emojiRoute(key);
      await client.rest.delete(
        `/channels/${channelId}/messages/${messageId}/reactions/${emojiEnc}/${userId}`
      );
    } catch (err) {
      logger.warn(`[RR] Role-menu reaction cleanup failed for role ${entry.role_id} in guild ${guildId}:`, err.message);
    }
  },
};
