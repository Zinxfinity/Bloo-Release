// ─── Anti-raid, public API ─────────────────────────────────────────────────────
// Re-exports the split modules in this folder. handleJoin is the orchestrator
// called from events/guild/memberJoin.js: it decides web-verify vs DM-captcha
// based on guild config and delegates to the matching module.

import './schema.js'; // runs table creation + migrations on first import
import { getAntiRaidConfig } from './config.js';
import { sendWebVerify } from './webVerify.js';
import { sendDmCaptcha } from './captcha.js';
import { stmts } from './schema.js';
import { logAction } from '../modLog.js';
import logger from '../../utils/logger.js';
import db from '../../db.js';
import { giveHeldAutorole } from '../autoroleGate.js';

export { getAntiRaidConfig, setAntiRaidField } from './config.js';
export { createVerifyToken, consumeVerifyToken } from './webVerify.js';
export { handleDmResponse } from './captcha.js';
export {
  postVerifyPanel, restoreVerifyPanels,
  registerVerifyMessage, unregisterVerifyMessage, getVerifyMessageGuildId,
  isVerifyMessagePersistent, startPanelRepostPoller,
} from './panel.js';

// Shared by handleJoin (below) and reactionAdd.js's react-to-verify branch,
// so both paths apply the exact same "already verified" skip and
// web-vs-dm dispatch instead of duplicating the logic.
export async function sendVerification(client, guildId, userId, member, config) {
  // captcha_enabled, not enabled, is the real "is verification on" switch
  // everywhere else in this subsystem: panel.js and !verify both gate on
  // it. enabled is a second, separately-toggled column the dashboard's
  // "Raid Mode" card writes, unrelated in the UI's own copy to whether
  // captcha DMs go out, so gating sends on it left every guild configured
  // purely through the (correctly labeled) Captcha Verification card
  // completely inert with no error anywhere.
  // Each skip says why when DEBUG=true, so "the captcha never came" can be
  // traced from the log instead of guessed at.
  if (!config?.captcha_enabled) { logger.debug(`[ANTIRAID] No captcha for ${userId} in ${guildId}: verification is off`); return false; }
  if (!config.verified_role_id) { logger.debug(`[ANTIRAID] No captcha for ${userId} in ${guildId}: no verified role set`); return false; }

  // Skip if already verified (rejoin with role persist, or re-reacting on
  // the standing panel), avoids spamming a fresh token/DM captcha session
  // on every click.
  const hasRole = member?.roles?.has?.(config.verified_role_id)
               ?? member?.roles?.includes?.(config.verified_role_id)
               ?? false;
  if (hasRole) { logger.debug(`[ANTIRAID] No captcha for ${userId} in ${guildId}: already has the verified role`); return false; }
  logger.debug(`[ANTIRAID] Sending ${config.verify_mode ?? 'web'} verification to ${userId} in ${guildId}`);

  // verify_mode, not the older `mode` column, is what !antiraid mode
  // actually writes and what the config panel / !verify command already
  // display as the current setting (config.js, verify.js). `mode` is
  // permanently stuck at its 'dm' default since nothing ever writes it,
  // this was silently ignoring every guild's configured web-verify choice.
  if ((config.verify_mode ?? 'web') === 'web') {
    await sendWebVerify(client, member, guildId, userId, config);
  } else {
    await sendDmCaptcha(client, member, guildId, userId, config);
  }
  return true;
}

const DISCORD_EPOCH_MS = 1420070400000;
const accountAgeDays = (userId) => (Date.now() - (Number(BigInt(userId) >> 22n) + DISCORD_EPOCH_MS)) / 86400000;

// Raid Mode: accounts younger than min_account_age days get the configured
// action (kick/ban) on join. Returns true when the member was removed, so
// verification isn't sent to someone who's no longer in the server.
async function enforceAccountAge(client, guildId, userId, member, config) {
  if (!config?.enabled) return false;
  if (member.user?.bot) return false;
  const minDays = Number(config.min_account_age ?? 7);
  if (!(minDays > 0)) return false;
  const ageDays = accountAgeDays(userId);
  if (ageDays >= minDays) return false;

  const action = config.action === 'ban' ? 'ban' : 'kick';
  const reason = `Anti-raid: account is ${ageDays.toFixed(1)} day(s) old, minimum is ${minDays}`;

  // DM first, while we still share a server with them.
  try {
    const dm = await client.rest.post('/users/@me/channels', { body: { recipient_id: userId } });
    if (dm?.id) {
      await client.rest.post(`/channels/${dm.id}/messages`, {
        body: { content: `This server only accepts accounts at least ${minDays} day(s) old, so you were ${action === 'ban' ? 'banned' : 'removed'} automatically. You're welcome back once your account is old enough.` },
      });
    }
  } catch { /* DMs closed */ }

  try {
    if (action === 'ban') {
      await client.rest.put(`/guilds/${guildId}/bans/${userId}?reason=${encodeURIComponent(reason)}`, { body: { delete_message_seconds: 0 } });
    } else {
      await client.rest.delete(`/guilds/${guildId}/members/${userId}?reason=${encodeURIComponent(reason)}`);
    }
  } catch (err) {
    logger.warn(`[ANTIRAID] ${action} failed for ${userId} in ${guildId}:`, err.message);
    return false;
  }

  await logAction({
    client, guildId, action: action === 'ban' ? 'ban' : 'kick', targetId: userId,
    targetTag: member.user?.username, executorId: client.user?.id ?? 'system', reason,
  }).catch(() => {});

  if (config.log_channel_id) {
    await client.rest.post(`/channels/${config.log_channel_id}/messages`, {
      body: {
        content: `🛡️ Raid Mode ${action === 'ban' ? 'banned' : 'kicked'} <@${userId}> (${member.user?.username ?? userId}), account ${ageDays.toFixed(1)} day(s) old.`,
        allowed_mentions: { parse: [] },
      },
    }).catch(() => {});
  }
  return true;
}

// Called from memberJoin.js for every new member. Returns true when Raid Mode
// removed them, so the caller can skip welcome/autorole/role-persist.
export async function handleJoin(client, member) {
  const guildId = member.guild?.id ?? member.guildId;
  const userId  = member.user?.id  ?? member.id;
  if (!guildId || !userId) return false;

  const config = getAntiRaidConfig(guildId);
  if (await enforceAccountAge(client, guildId, userId, member, config)) return true;
  await sendVerification(client, guildId, userId, member, config);
  return false;
}

export async function manualVerify(client, guildId, userId) {
  const config = getAntiRaidConfig(guildId);
  if (!config?.verified_role_id) return false;

  try {
    await client.rest.put(
      `/guilds/${guildId}/members/${userId}/roles/${config.verified_role_id}`
    );
    stmts.deleteSession.run(userId, guildId);
    await giveHeldAutorole(client, db, guildId, userId);
    return true;
  } catch {
    return false;
  }
}
