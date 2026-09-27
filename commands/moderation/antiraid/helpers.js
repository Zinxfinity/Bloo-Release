// ─── Shared helpers for the antiraid command family ────────────────────────────

import db from '../../../db.js';

export function upsert(guildId, fields) {
  // Ensure the row exists with defaults first (DO NOTHING keeps existing values intact)
  db.prepare(`
    INSERT INTO antiraid_config (guild_id, enabled, captcha_enabled, min_account_age, action)
    VALUES (?, 0, 0, 7, 'kick')
    ON CONFLICT(guild_id) DO NOTHING
  `).run(guildId);

  // Whitelist of columns this function is allowed to touch. Any key not in
  // here is silently dropped to prevent SQL injection if `fields` is ever
  // built from user input in a future refactor.
  const VALID = new Set([
    'enabled', 'captcha_enabled', 'min_account_age', 'action',
    'role_id', 'verify_channel_id', 'log_channel_id',
    'captcha_mode', 'verified_role_id', 'verify_panel_msg_id', 'verify_mode',
  ]);

  const safe = Object.entries(fields).filter(([k]) => VALID.has(k));
  if (safe.length === 0) return;
  const setClauses = safe.map(([k]) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE antiraid_config SET ${setClauses} WHERE guild_id = ?`)
    .run(...safe.map(([, v]) => v), guildId);
}

export function parseRoleId(arg) {
  if (!arg) return null;
  return arg.match(/^<@&(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

export function parseChannelId(arg) {
  if (!arg) return null;
  return arg.match(/^<#(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

export function getConfig(guildId) {
  return db.prepare('SELECT * FROM antiraid_config WHERE guild_id = ?').get(guildId) ?? {};
}
