// ============================================================
//  handlers/banSystem.js
//
//  Full ban system: config per guild, optional two-step approval,
//  rolling ban counters, ban lockouts, and per-staff overrides.
// ============================================================

import db     from '../db.js';
import logger from '../utils/logger.js';
import { clearPendingTempbans, addTempban } from './warnSystem.js';
import { getMemberPermissionBitsLive } from './staffSystem.js';
import { siteUrl } from '../config/site.js';

// An older release had ban_approvals with a TEXT id, `requester_id`
// instead of `executor_id`, a numeric `rank` instead of target/executor
// display tags, and a single `resolved_by` instead of separate
// approved_by/denied_by. CREATE TABLE IF NOT EXISTS won't touch an
// already-existing table, so without this an old database keeps that
// shape forever and every approval request crashes on "no such column".
// Detected via the old-only `requester_id` column.
{
  let cols = [];
  try { cols = db.prepare(`PRAGMA table_info(ban_approvals)`).all(); } catch { /* no table yet */ }
  if (cols.length && cols.some(c => c.name === 'requester_id')) {
    const rows = db.prepare('SELECT * FROM ban_approvals').all();
    db.exec(`
      CREATE TABLE ban_approvals_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id      TEXT    NOT NULL,
        target_id     TEXT    NOT NULL,
        target_tag    TEXT    NOT NULL,
        executor_id   TEXT    NOT NULL,
        executor_tag  TEXT    NOT NULL,
        reason        TEXT    NOT NULL DEFAULT 'No reason provided',
        status        TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','denied','expired','cancelled')),
        approved_by   TEXT,
        denied_by     TEXT,
        message_id    TEXT,
        channel_id    TEXT,
        delete_days   INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        resolved_at   INTEGER
      );
    `);
    const insert = db.prepare(`
      INSERT INTO ban_approvals_new
        (guild_id, target_id, target_tag, executor_id, executor_tag, reason, status, approved_by, denied_by, message_id, channel_id, delete_days, created_at, resolved_at)
      VALUES
        (@guild_id, @target_id, @target_tag, @executor_id, @executor_tag, @reason, @status, @approved_by, @denied_by, @message_id, @channel_id, @delete_days, @created_at, @resolved_at)
    `);
    for (const r of rows) {
      insert.run({
        guild_id: r.guild_id, target_id: r.target_id,
        target_tag: r.target_id, // no historical tag was stored under the old shape
        executor_id: r.requester_id,
        executor_tag: r.requester_id,
        reason: r.reason ?? 'No reason provided',
        status: r.status ?? 'pending',
        approved_by: r.status === 'approved' ? r.resolved_by : null,
        denied_by:   r.status === 'denied'   ? r.resolved_by : null,
        message_id: r.message_id, channel_id: r.channel_id,
        delete_days: 0, created_at: r.created_at, resolved_at: r.resolved_at,
      });
    }
    db.exec('DROP TABLE ban_approvals');
    db.exec('ALTER TABLE ban_approvals_new RENAME TO ban_approvals');
  }
}

