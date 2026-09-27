// ─── Verify panel, in-channel react-to-verify prompt ──────────────────────────

import db from '../../db.js';
import logger from '../../utils/logger.js';
import * as resilience from '../resilience.js';
import { getAntiRaidConfig } from './config.js';
import { stmts } from './schema.js';

// Post the verify panel embed to the configured verify channel.
// Called from the antiraid command after config changes.
export async function postVerifyPanel(client, guildId) {
  const cfg = getAntiRaidConfig(guildId);
  if (!cfg?.captcha_enabled || !cfg?.verify_channel_id) return false;

  const embed = {
    title: '🔒  Verification Required',
    description:
      'To gain access to this server, you need to complete a quick verification.\n\n' +
      '**Click the link in your DMs** after reacting below, or type `!verify` in this channel.',
    color: 0x5865F2,
    footer: { text: 'Bloo Verification System' },
  };

  try {
    const msg = await client.rest.post(`/channels/${cfg.verify_channel_id}/messages`, {
      body: { embeds: [embed] },
    });
    if (msg?.id) {
      await client.rest.put(
        `/channels/${cfg.verify_channel_id}/messages/${msg.id}/reactions/${encodeURIComponent('✅')}/@me`
      ).catch(() => {});
      db.prepare('UPDATE antiraid_config SET verify_panel_msg_id = ? WHERE guild_id = ?')
        .run(msg.id, guildId);
      // persistent: true, this message stays reactable by every future
      // member, unlike !verify's single-use prompt below, so reactionAdd.js
      // must not unregister it after the first person reacts.
      registerVerifyMessage(guildId, cfg.verify_channel_id, msg.id, { persistent: true });
    }
    return true;
  } catch { return false; }
}

// The panel registry below is in memory, so after a restart reacting ✅ on a
// standing panel did nothing until someone re-ran `!antiraid channel`. The
// panel's channel and message ID are already saved in antiraid_config, so
// re-register every live one on ready.
export function restoreVerifyPanels() {
  let restored = 0;
  for (const row of stmts.listPanels.all()) {
    registerVerifyMessage(row.guild_id, row.verify_channel_id, row.verify_panel_msg_id, { persistent: true });
    restored++;
  }
  if (restored) logger.info(`[ANTIRAID] Restored ${restored} verify panel(s).`);
}

// Track in-channel verify prompt messages so the reaction handler can clean
// them up. `persistent` distinguishes the standing panel (postVerifyPanel,
// reactable by every future member) from !verify's single-use prompt
// (meant to fire once and be done with), so reactionAdd.js knows whether
// it's safe to unregister after firing.
const _verifyMessages = new Map(); // channelId:messageId → { guildId, persistent }

export function registerVerifyMessage(guildId, channelId, messageId, { persistent = false } = {}) {
  _verifyMessages.set(`${channelId}:${messageId}`, { guildId, persistent });
}

export function unregisterVerifyMessage(channelId, messageId) {
  _verifyMessages.delete(`${channelId}:${messageId}`);
}

export function getVerifyMessageGuildId(channelId, messageId) {
  return _verifyMessages.get(`${channelId}:${messageId}`)?.guildId ?? null;
}

export function isVerifyMessagePersistent(channelId, messageId) {
  return _verifyMessages.get(`${channelId}:${messageId}`)?.persistent ?? false;
}

// ─── antiraid_panel_queue consumer ────────────────────────────────────────────
// dashboard/routes/antiraid.js queues a row here whenever verify_channel_id
// changes, but nothing ever consumed it, so changing the verify channel from
// the dashboard never actually reposted the panel there. Table is created
// here too (not just in the dashboard route) since this poller can start
// before any dashboard write has ever happened.
let _panelQueueTimer = null;
export function startPanelRepostPoller(client) {
  if (_panelQueueTimer) return;

  db.exec(`CREATE TABLE IF NOT EXISTS antiraid_panel_queue (
    guild_id  TEXT PRIMARY KEY,
    queued_at INTEGER NOT NULL
  )`);

  const tick = async () => {
    let rows = [];
    try { rows = db.prepare('SELECT guild_id FROM antiraid_panel_queue').all(); } catch { return; }
    for (const { guild_id: guildId } of rows) {
      try {
        const posted = await postVerifyPanel(client, guildId);
        // Leave a failed row queued, retried next tick, e.g. the channel
        // was deleted or the bot lost access, transient errors self-heal.
        if (posted) db.prepare('DELETE FROM antiraid_panel_queue WHERE guild_id = ?').run(guildId);
      } catch { /* retry next tick */ }
    }
  };

  const INTERVAL_MS = 60_000;
  _panelQueueTimer = setInterval(() => resilience.runLight('antiraid.panelRepostPoller', tick), INTERVAL_MS);
  _panelQueueTimer.unref?.();
  tick(); // don't wait a full interval for a change made just before boot
  logger.info('[ANTIRAID] Panel repost queue poller started (60s).');
}
