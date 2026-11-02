// ============================================================
//  handlers/serverReset.js
//
//  Puts one area of a server's Bloo settings back to how it was when Bloo
//  first joined, or all of them. Settings stay when Bloo is removed (so
//  re-adding it doesn't lose a server's setup); this is how a server starts
//  over on purpose. Shared by b!reset and the dashboard's Reset Settings page.
//
//  Only settings are cleared. Members' records (XP, warnings, mod cases,
//  tickets, appeals) are kept; those have their own commands.
// ============================================================

import db from '../db.js';
import logger from '../utils/logger.js';

export class ResetError extends Error {}

// key → what it covers. ownerOnly areas need the Server Owner.
export const RESET_AREAS = {
  general:     { label: 'Bloo Core', what: 'prefix, mod log channel, command cooldown, command message and spam settings', tables: ['guild_settings'] },
  botchannels: { label: 'Bot command channels', what: 'the list of channels commands work in', tables: ['bot_channels'] },
  permissions: { label: 'Command permissions and aliases', what: 'changed command permissions, disabled commands and command aliases', tables: ['command_permissions', 'guild_command_aliases'] },
  customcmds:  { label: 'Custom commands', what: 'every custom command and tag', tables: ['custom_commands'] },
  logs:        { label: 'Logging', what: 'mod log and message log settings, styles and ignored channels', tables: ['modlog_config', 'message_log_config', 'message_log_ignored', 'activity_log_config'] },
  automod:     { label: 'Automod', what: 'automod rules and actions', tables: ['automod_config'] },
  wordfilter:  { label: 'Word filter', what: 'the blocked words and filter settings', tables: ['word_blacklist_config', 'word_blacklist'] },
  links:       { label: 'Links', what: 'link scanner, blocked links, link enforcement, domain tiers and link auditor', tables: ['link_scanner_config', 'link_blacklist', 'link_enforcement_config', 'link_domain_tiers', 'link_auditor_config'] },
  warnings:    { label: 'Warning settings', what: 'warning channels, decay and punishment thresholds (not the warnings themselves)', tables: ['warn_config', 'warn_thresholds'] },
  bans:        { label: 'Ban settings', what: 'ban limits, approval rules and per-member ban overrides (not the bans themselves)', tables: ['ban_config', 'ban_overrides'] },
  antiraid:    { label: 'Anti-raid and verification', what: 'raid mode, captcha and verification settings', tables: ['antiraid_config', 'antiraid_panel_queue'] },
  welcome:     { label: 'Welcome and goodbye', what: 'welcome and goodbye messages, cards, auto-role and an uploaded card image', tables: ['welcome_config'], after: 'welcome' },
  tickets:     { label: 'Tickets', what: 'ticket setup, ticket options and the ticket blacklist (not past tickets)', tables: ['ticket_config', 'ticket_options', 'ticket_blacklist'] },
  xp:          { label: 'XP settings', what: 'XP rates, level-up messages, levels, reward roles, multipliers and boosts (members keep their XP)', tables: ['xp_config', 'xp_levels', 'xp_role_rewards', 'xp_level_roles', 'xp_channel_rules', 'xp_role_rules', 'xp_boost_events'] },
  roles:       { label: 'Reaction roles and role menus', what: 'reaction roles and role menus (the posted messages stay, but stop working)', tables: ['reaction_roles', 'role_menu_entry_blocks', 'role_menu_entries', 'role_menus'] },
  rolepersist: { label: 'Role persist', what: 'role persist settings and rules', tables: ['role_persist_config', 'role_persist_rules'] },
  starboard:   { label: 'Starboard', what: 'starboard settings and category overrides', tables: ['starboard_config', 'starboard_category_overrides'] },
  feeds:       { label: 'Feeds', what: 'every RSS/YouTube feed and the paused-feed alert', tables: ['webhook_alert_config'], after: 'feeds' },
  notices:     { label: 'Bloo service notices', what: 'the channel Bloo\'s announcements and maintenance notices go to, and its webhook', tables: ['notification_webhooks'], before: 'notices' },
  appeals:     { label: 'Ban appeal settings', what: 'the appeal channel and cooldown (not the appeals)', tables: ['appeal_config'] },
  confessions: { label: 'Confession settings', what: 'confession channels, approval and the block list (not the confessions)', tables: ['confession_config', 'confession_blacklist'] },
  watchlist:   { label: 'Watchlist channel', what: 'where watchlist alerts go (not who is watched)', tables: ['watchlist_config'] },
  analytics:   { label: 'Analytics and digest', what: 'analytics opt-in, retention and the daily digest', tables: ['analytics_config', 'digest_config'] },
  embeds:      { label: 'Embed messages', what: 'saved embed messages (posted ones stay up, but can\'t be edited any more)', tables: ['embed_messages'] },
  scheduled:   { label: 'Scheduled actions', what: 'everything waiting to be posted, locked or unlocked', tables: ['scheduled_actions'] },
  dashaccess:  { label: 'Dashboard access', what: 'who has dashboard access, by member and by role, and page permissions', tables: ['dash_user_access', 'dash_role_access', 'dash_page_perms', 'dash_tier_page_perms'], ownerOnly: true },
};