// Older releases had ban_lockouts without `expires_at` (had `locked_by`
// instead) and ban_overrides with `granted_by`/`granted_at` instead of
// `set_by`/`set_at`. CREATE TABLE IF NOT EXISTS won't fix an
// already-existing table, so rebuild on detection of the old-only columns.
{
  let cols = [];
  try { cols = db.prepare(`PRAGMA table_info(ban_lockouts)`).all(); } catch { /* no table yet */ }
  if (cols.length && cols.some(c => c.name === 'locked_by') && !cols.some(c => c.name === 'expires_at')) {
    const rows = db.prepare('SELECT * FROM ban_lockouts').all();
    db.exec(`
      CREATE TABLE ban_lockouts_new (
        guild_id   TEXT    NOT NULL,
        user_id    TEXT    NOT NULL,
        locked_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER NOT NULL,
        reason     TEXT    NOT NULL DEFAULT 'Ban limit exceeded',
        PRIMARY KEY (guild_id, user_id)
      );
    `);
    const insert = db.prepare(`INSERT OR IGNORE INTO ban_lockouts_new (guild_id, user_id, locked_at, expires_at, reason) VALUES (?, ?, ?, ?, ?)`);
    for (const r of rows) {
      // old shape had no expiry, default to 24h from migration time so an
      // old lockout doesn't stay in effect forever.
      insert.run(r.guild_id, r.user_id, r.locked_at, Math.floor(Date.now() / 1000) + 86400, r.reason ?? 'Ban limit exceeded');
    }
    db.exec('DROP TABLE ban_lockouts');
    db.exec('ALTER TABLE ban_lockouts_new RENAME TO ban_lockouts');
  }
}
{
  let cols = [];
  try { cols = db.prepare(`PRAGMA table_info(ban_overrides)`).all(); } catch { /* no table yet */ }
  if (cols.length && cols.some(c => c.name === 'granted_by') && !cols.some(c => c.name === 'set_by')) {
    const rows = db.prepare('SELECT * FROM ban_overrides').all();
    db.exec(`
      CREATE TABLE ban_overrides_new (
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        set_by   TEXT NOT NULL,
        set_at   INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (guild_id, user_id)
      );
    `);
    const insert = db.prepare(`INSERT OR IGNORE INTO ban_overrides_new (guild_id, user_id, set_by, set_at) VALUES (?, ?, ?, ?)`);
    for (const r of rows) insert.run(r.guild_id, r.user_id, r.granted_by, r.granted_at);
    db.exec('DROP TABLE ban_overrides');
    db.exec('ALTER TABLE ban_overrides_new RENAME TO ban_overrides');
  }
}

