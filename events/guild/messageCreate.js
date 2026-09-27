import { Events } from '@fluxerjs/core';
import { handleMessage } from '../../handlers/commandHandler.js';
import * as resilience from '../../handlers/resilience.js';

// Lazy imports, handlers loaded on first use to avoid circular deps at boot
let _handleXpMessage  = null;
let _runWordFilter    = null;
let _runAutomod       = null;
let _enforceLink      = null;
let _captureMessage   = null;
let _logMessageSent   = null;
let _recordActivity   = null;
let _handleAppealDM   = null;
let _handleConfessDM  = null;
let _handleDmResponse = null;
let _relayEcho        = null;
let _auditLinks       = null;

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(client, message) {
    // Gateway-activity bumping (for the watchdog's WS-silence check) now
    // happens once, generically, in events/client/ready.js via
    // client.ws.on('dispatch', ...), which covers this event too.

    if (message.author?.bot) return;

    // ── DM routing, appeal, confession, and captcha DM handlers ──────────
    if (!message.guildId) {
      const content = message.content?.trim().toLowerCase() ?? '';
      if (content.startsWith('appeal ')) {
        if (!_handleAppealDM) {
          try { ({ handleAppealDM: _handleAppealDM } = await import('../../commands/moderation/appeal.js')); } catch { _handleAppealDM = () => {}; }
        }
        await _handleAppealDM(message, client).catch(() => {});
        return;
      }
      if (content.startsWith('confess ') || content.startsWith('confessreply ')) {
        if (!_handleConfessDM) {
          try { ({ handleConfessDM: _handleConfessDM } = await import('../../commands/fun/confess.js')); } catch { _handleConfessDM = () => {}; }
        }
        await _handleConfessDM(message, client).catch(() => {});
        return;
      }

      // ── DM captcha response ─────────────────────────────────────────────
      if (!_handleDmResponse) {
        const mod = await import('../../handlers/antiRaid/index.js').catch(() => null);
        _handleDmResponse = mod?.handleDmResponse ?? null;
      }
      if (_handleDmResponse) {
        try {
          // db.js only has a default export, `const { db } = ...` always
          // destructured undefined, so db.prepare() below threw a TypeError
          // caught by this block's own try/catch, silently. That made every
          // DM reply to an in-DM captcha do nothing at all, the member's
          // code was never even looked up, let alone checked.
          const { default: db } = await import('../../db.js');
          const sessions = db.prepare(
            `SELECT guild_id FROM dm_captcha_sessions WHERE user_id = ? AND expires_at > unixepoch()`
          ).all(message.author.id);

          for (const { guild_id } of sessions) {
            const result = await _handleDmResponse(client, guild_id, message.author.id, message.content ?? '');
            if (result.expired) {
              await message.reply('Your verification session has expired. Please rejoin the server to get a new code.').catch(() => {});
            } else if (result.tooManyAttempts) {
              await message.reply('Too many incorrect attempts. Please rejoin the server to restart verification.').catch(() => {});
            } else if (result.verified) {
              await message.reply('You\'re verified! You now have access to the server.').catch(() => {});
            } else if (result.roleFailed) {
              await message.reply('Code correct, but I couldn\'t assign your role. Please contact a server admin.').catch(() => {});
            } else if (typeof result.remaining === 'number') {
              await message.reply(`Incorrect code. **${result.remaining}** attempt${result.remaining === 1 ? '' : 's'} remaining.`).catch(() => {});
            }
            return;
          }
        } catch { /* non-fatal */ }
      }

      // Anything else falls through to the command handler's own small
      // DM-allowlist (currently just `remind`), everything else it sees
      // gets silently ignored there too.
      await handleMessage(client, message);
      return;
    }

    // ── Cross-server echo relay (light, publisher-channel check is a cheap
    // indexed lookup, real work only happens for the rare message that's
    // actually posted in a registered publisher channel) ───────────────────
    if (!_relayEcho) {
      const mod = await import('../../handlers/echoSystem.js').catch(() => null);
      _relayEcho = mod?.relayEcho ?? (() => {});
    }
    await resilience.runLight('echoSystem.relayEcho', () => _relayEcho(client, message));

    // ── Ticket transcript capture (light, part of ticketSystem, not the
    // hot path itself) ─────────────────────────────────────────────────────
    // Deliberately ahead of the `!message.content` bail below: an
    // image/attachment-only message (no text) is exactly the kind of thing
    // that shows up in a ticket and still needs to end up in the transcript,
    // not just text messages.
    if (!_captureMessage) {
      const mod = await import('../../handlers/ticketTranscript.js').catch(() => null);
      _captureMessage = mod?.captureMessage ?? (() => {});
    }
    await resilience.runLight('ticketSystem.captureMessage', () => _captureMessage(message));

    if (!message.content)     return;

    // ── XP (light) ──────────────────────────────────────────────────────────
    if (!_handleXpMessage) {
      const mod = await import('../../handlers/xpSystem.js').catch(() => null);
      _handleXpMessage = mod?.handleXpMessage ?? (() => {});
    }
    await resilience.runLight('xp.handleMessage', () => _handleXpMessage(client, message));

    // ── Analytics (light) ────────────────────────────────────────────────────
    if (!_recordActivity) {
      const mod = await import('../../handlers/analyticsSystem.js').catch(() => null);
      _recordActivity = mod?.recordActivity ?? (() => {});
    }
    await resilience.runLight('analytics.recordActivity', () => _recordActivity(message.guildId, message.author.id));

    // ── Message log (light) ──────────────────────────────────────────────────
    if (!_logMessageSent) {
      const mod = await import('../../handlers/messageLogger.js').catch(() => null);
      _logMessageSent = mod?.logMessageSent ?? (() => {});
    }
    await resilience.runLight('messageLogger.logMessageSent', () => _logMessageSent(client, message));

    // ── Automod (critical) ───────────────────────────────────────────────────
    if (!_runAutomod) {
      const mod = await import('../../handlers/automod.js').catch(() => null);
      _runAutomod = mod?.runAutomod ?? (() => false);
    }
    const automodBlocked = await resilience.runCritical('automod.run', () => _runAutomod(client, message), { fallback: false });
    if (automodBlocked) return;

    // ── Word filter (critical) ───────────────────────────────────────────────
    if (!_runWordFilter) {
      const mod = await import('../../handlers/wordFilter.js').catch(() => null);
      _runWordFilter = mod?.runWordFilter ?? (() => false);
    }
    const wordFilterBlocked = await resilience.runCritical('wordFilter.run', () => _runWordFilter(client, message), { fallback: false });
    if (wordFilterBlocked) return;

    // ── Link enforcement (critical) ──────────────────────────────────────────
    // Was runLight when this only ever deleted a message. Now that its
    // severity/age_gate/strike modes can also timeout, kick, or ban, it
    // matches CONTRIBUTING.internal.md's own criteria for the critical tier
    // (automod, the word filter, anything gating who can access a server),
    // same as the two handlers directly above it.
    if (!_enforceLink) {
      const mod = await import('../../handlers/linkEnforcement.js').catch(() => null);
      _enforceLink = mod?.enforceLink ?? (() => false);
    }
    const linkBlocked = await resilience.runCritical('linkEnforcement.enforceLink', () => _enforceLink(client, message), { fallback: false });
    // Same as automod/word filter above: a removed message stops here. The
    // link auditor below used to repost it anyway, putting the blocked link
    // straight back into the channel under the bot's name.
    if (linkBlocked) return;

    // ── Link Auditor (light) ──────────────────────────────────────────────
    if (!_auditLinks) {
      const mod = await import('../../handlers/linkAuditor.js').catch(() => null);
      _auditLinks = mod?.auditMessage ?? (() => {});
    }
    await resilience.runLight('linkAuditor.auditMessage', () => _auditLinks(client, message));

    // ── Command routing ───────────────────────────────────────────────────
    // Custom commands/tags are resolved inside handleMessage, after real
    // commands and aliases, the shadow-ban check, and channel restrictions.
    // They used to run first here, so a tag named "ban" replaced !ban for
    // everyone and shadow-banned users could still trigger tags.
    await handleMessage(client, message);
  },
};
