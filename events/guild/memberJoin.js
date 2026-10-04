import { Events } from '@fluxerjs/core';
import * as resilience from '../../handlers/resilience.js';
import { getMemberRoleIds } from '../../config/guildPermissions.js';
import { recordMemberJoin } from '../../handlers/memberTracking.js';
import logger from '../../utils/logger.js';

let _sendWelcome    = null;
let _handleJoin     = null;
let _recordJoin     = null;
let _logJoin        = null;
let _runWordFilter  = null;
let _rolePersist    = null;

export default {
  name: Events.GuildMemberAdd,
  once: false,

  async execute(client, member) {
    const guildId = member.guild?.id ?? member.guildId;
    logger.debug(`[JOIN] ${member.user?.id ?? member.id} joined ${guildId ?? 'an unknown server'}`);
    if (!guildId) return;

    // Snapshot joinedAt + current roles now, while this member object is
    // still full (not partial), so a later GuildMemberRemove (which v3
    // delivers as a PartialGuildMember lacking both) can still read them.
    // See handlers/memberTracking.js for why this exists.
    const userId = member.user?.id ?? member.id;
    const joinedAtMs = member.joinedAt instanceof Date
      ? member.joinedAt.getTime()
      : (member.joinedAt ? new Date(member.joinedAt).getTime() : Date.now());
    try { recordMemberJoin(guildId, userId, joinedAtMs, getMemberRoleIds(member)); } catch { /* non-fatal */ }

    // ── Anti-raid: Raid Mode account-age check + captcha (critical) ─────────
    // First, so an account Raid Mode removes never gets welcomed, autoroled
    // or its persisted roles restored.
    if (!_handleJoin) {
      const mod = await import('../../handlers/antiRaid/index.js').catch(() => null);
      _handleJoin = mod?.handleJoin ?? (() => false);
    }
    const removedByRaidMode = await resilience.runCritical('antiRaid.handleJoin', () => _handleJoin(client, member), { fallback: false });
    if (removedByRaidMode) return;

    // Watched user rejoining (alertWatchlist no-ops for anyone not watched).
    await resilience.runLight('watchlist.alertJoin', async () => {
      const { alertWatchlist } = await import('../../handlers/watchlist.js');
      await alertWatchlist(client, guildId, userId, 'Joined the server', null);
    });

    // ── Role persist (restore roles from previous leave) (light) ───────────
    if (!_rolePersist) {
      const mod = await import('../../handlers/rolePersist.js').catch(() => null);
      _rolePersist = mod?.restoreRoles ?? (() => {});
    }
    await resilience.runLight('rolePersist.restoreRoles', () => _rolePersist(client, member));

    // ── Analytics (light) ────────────────────────────────────────────────────
    if (!_recordJoin) {
      const mod = await import('../../handlers/analyticsSystem.js').catch(() => null);
      _recordJoin = mod?.recordJoin ?? (() => {});
    }
    await resilience.runLight('analytics.recordJoin', () => _recordJoin(guildId, member.user?.id ?? member.id));

    // ── Word filter, display name scan (critical) ───────────────────────────
    if (!_runWordFilter) {
      const mod = await import('../../handlers/wordFilter.js').catch(() => null);
      _runWordFilter = mod?.runWordFilterOnName ?? (() => {});
    }
    await resilience.runCritical('wordFilter.runOnName', () => {
      const name = member.displayName ?? member.nickname ?? member.user?.username ?? '';
      return _runWordFilter(client, guildId, member.user?.id ?? member.id, name);
    });

    // ── Welcome message + autorole (light) ───────────────────────────────────
    if (!_sendWelcome) {
      const mod = await import('../../handlers/welcomeSystem.js').catch(() => null);
      _sendWelcome = mod?.sendWelcome ?? (() => {});
    }
    await resilience.runLight('welcomeSystem.sendWelcome', () => _sendWelcome(client, member));

    // ── Modlog join (light) ──────────────────────────────────────────────────
    if (!_logJoin) {
      const mod = await import('../../handlers/activityLog.js').catch(() => null);
      _logJoin = mod?.logMemberJoin ?? (() => {});
    }
    await resilience.runLight('activityLog.logMemberJoin', () => _logJoin(client, member));
  },
};
