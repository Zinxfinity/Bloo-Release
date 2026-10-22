import db from '../db.js';
import logger from '../utils/logger.js';
import * as resilience from './resilience.js';
import { isChannelInGuild } from '../utils/channelGuard.js';
import { lockChannel, restoreChannel } from '../commands/moderation/lockdown.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    action     TEXT    NOT NULL,
    target_id  TEXT    NOT NULL,
    payload    TEXT    NOT NULL DEFAULT '{}',
    execute_at INTEGER NOT NULL,
    created_by TEXT    NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// Schema migrations for older installs that used different column names
for (const col of [
  `ALTER TABLE scheduled_actions ADD COLUMN payload TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE scheduled_actions ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE scheduled_actions ADD COLUMN action TEXT NOT NULL DEFAULT 'message'`,
  `ALTER TABLE scheduled_actions ADD COLUMN execute_at INTEGER`,
  `ALTER TABLE scheduled_actions ADD COLUMN done INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE scheduled_actions ADD COLUMN target_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE scheduled_actions ADD COLUMN created_by TEXT NOT NULL DEFAULT ''`,
]) {
  try { db.exec(col); } catch { /* column already exists */ }
}

// Backfill execute_at from legacy fires_at column if it exists and execute_at is null
try { db.exec(`UPDATE scheduled_actions SET execute_at = COALESCE(execute_at, fires_at) WHERE execute_at IS NULL`); } catch {}
// Backfill done from legacy fired column if it exists
try { db.exec(`UPDATE scheduled_actions SET done = COALESCE(done, fired) WHERE done IS NULL`); } catch {}
// Backfill action from legacy type column if it exists
try { db.exec(`UPDATE scheduled_actions SET action = COALESCE(NULLIF(action, ''), type) WHERE action IS NULL OR action = ''`); } catch {}

const stmts = {
  add:     db.prepare(`
    INSERT INTO scheduled_actions (guild_id, user_id, action, target_id, payload, execute_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getDue:  db.prepare(`SELECT * FROM scheduled_actions WHERE done = 0 AND execute_at <= unixepoch() LIMIT 50`),
  markDone: db.prepare(`UPDATE scheduled_actions SET done = 1 WHERE id = ?`),
  list:    db.prepare(`SELECT * FROM scheduled_actions WHERE guild_id = ? AND done = 0 ORDER BY execute_at ASC`),
  delete:  db.prepare(`DELETE FROM scheduled_actions WHERE id = ? AND guild_id = ?`),
};

export function scheduleAction(guildId, action, targetId, payload, executeAt, createdBy, userId = null) {
  // userId defaults to createdBy for backwards compat (caller may scope to a different user)
  return stmts.add.run(
    guildId,
    userId ?? createdBy,
    action,
    targetId,
    JSON.stringify(payload),
    executeAt,
    createdBy,
  ).lastInsertRowid;
}

export function listScheduled(guildId) {
  return stmts.list.all(guildId).map(r => {
    let payload = {};
    try { payload = JSON.parse(r.payload ?? '{}'); } catch { /* malformed row */ }
    return { ...r, payload };
  });
}

// True when something was cancelled.
export function cancelScheduled(guildId, actionId) {
  return stmts.delete.run(actionId, guildId).changes > 0;
}

// What b!schedule and the dashboard's Scheduled Actions page can set up.
export const SCHEDULE_TYPES = ['message', 'announcement', 'lock', 'unlock'];
export const SCHEDULE_MAX_CONTENT = 2000;

// ─── initSchedule ─────────────────────────────────────────────────────────────
let _schedTimer = null;

export function initSchedule(client) {
  if (_schedTimer) return;

  const tick = async () => {
    const due = stmts.getDue.all();
    for (const action of due) {
      stmts.markDone.run(action.id);
      let payload = {};
      try { payload = JSON.parse(action.payload || '{}'); } catch { /* skip corrupt row */ continue; }

      try {
        if (action.action === 'message' || action.action === 'announcement') {
          // Rows created before the command checked channel ownership could
          // point at another server's channel; re-check at fire time.
          if (!await isChannelInGuild(client, action.guild_id, action.target_id)) {
            logger.warn(`[SCHEDULE] Action ${action.id} skipped: channel ${action.target_id} is not in guild ${action.guild_id}`);
            continue;
          }
          // Raw REST, not client.channels.fetch() + channel.send(): confirmed
          // in production that pattern fails with "channel.send is not a
          // function" for at least one channel type on v2.0.1's SDK.
          // Staff-authored, so user/role pings stay; @everyone/@here don't.
          await client.rest.post(`/channels/${action.target_id}/messages`, {
            body: {
              content: payload.content || 'Scheduled announcement.',
              allowed_mentions: { parse: ['users', 'roles'] },
            },
          });
        } else if (action.action === 'lock') {
          // Same snapshot + bit-merge path as !lockdown, so a scheduled lock
          // can't make a private channel public and a later unlock restores
          // the real pre-lock state.
          if (!await lockChannel(client, action.guild_id, action.target_id)) {
            logger.warn(`[SCHEDULE] Action ${action.id} lock failed for channel ${action.target_id}`);
          }
        } else if (action.action === 'unlock') {
          if (!await restoreChannel(client, action.guild_id, action.target_id)) {
            logger.warn(`[SCHEDULE] Action ${action.id} unlock failed for channel ${action.target_id}`);
          }
        }
      } catch (err) {
        logger.warn(`[SCHEDULE] Action ${action.id} (${action.action}) failed:`, err.message);
      }
    }
  };

  resilience.runLight('scheduleSystem.tick', tick);
  _schedTimer = setInterval(() => resilience.runLight('scheduleSystem.tick', tick), 30_000);
  _schedTimer.unref?.();
  logger.info('[SCHEDULE] Scheduler started (30s interval).');
}

// ─── getPendingForUser ────────────────────────────────────────────────────────
// Returns all pending (done=0) scheduled actions for a user by action type.
export function getPendingForUser(userId, action) {
  return db.prepare(`
    SELECT * FROM scheduled_actions
    WHERE user_id = ? AND action = ? AND done = 0
    ORDER BY execute_at ASC
  `).all(userId, action);
}

// ─── getPendingForGuildUser ───────────────────────────────────────────────────
// Returns pending scheduled actions for a user scoped to a specific guild.
export function getPendingForGuildUser(guildId, userId, action) {
  return db.prepare(`
    SELECT * FROM scheduled_actions
    WHERE guild_id = ? AND user_id = ? AND action = ? AND done = 0
    ORDER BY execute_at ASC
  `).all(guildId, userId, action);
}

// ─── cancelAction ─────────────────────────────────────────────────────────────
// Mark a scheduled action as done (cancel it). Returns true if found.
export function cancelAction(userId, actionId) {
  const result = db.prepare(
    'UPDATE scheduled_actions SET done = 1 WHERE id = ? AND user_id = ? AND done = 0'
  ).run(actionId, userId);
  return result.changes > 0;
}

// ─── schedule ─────────────────────────────────────────────────────────────────
// Alias for scheduleAction with a simpler signature used by remind.js.
export function schedule(guildId, userId, action, data, executeAt) {
  return scheduleAction(guildId, action, userId, data, executeAt, userId);
}
