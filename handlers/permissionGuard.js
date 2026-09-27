// ============================================================
//  handlers/permissionGuard.js
//
//  Tracks consecutive permission failures for background channel
//  outputs (modlog, msglog) and auto-disables the target after
//  FAILURE_THRESHOLD consecutive failures to prevent log spam.
//  Separate from webhookPoller.js's own DB-persisted fail_count/
//  trackFailure mechanism, that one already covers webhook feeds
//  (any failure, threshold 20, deletes the feed) and isn't touched here.
//
//  Usage:
//    import { handle, clear } from './permissionGuard.js';
//
//    try {
//      await ch.send(...);
//      clear('MODLOG', guildId);
//    } catch (err) {
//      if (handle('MODLOG', guildId, channelId, err, () => {
//        setModlogChannel(guildId, null); // disable callback
//      })) return; // guard consumed the error (permission-related)
//    }
//
//  Key format: `${source}:${scopeId}`
//    source , 'MODLOG' | 'MSGLOG' etc.
//    scopeId, guildId, uniquely identifies this target
//
//  A successful send clears the failure counter for that key.
// ============================================================

import logger        from '../utils/logger.js';
import db             from '../db.js';
import { reportError } from './errorReporter.js';

const FAILURE_THRESHOLD = 3;

// Map<key, { count, channelId }>
const failures = new Map();

// Detect whether an error is a permission/access denial, covers Fluxer API
// responses and network-level errors.
export function isPermissionError(err) {
  const msg  = String(err?.message ?? '');
  const code = err?.code ?? err?.status ?? err?.statusCode;

  return (
    code === 403 ||
    code === 50013 || // Missing Permissions (Discord-compat)
    code === 50001 || // Missing Access
    /missing.?(permissions?|access)/i.test(msg) ||
    /don't have the permissions/i.test(msg) ||
    /not.*permitted/i.test(msg) ||
    /forbidden/i.test(msg)
  );
}

/**
 * Call on every failed send attempt.
 *
 * @param {string}   source    , log prefix, e.g. 'MODLOG', 'MSGLOG'
 * @param {string}   scopeId   , guildId, uniquely identifies this target
 * @param {string}   channelId , for logging the channel that failed
 * @param {Error}    err       , the caught error
 * @param {Function} onDisable , called when threshold is reached; should disable the target in DB
 *
 * @returns {boolean} true if this was a permission error (caller should bail out)
 */
export function handle(source, scopeId, channelId, err, onDisable) {
  if (!isPermissionError(err)) return false;

  const key     = `${source}:${scopeId}`;
  const current = failures.get(key) ?? { count: 0, channelId };
  current.count++;
  failures.set(key, current);

  if (current.count < FAILURE_THRESHOLD) {
    logger.warn(
      `[${source}] Permission error on channel ${channelId} ` +
      `(${current.count}/${FAILURE_THRESHOLD} strikes), ${err.message}`
    );
    return true;
  }

  // Threshold reached, disable and clean up
  failures.delete(key);
  logger.warn(
    `[${source}] Auto-disabled: ${FAILURE_THRESHOLD} consecutive permission errors ` +
    `on channel ${channelId} (scope: ${scopeId}). ` +
    `Re-configure with the appropriate command to re-enable.`
  );

  try {
    onDisable();
  } catch (disableErr) {
    logger.error(`[${source}] Failed to disable target in DB:`, disableErr.message);
  }

  return true;
}

// Call on every successful send to reset the failure counter.
export function clear(source, scopeId) {
  failures.delete(`${source}:${scopeId}`);
}

// ─── Owner permission notification ───────────────────────────────────────────
// DMs the server owner when a bot action was blocked by missing permissions.
// Deduplicated per (guildId + action) so the owner isn't spammed, one DM per
// unique blocked action per 30-minute window.
//
// Usage:
//   catch (err) {
//     if (isPermissionError(err)) {
//       await notifyOwnerPermError(client, guildId, 'ban', `Could not ban <@${userId}>: ${err.message}`);
//     }
//   }

const _notifiedKeys = new Set(); // dedupe: "guildId:action"

export async function notifyOwnerPermError(client, guildId, action, detail = '') {
  const dedupeKey = `${guildId}:${action}`;
  if (_notifiedKeys.has(dedupeKey)) return;
  _notifiedKeys.add(dedupeKey);

  // Auto-expire dedupe after 30 minutes so persistent issues get re-reported
  const timer = setTimeout(() => _notifiedKeys.delete(dedupeKey), 30 * 60_000);
  timer.unref?.();

  try {
    const ownerId = db.prepare('SELECT user_id FROM staff_guild_owners WHERE guild_id = ?').get(guildId)?.user_id;

    const guild = client.guilds?.cache?.get(guildId)
      ?? await client.guilds.fetch(guildId).catch(() => null);
    const gName = guild?.name ?? `Guild ${guildId}`;

    reportError('Moderation', {
      title: `Permission Error, ${action}`,
      guildId,
      extra: `**Guild:** ${gName}\n${detail || ''}`.trim(),
    });

    if (ownerId) {
      const user = await client.users.fetch(ownerId).catch(() => null);
      const dm   = user ? await user.createDM().catch(() => null) : null;
      if (dm) {
        await dm.send(
          `> Bloo was blocked by a permission error in **${gName}**\n` +
          `> **Action:** ${action}\n` +
          (detail ? `> **Detail:** ${detail}\n` : '') +
          `> -# Please check Bloo's role permissions and channel overrides.`
        );
      }
    }
  } catch {
    // Best-effort, never throw from a notification helper
  }
}
