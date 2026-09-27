import { Events } from '@fluxerjs/core';

let _sendGoodbye   = null;
let _snapshotRoles = null;
let _recordLeave   = null;
let _logLeave      = null;

export default {
  name: Events.GuildMemberRemove,
  once: false,

  async execute(client, member) {
    // v3: member is a PartialGuildMember when uncached (member.partial === true),
    // guaranteeing only id/guildId/user/guild, exactly the fields read below.
    // Deeper fields (roles, joinedAt, etc.) are read defensively downstream in
    // rolePersist/welcomeSystem/activityLog and already degrade gracefully
    // when missing rather than throwing.
    const guildId = member.guild?.id ?? member.guildId;
    if (!guildId) return;

    // ── Role persist snapshot (must happen before goodbye) ────────────────
    if (!_snapshotRoles) {
      const mod = await import('../../handlers/rolePersist.js').catch(() => null);
      _snapshotRoles = mod?.snapshotRoles ?? (() => {});
    }
    try { _snapshotRoles(member); } catch { /* non-fatal */ }

    // ── Analytics ─────────────────────────────────────────────────────────
    if (!_recordLeave) {
      const mod = await import('../../handlers/analyticsSystem.js').catch(() => null);
      _recordLeave = mod?.recordLeave ?? (() => {});
    }
    try { _recordLeave(guildId, member.user?.id ?? member.id); } catch { /* non-fatal */ }

    // ── Goodbye message ───────────────────────────────────────────────────
    if (!_sendGoodbye) {
      const mod = await import('../../handlers/welcomeSystem.js').catch(() => null);
      _sendGoodbye = mod?.sendGoodbye ?? (() => {});
    }
    try { await _sendGoodbye(client, member); } catch { /* non-fatal */ }

    // ── Modlog leave ──────────────────────────────────────────────────────
    if (!_logLeave) {
      const mod = await import('../../handlers/activityLog.js').catch(() => null);
      _logLeave = mod?.logMemberLeave ?? (() => {});
    }
    try { await _logLeave(client, member); } catch { /* non-fatal */ }
  },
};