// An older release had ban_config.approval_min_rank (an INTEGER StaffRank
// number). Rank numbers are gone, approval floor is now a Fluxer permission
// bit. Detect the old-only column and rebuild with approval_min_permission
// instead, defaulting SR_MOD-equivalent rows to BAN_MEMBERS (the nearest real
// permission, confirmed by the user as the new default).
{
  let cols = [];
  try { cols = db.prepare(`PRAGMA table_info(ban_config)`).all(); } catch { /* no table yet */ }
  if (cols.length && cols.some(c => c.name === 'approval_min_rank') && !cols.some(c => c.name === 'approval_min_permission')) {
    const rows = db.prepare('SELECT * FROM ban_config').all();
    db.exec(`
      CREATE TABLE ban_config_new (
        guild_id                TEXT    PRIMARY KEY,
        approval_channel        TEXT,
        ban_limit               INTEGER NOT NULL DEFAULT 0,
        window_hours            INTEGER NOT NULL DEFAULT 24,
        lockout_duration_h      INTEGER NOT NULL DEFAULT 24,
        require_approval        INTEGER NOT NULL DEFAULT 0,
        approval_min_permission TEXT    NOT NULL DEFAULT '4',
        log_channel             TEXT,
        updated_at              INTEGER NOT NULL DEFAULT 0
      );
    `);
    const insert = db.prepare(`
      INSERT INTO ban_config_new (guild_id, approval_channel, ban_limit, window_hours, lockout_duration_h, require_approval, approval_min_permission, log_channel, updated_at)
      VALUES (@guild_id, @approval_channel, @ban_limit, @window_hours, @lockout_duration_h, @require_approval, '4', @log_channel, @updated_at)
    `);
    for (const r of rows) insert.run(r);
    db.exec('DROP TABLE ban_config');
    db.exec('ALTER TABLE ban_config_new RENAME TO ban_config');
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS ban_config (
    guild_id                TEXT    PRIMARY KEY,
    approval_channel        TEXT,
    ban_limit               INTEGER NOT NULL DEFAULT 0,
    window_hours            INTEGER NOT NULL DEFAULT 24,
    lockout_duration_h      INTEGER NOT NULL DEFAULT 24,
    require_approval        INTEGER NOT NULL DEFAULT 0,
    approval_min_permission TEXT    NOT NULL DEFAULT '4',
    log_channel             TEXT,
    updated_at              INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS ban_approvals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT    NOT NULL,
    target_id     TEXT    NOT NULL,
    target_tag    TEXT    NOT NULL,
    executor_id   TEXT    NOT NULL,
    executor_tag  TEXT    NOT NULL,
    reason        TEXT    NOT NULL DEFAULT 'No reason provided',
    status        TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','denied','expired','cancelled')),
    approved_by   TEXT,
    denied_by     TEXT,
    message_id    TEXT,
    channel_id    TEXT,
    delete_days   INTEGER NOT NULL DEFAULT 0,
    action_type   TEXT    NOT NULL DEFAULT 'ban',
    created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    resolved_at   INTEGER
  );
  CREATE TABLE IF NOT EXISTS ban_counters (
    guild_id     TEXT    NOT NULL,
    user_id      TEXT    NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS ban_lockouts (
    guild_id   TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    locked_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL,
    reason     TEXT    NOT NULL DEFAULT 'Ban limit exceeded',
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS ban_overrides (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    set_by   TEXT NOT NULL,
    set_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (guild_id, user_id)
  );
`);

for (const col of [
  `ALTER TABLE ban_config ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ban_config ADD COLUMN approval_min_permission TEXT NOT NULL DEFAULT '4'`,
  `ALTER TABLE ban_config ADD COLUMN lockout_duration_h INTEGER NOT NULL DEFAULT 24`,
  `ALTER TABLE ban_config ADD COLUMN log_channel TEXT`,
  // setBanConfigField writes updated_at; older tables never had it, so every
  // `b!ban config` change failed with "no such column: updated_at".
  `ALTER TABLE ban_config ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ban_approvals ADD COLUMN delete_days INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ban_approvals ADD COLUMN channel_id TEXT`,
  // Lets softBan/hardBan/massBan queue through the same approval system as
  // plain !ban instead of executing immediately regardless of
  // require_approval. Without a type, an approved request would always
  // replay as a full standard ban (executeBan), silently turning an
  // approved softban into a permanent one.
  `ALTER TABLE ban_approvals ADD COLUMN action_type TEXT NOT NULL DEFAULT 'ban'`,
  // Tempbans queue too; an approved one must still expire.
  `ALTER TABLE ban_approvals ADD COLUMN duration_s INTEGER`,
]) { try { db.exec(col); } catch { /* already exists */ } }

const CONFIG_FIELDS = new Set([
  'approval_channel','ban_limit','window_hours','lockout_duration_h',
  'require_approval','approval_min_permission','log_channel',
]);

const stmts = {
  getConfig:    db.prepare(`SELECT * FROM ban_config WHERE guild_id = ?`),
  ensureConfig: db.prepare(`INSERT OR IGNORE INTO ban_config (guild_id) VALUES (?)`),
  setField:     (f) => db.prepare(`UPDATE ban_config SET ${f} = ?, updated_at = unixepoch() WHERE guild_id = ?`),
  createApproval: db.prepare(`
    INSERT INTO ban_approvals (guild_id, target_id, target_tag, executor_id, executor_tag, reason, delete_days, action_type, duration_s)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getApproval:    db.prepare(`SELECT * FROM ban_approvals WHERE id = ?`),
  getByMessage:   db.prepare(`SELECT * FROM ban_approvals WHERE message_id = ? AND guild_id = ?`),
  setApprovalMsg: db.prepare(`UPDATE ban_approvals SET message_id = ?, channel_id = ? WHERE id = ?`),
  resolveApproval: db.prepare(`UPDATE ban_approvals SET status=?,approved_by=?,denied_by=?,resolved_at=? WHERE id=?`),
  listApprovals:  db.prepare(`SELECT * FROM ban_approvals WHERE guild_id = ? ORDER BY created_at DESC LIMIT 50`),
  listPending:    db.prepare(`SELECT * FROM ban_approvals WHERE guild_id = ? AND status = 'pending' ORDER BY created_at ASC`),
  getCounter:     db.prepare(`SELECT * FROM ban_counters WHERE guild_id = ? AND user_id = ?`),
  upsertCounter:  db.prepare(`
    INSERT INTO ban_counters (guild_id, user_id, count, window_start)
    VALUES (?, ?, 1, unixepoch())
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      count        = CASE WHEN (unixepoch() - window_start) > (? * 3600) THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN (unixepoch() - window_start) > (? * 3600) THEN unixepoch() ELSE window_start END`),
  resetCounter:  db.prepare(`DELETE FROM ban_counters WHERE guild_id = ? AND user_id = ?`),
  getLockout:    db.prepare(`SELECT * FROM ban_lockouts WHERE guild_id = ? AND user_id = ?`),
  setLockout:    db.prepare(`INSERT OR REPLACE INTO ban_lockouts (guild_id,user_id,locked_at,expires_at,reason) VALUES (?,?,unixepoch(),?,?)`),
  clearLockout:  db.prepare(`DELETE FROM ban_lockouts WHERE guild_id = ? AND user_id = ?`),
  listLockouts:  db.prepare(`SELECT * FROM ban_lockouts WHERE guild_id = ? ORDER BY locked_at DESC`),
  expireLockouts: db.prepare(`DELETE FROM ban_lockouts WHERE expires_at < unixepoch()`),
  hasOverride:   db.prepare(`SELECT 1 FROM ban_overrides WHERE guild_id = ? AND user_id = ?`),
  setOverride:   db.prepare(`INSERT OR IGNORE INTO ban_overrides (guild_id, user_id, set_by) VALUES (?, ?, ?)`),
  clearOverride: db.prepare(`DELETE FROM ban_overrides WHERE guild_id = ? AND user_id = ?`),
  listOverrides: db.prepare(`SELECT * FROM ban_overrides WHERE guild_id = ?`),
};

export function getBanConfig(guildId) {
  stmts.ensureConfig.run(guildId);
  return stmts.getConfig.get(guildId);
}
export function setBanConfigField(guildId, field, value) {
  if (!CONFIG_FIELDS.has(field)) throw new Error(`Unknown ban_config field: ${field}`);
  stmts.ensureConfig.run(guildId);
  stmts.setField(field).run(value, guildId);
}

export function isLockedOut(guildId, userId) {
  stmts.expireLockouts.run();
  return !!stmts.getLockout.get(guildId, userId);
}
export function getLockout(guildId, userId) {
  stmts.expireLockouts.run();
  return stmts.getLockout.get(guildId, userId) ?? null;
}
export function clearLockout(guildId, userId) { stmts.clearLockout.run(guildId, userId); }
export function listLockouts(guildId) {
  stmts.expireLockouts.run();
  return stmts.listLockouts.all(guildId);
}

export function hasBanOverride(guildId, userId) { return !!stmts.hasOverride.get(guildId, userId); }
export function setBanOverride(guildId, userId, setBy) { stmts.setOverride.run(guildId, userId, setBy); }
export function clearBanOverride(guildId, userId) { stmts.clearOverride.run(guildId, userId); }
export function listBanOverrides(guildId) { return stmts.listOverrides.all(guildId); }

export function recordBan(guildId, userId) {
  const cfg         = getBanConfig(guildId);
  const windowHours = cfg.window_hours ?? 24;
  const limit       = cfg.ban_limit    ?? 0;
  stmts.upsertCounter.run(guildId, userId, windowHours, windowHours);
  const row   = stmts.getCounter.get(guildId, userId);
  const count = row?.count ?? 1;
  const hasOverr  = hasBanOverride(guildId, userId);
  const exceeded  = limit > 0 && count > limit && !hasOverr;
  if (exceeded) {
    const durationH = cfg.lockout_duration_h ?? 24;
    const expiresAt = Math.floor(Date.now() / 1000) + durationH * 3600;
    stmts.setLockout.run(guildId, userId, expiresAt, `Exceeded ban limit (${count}/${limit} in ${windowHours}h)`);
    logger.warn(`[BAN] Locked out ${userId} in ${guildId}: ${count}/${limit} bans`);
  }
  return { count, limit, exceeded };
}

export function createApprovalRequest({ guildId, targetId, targetTag, executorId, executorTag, reason = 'No reason provided', deleteDays = 0, actionType = 'ban', durationS = null }) {
  return stmts.createApproval.run(guildId, targetId, targetTag, executorId, executorTag, reason, deleteDays, actionType, durationS).lastInsertRowid;
}
export function setApprovalMessage(approvalId, messageId, channelId) { stmts.setApprovalMsg.run(messageId, channelId, approvalId); }
export function getApproval(approvalId) { return stmts.getApproval.get(approvalId) ?? null; }
export function getApprovalByMessage(guildId, messageId) { return stmts.getByMessage.get(messageId, guildId) ?? null; }
export function listApprovals(guildId) { return stmts.listApprovals.all(guildId); }
export function listPendingApprovals(guildId) { return stmts.listPending.all(guildId); }
export function resolveApproval(approvalId, status, resolvedBy) {
  const approvedBy = status === 'approved' ? resolvedBy : null;
  const deniedBy   = status === 'denied'   ? resolvedBy : null;
  stmts.resolveApproval.run(status, approvedBy, deniedBy, Date.now(), approvalId);
}

// ─── Shared execution (bot + dashboard) ───────────────────────────────────────
// `rest` is anything with put/delete/post taking (path, { body }): client.rest
// in the bot, a fetch-based shim in the dashboard. Every approval path (the
// !ban approve command, the ✅ reaction, the dashboard button) runs the action
// that was actually queued through here; before, the reaction and dashboard
// paths always did a plain permanent ban, so an approved softban became a
// permanent ban.
//
// Returns { action, countsTowardLimit }: action is the modlog label, and only
// a plain ban feeds the rolling ban-limit counter (matches !ban's behaviour).
// Tells the member why they were banned and, when this server takes
// appeals, how to appeal. Sent BEFORE the ban: once banned they may no
// longer share a server with the bot, and the DM would fail. Best effort
// with a short timeout so a slow DM never holds up the ban itself.
async function sendBanNotice(rest, guildId, targetId, reason, durationS = null) {
  const work = (async () => {
    const { getAppealConfig } = await import('./appealSystem.js');
    const appeals = getAppealConfig(guildId);
    const guild = await rest.get(`/guilds/${guildId}`).catch(() => null);
    const name = guild?.name ?? 'a server';
    // Approved bans carry "Approved (req by <staff>): " in the audit reason;
    // the member shouldn't learn which staff member asked for it.
    const shown = String(reason || '').replace(/^Approved (?:\(req by [^)]*\)|by <@\d+>):\s*/i, '').trim() || 'No reason given';
    const lines = [durationS ? `You were banned from **${name}** until <t:${Math.floor(Date.now() / 1000) + durationS}:f>.` : `You were banned from **${name}**.`, `**Reason:** ${shown.slice(0, 900)}`];
    if (appeals.enabled) {
      lines.push('', '**Think this was a mistake? You can appeal.**',
        `Reply here with: \`appeal ${guildId} <why you should be unbanned>\``,
        `Or open ${siteUrl()}/dashboard and go to **Account → My Appeals**.`,
        `-# You can appeal once every ${appeals.cooldown_days} day${appeals.cooldown_days === 1 ? '' : 's'}.`);
    }
    const dm = await rest.post('/users/@me/channels', { body: { recipient_id: targetId } });
    if (dm?.id) await rest.post(`/channels/${dm.id}/messages`, { body: { embeds: [{ color: 0xED4245, title: '🔨  Banned', description: lines.join('\n') }] } });
  })().catch(() => {});
  await Promise.race([work, new Promise(r => setTimeout(r, 4000))]);
}

// actionType 'temp' needs durationS: it bans, then schedules the unban.
export async function performBanAction(rest, guildId, targetId, reason, actionType = 'ban', deleteDays = null, durationS = null) {
  if (actionType === 'temp' && !(durationS > 0)) throw new Error('A temp ban needs a duration.');
  const qs = reason ? `?reason=${encodeURIComponent(String(reason).slice(0, 512))}` : '';
  // Real bans only: a softban is a message purge (they can rejoin), and a
  // mass ban would mean hundreds of DMs at once.
  if (actionType !== 'soft' && actionType !== 'mass') await sendBanNotice(rest, guildId, targetId, reason, actionType === 'temp' ? durationS : null);
  if (actionType === 'soft') {
    await rest.put(`/guilds/${guildId}/bans/${targetId}${qs}`, { body: { delete_message_seconds: 604800 } });
    await rest.delete(`/guilds/${guildId}/bans/${targetId}`);
    return { action: 'Softban', countsTowardLimit: false };
  }
  const days = (actionType === 'hard' || actionType === 'mass') ? 0 : (deleteDays ?? 1);
  await rest.put(`/guilds/${guildId}/bans/${targetId}${qs}`, { body: { delete_message_seconds: days * 86400 } });
  clearPendingTempbans(guildId, targetId);
  if (actionType === 'temp') {
    addTempban(guildId, targetId, durationS, reason);
    return { action: 'tempban', countsTowardLimit: true };
  }
  return { action: 'Member Banned', countsTowardLimit: actionType === 'ban' };
}

// Posts the ✅/❌ approval embed to the guild's approval channel, if one is set.
export async function postApprovalRequest(rest, guildId, approvalId, { targetId, targetTag, executorTag, reason }) {
  const channelId = getBanConfig(guildId).approval_channel;
  if (!channelId) return;
  try {
    const msg = await rest.post(`/channels/${channelId}/messages`, { body: { embeds: [{
      color: 0xFEE75C,
      title: '\u{1F528}  Ban Approval Required',
      fields: [
        { name: '\u{1F3AF} Target',       value: `${targetTag} (\`${targetId}\`)`, inline: true },
        { name: '\u{1F46E} Requested by', value: executorTag,                      inline: true },
        { name: '\u{1F4CB} Reason',       value: reason,                           inline: false },
        { name: '⚡ Approval ID',     value: `#${approvalId}`,                 inline: true },
      ],
      footer: { text: `React ✅ to approve ❌ to deny  |  Or use !ban approve/deny ${approvalId}` },
      timestamp: new Date().toISOString(),
    }] } });
    if (msg?.id) {
      setApprovalMessage(approvalId, msg.id, channelId);
      for (const emoji of ['✅', '❌']) {
        await rest.put(`/channels/${channelId}/messages/${msg.id}/reactions/${encodeURIComponent(emoji)}/@me`).catch(() => {});
      }
    }
  } catch (err) {
    logger.warn(`[BAN] Could not post approval #${approvalId} in ${guildId}:`, err.message);
  }
}

// Bans and temp bans: anyone with Kick Members can ask. Holding Ban Members
// (or Administrator) is trusted and bans straight away, even with the
// server's approval mode on. Everyone else always goes to approval.
// Owners and members with a ban override also skip it. `rest` is a REST
// client (bot or dashboard shim).
export async function banNeedsApproval(rest, guildId, executorId, isOwnerOrBotOwner) {
  if (isOwnerOrBotOwner) return false;
  if (hasBanOverride(guildId, executorId)) return false;
  const bits = await getMemberPermissionBitsLive({ rest }, guildId, executorId);
  return (bits & (BAN_BIT | ADMIN_BIT)) === 0n;
}
const BAN_BIT = 1n << 2n, ADMIN_BIT = 1n << 3n;

// Ban Members (or Administrator) is trusted: server approval mode never
// holds these people up, for any ban type.
export async function hasBanPermission(rest, guildId, userId) {
  const bits = await getMemberPermissionBitsLive({ rest }, guildId, userId);
  return (bits & (BAN_BIT | ADMIN_BIT)) !== 0n;
}

// Where the person should look for their queued request.
export function approvalWhere(guildId) {
  const ch = getBanConfig(guildId).approval_channel;
  return ch ? `in <#${ch}>` : 'from someone with Ban Members (`b!ban pending` or the dashboard)';
}

export function needsApproval(guildId, executorId, isOwnerOrBotOwner) {
  if (isOwnerOrBotOwner) return false;
  const cfg = getBanConfig(guildId);
  if (!cfg.require_approval) return false;
  if (hasBanOverride(guildId, executorId)) return false;
  return true;
}
