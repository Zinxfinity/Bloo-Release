import { Events } from '@fluxerjs/core';
import { getMemberRoleIds } from '../../config/guildPermissions.js';
import { updateMemberRoles } from '../../handlers/memberTracking.js';

let _logNickChange    = null;
let _logRoleChange    = null;

export default {
  name: Events.GuildMemberUpdate,
  once: false,

  async execute(client, oldMember, newMember) {
    const guildId = newMember.guild?.id ?? newMember.guildId;
    const userId  = newMember.user?.id  ?? newMember.id;
    if (!guildId || !userId) return;

    // ── Detect role changes ───────────────────────────────────────────────
    const oldIds = new Set(getMemberRoleIds(oldMember));
    const newIds = new Set(getMemberRoleIds(newMember));

    const rolesChanged = [...oldIds].some(id => !newIds.has(id))
                      || [...newIds].some(id => !oldIds.has(id));

    // Keep the leave-time role snapshot fresh regardless of whether this
    // diff actually changed anything, cheap and keeps member_tracking from
    // ever going stale between real role changes.
    try { updateMemberRoles(guildId, userId, [...newIds]); } catch { /* non-fatal */ }

    if (rolesChanged) {
      // Log role change to activity log
      if (!_logRoleChange) {
        const mod = await import('../../handlers/activityLog.js').catch(() => null);
        _logRoleChange = mod?.logRoleChange ?? (() => {});
      }
      try {
        const gained = [...newIds].filter(id => !oldIds.has(id));
        const lost   = [...oldIds].filter(id => !newIds.has(id));
        await _logRoleChange(client, guildId, userId, gained, lost);
      } catch { /* non-fatal */ }
    }

    // ── Detect nickname change ────────────────────────────────────────────
    // oldMember is null when the member wasn't in the local cache.
    const oldNick = oldMember?.nick ?? null;
    const newNick = newMember.nick ?? null;

    if (oldNick !== newNick) {
      if (!_logNickChange) {
        const mod = await import('../../handlers/activityLog.js').catch(() => null);
        _logNickChange = mod?.logNickChange ?? (() => {});
      }
      try { await _logNickChange(client, guildId, userId, oldNick, newNick); } catch { /* non-fatal */ }
    }
  },
};
