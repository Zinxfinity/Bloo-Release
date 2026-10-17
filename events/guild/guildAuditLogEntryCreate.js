// ============================================================
//  events/guild/guildAuditLogEntryCreate.js
//
//  Moderation done with Fluxer's own tools (the ban, kick and timeout
//  buttons) never passes through a Bloo command, so it used to be missing
//  from the case log, member history and the daily digest. Fluxer reports
//  each one as an audit log entry; this records bans, unbans, kicks and
//  timeouts as cases, the same as Bloo's own commands do.
//
//  Bloo's own actions are skipped: its commands record their case already,
//  and Fluxer lists the bot as the one who did them.
//  Cases only, nothing is posted to the mod log channel.
// ============================================================

import { Events } from '@fluxerjs/core';
import { recordCase, getCasesForUser } from '../../handlers/modLog.js';

// Fluxer audit log action types (@fluxerjs/types AuditLogActionType).
const MEMBER_KICK = 20, MEMBER_BAN_ADD = 22, MEMBER_BAN_REMOVE = 23, MEMBER_UPDATE = 24;
const TIMEOUT_KEY = /communication_?disabled_?until|timeout/i;

function actionFor(entry) {
  switch (entry.actionType) {
    case MEMBER_KICK:       return 'kick';
    case MEMBER_BAN_ADD:    return 'ban';
    case MEMBER_BAN_REMOVE: return 'unban';
    case MEMBER_UPDATE: {
      const change = (entry.changes ?? []).find(c => TIMEOUT_KEY.test(c.key ?? ''));
      if (!change) return null; // a nickname or role change, not moderation
      return change.newValue ? 'timeout' : 'timeout-remove';
    }
    default: return null;
  }
}

export default {
  name: Events.GuildAuditLogEntryCreate,
  once: false,

  async execute(client, entry) {
    const guildId = entry?.guildId;
    const targetId = entry?.targetId;
    if (!guildId || !targetId) return;
    if (entry.userId && entry.userId === client.user?.id) return;

    const action = actionFor(entry);
    if (!action) return;

    // Belt and braces: if a Bloo command already logged the same action on
    // the same member in the last two minutes, don't count it twice.
    const recent = getCasesForUser(guildId, targetId, 5)
      .find(c => c.action === action && Math.abs(Date.now() / 1000 - Number(c.created_at)) < 120);
    if (recent) return;

    const reason = entry.reason ? `${entry.reason} (done in Fluxer)` : 'Done in Fluxer';
    recordCase(guildId, action, targetId, entry.userId ?? 'unknown', reason, { source: 'fluxer', auditLogId: entry.id });
  },
};
