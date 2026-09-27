import db from '../db.js';
import logger from '../utils/logger.js';
import * as resilience from './resilience.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    channel_id TEXT,
    message    TEXT    NOT NULL,
    due_at     INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    sent       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (sent, due_at);
`);

const stmts = {
  add:     db.prepare(`
    INSERT INTO reminders (guild_id, user_id, channel_id, message, due_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  getDue:  db.prepare(`SELECT * FROM reminders WHERE sent = 0 AND due_at <= unixepoch() LIMIT 50`),
  markSent: db.prepare(`UPDATE reminders SET sent = 1 WHERE id = ?`),
  list:    db.prepare(`SELECT * FROM reminders WHERE guild_id = ? AND user_id = ? AND sent = 0 ORDER BY due_at ASC`),
  delete:  db.prepare(`DELETE FROM reminders WHERE id = ? AND user_id = ?`),
};

export function addReminder(guildId, userId, channelId, message, dueAt) {
  return stmts.add.run(guildId, userId, channelId, message, dueAt).lastInsertRowid;
}

export function listReminders(guildId, userId) {
  return stmts.list.all(guildId, userId);
}

export function deleteReminder(reminderId, userId) {
  stmts.delete.run(reminderId, userId);
}

// ─── startReminderPoller ──────────────────────────────────────────────────────
let _reminderTimer = null;

export function startReminderPoller(client) {
  if (_reminderTimer) return;

  const tick = async () => {
    const due = stmts.getDue.all();
    for (const reminder of due) {
      stmts.markSent.run(reminder.id);
      try {
        // Try channel first, fall back to DM. Raw REST, not
        // client.channels.fetch() + channel.send(): confirmed in
        // production that pattern fails with "channel.send is not a
        // function" for at least one channel type on v2.0.1's SDK.
        let sent = false;
        if (reminder.channel_id) {
          try {
            // Anyone can set a reminder, so only the reminder's owner gets
            // pinged; @everyone/roles/other users in the text stay inert.
            await client.rest.post(`/channels/${reminder.channel_id}/messages`, {
              body: {
                content: `⏰ <@${reminder.user_id}>, ${reminder.message}`,
                allowed_mentions: { parse: [], users: [reminder.user_id] },
              },
            });
            sent = true;
          } catch { /* fall through to DM below */ }
        }
        if (!sent) {
          const user = await client.users.fetch(reminder.user_id).catch(() => null);
          const dm   = await user?.createDM?.().catch(() => null);
          if (dm) await dm.send({ content: `⏰ Reminder: ${reminder.message}` });
        }
      } catch (err) {
        logger.warn(`[REMINDER] Failed to deliver reminder ${reminder.id}:`, err.message);
      }
    }
  };

  resilience.runLight('reminderPoller.tick', tick);
  _reminderTimer = setInterval(() => resilience.runLight('reminderPoller.tick', tick), 5_000);
  _reminderTimer.unref?.();
  logger.info('[REMINDER] Poller started (5s interval).');
}