const hasGuildColumn = table => {
  try { return db.prepare(`PRAGMA table_info("${table}")`).all().some(c => c.name === 'guild_id'); } catch { return false; }
};

// Rows that would be cleared, per area, so people can see before confirming.
export function previewReset(guildId, area) {
  const keys = area === 'all' ? Object.keys(RESET_AREAS) : [area];
  let rows = 0;
  for (const k of keys) {
    const a = RESET_AREAS[k];
    if (!a) throw new ResetError(`Unknown area "${area}".`);
    for (const t of a.tables) if (hasGuildColumn(t)) rows += db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE guild_id = ?`).get(guildId).n;
    if (a.after === 'feeds' && hasGuildColumn('webhook_feeds')) rows += db.prepare('SELECT COUNT(*) n FROM webhook_feeds WHERE guild_id = ?').get(guildId).n;
  }
  return rows;
}

// Clears one area, or 'all' (Server Owner only, checked by the caller via
// isOwner). Returns { areas, rows }.
export async function resetArea(guildId, area, { isOwner = false } = {}) {
  const keys = area === 'all' ? Object.keys(RESET_AREAS) : [area];
  if (area === 'all' && !isOwner) throw new ResetError('Only the Server Owner can reset everything.');
  for (const k of keys) {
    if (!RESET_AREAS[k]) throw new ResetError(`Unknown area "${area}".`);
    if (RESET_AREAS[k].ownerOnly && !isOwner) throw new ResetError(`Only the Server Owner can reset ${RESET_AREAS[k].label.toLowerCase()}.`);
  }

  let rows = 0;
  const after = new Set();
  // The notices webhook is deleted in Fluxer too, like b!notifications off,
  // so it doesn't linger in the channel's integrations.
  const noticeHooks = keys.some(k => RESET_AREAS[k].before === 'notices') && hasGuildColumn('notification_webhooks')
    ? db.prepare('SELECT webhook_url FROM notification_webhooks WHERE guild_id = ?').all(guildId).map(r => r.webhook_url)
    : [];
  db.transaction(() => {
    for (const k of keys) {
      for (const t of RESET_AREAS[k].tables) {
        if (!hasGuildColumn(t)) continue; // not created on this install
        rows += db.prepare(`DELETE FROM "${t}" WHERE guild_id = ?`).run(guildId).changes;
      }
      if (RESET_AREAS[k].after) after.add(RESET_AREAS[k].after);
    }
  })();

  // Tidy-up that isn't a plain delete.
  for (const url of noticeHooks) {
    await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
  if (after.has('feeds')) {
    try { const { pruneGuildFeeds } = await import('./webhookPoller.js'); rows += pruneGuildFeeds(guildId) ?? 0; }
    catch (err) { logger.warn(`[RESET] Feed cleanup failed for ${guildId}: ${err.message}`); }
  }
  if (after.has('welcome')) {
    try { const w = await import('./welcomeBackgrounds.js'); w.removeWelcomeUpload(guildId); w.removeServerCache(guildId); }
    catch (err) { logger.warn(`[RESET] Welcome image cleanup failed for ${guildId}: ${err.message}`); }
  }
  // Settings cached in memory (prefix and the like) are re-read.
  try { (await import('./guildSettings.js')).invalidateGuild(guildId); } catch { /* not loaded */ }

  logger.info(`[RESET] ${guildId}: ${area} reset, ${rows} row(s) cleared.`);
  return { areas: keys, rows };
}
