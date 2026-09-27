// ============================================================
//  handlers/linkScanner.js
//
//  Manages the link scanner whitelist and channel exemptions.
//  The actual enforcement logic lives in linkEnforcement.js.
//  This handler provides the CRUD layer for the links command.
// ============================================================

import db from '../db.js';

// Ensure required columns exist (domain_whitelist / domain_blacklist as \n-joined strings)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS link_scanner_config (
      guild_id          TEXT PRIMARY KEY,
      enabled           INTEGER NOT NULL DEFAULT 0,
      domain_whitelist  TEXT    NOT NULL DEFAULT '',
      domain_blacklist  TEXT    NOT NULL DEFAULT '',
      channel_whitelist TEXT    NOT NULL DEFAULT ''
    )
  `);
  db.exec(`ALTER TABLE link_scanner_config ADD COLUMN domain_blacklist TEXT NOT NULL DEFAULT ''`);
} catch { /* already exists */ }

function ensureRow(guildId) {
  db.prepare(`INSERT OR IGNORE INTO link_scanner_config (guild_id) VALUES (?)`).run(guildId);
}

// ─── getConfig ────────────────────────────────────────────────────────────────
export function getConfig(guildId) {
  ensureRow(guildId);
  return db.prepare('SELECT * FROM link_scanner_config WHERE guild_id = ?').get(guildId);
}

// ─── setEnabled ───────────────────────────────────────────────────────────────
export function setEnabled(guildId, enabled) {
  ensureRow(guildId);
  db.prepare('UPDATE link_scanner_config SET enabled = ? WHERE guild_id = ?').run(enabled ? 1 : 0, guildId);
}

// ─── normaliseEntry ───────────────────────────────────────────────────────────
// Lowercase, strip leading protocol/www, trim trailing slash.
export function normaliseEntry(raw) {
  if (!raw) return null;
  let s = raw.toLowerCase().trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
  return s || null;
}

// ─── joinList ─────────────────────────────────────────────────────────────────
// Parse the stored newline-joined string into a clean array.
export function joinList(raw) {
  if (!raw) return [];
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}

// ─── addDomain ────────────────────────────────────────────────────────────────
export function addDomain(guildId, domain) {
  const norm = normaliseEntry(domain);
  if (!norm) return false;
  ensureRow(guildId);
  const current = joinList(getConfig(guildId)?.domain_whitelist);
  if (current.includes(norm)) return false; // already present
  const updated = [...current, norm].join('\n');
  db.prepare('UPDATE link_scanner_config SET domain_whitelist = ? WHERE guild_id = ?').run(updated, guildId);
  return true;
}

// ─── removeDomain ─────────────────────────────────────────────────────────────
export function removeDomain(guildId, domain) {
  const norm = normaliseEntry(domain);
  if (!norm) return false;
  ensureRow(guildId);
  const current = joinList(getConfig(guildId)?.domain_whitelist);
  const updated = current.filter(d => d !== norm).join('\n');
  db.prepare('UPDATE link_scanner_config SET domain_whitelist = ? WHERE guild_id = ?').run(updated, guildId);
  return current.length !== updated.split('\n').filter(Boolean).length;
}

// ─── bulkAddDomains ───────────────────────────────────────────────────────────
// Add multiple domains at once. Returns { added, skipped } counts.
export function bulkAddDomains(guildId, domains) {
  ensureRow(guildId);
  const current = new Set(joinList(getConfig(guildId)?.domain_whitelist));
  let added = 0, skipped = 0;
  for (const raw of domains) {
    const norm = normaliseEntry(raw);
    if (!norm) { skipped++; continue; }
    if (current.has(norm)) { skipped++; continue; }
    current.add(norm);
    added++;
  }
  db.prepare('UPDATE link_scanner_config SET domain_whitelist = ? WHERE guild_id = ?')
    .run([...current].join('\n'), guildId);
  return { added, skipped };
}

// ─── addChannel ───────────────────────────────────────────────────────────────
export function addChannel(guildId, channelId) {
  ensureRow(guildId);
  const current = joinList(getConfig(guildId)?.channel_whitelist);
  if (current.includes(channelId)) return false;
  const updated = [...current, channelId].join('\n');
  db.prepare('UPDATE link_scanner_config SET channel_whitelist = ? WHERE guild_id = ?').run(updated, guildId);
  return true;
}

// ─── removeChannel ────────────────────────────────────────────────────────────
export function removeChannel(guildId, channelId) {
  ensureRow(guildId);
  const current = joinList(getConfig(guildId)?.channel_whitelist);
  const updated = current.filter(id => id !== channelId).join('\n');
  db.prepare('UPDATE link_scanner_config SET channel_whitelist = ? WHERE guild_id = ?').run(updated, guildId);
  return current.length !== updated.split('\n').filter(Boolean).length;
}
