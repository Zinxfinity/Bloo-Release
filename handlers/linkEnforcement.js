import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../config/embeds.js';
import db from '../db.js';
import { isStaff } from './staffSystem.js';
import { getConfig as getScanConfig, joinList } from './linkScanner.js';
import { createApprovalRequest, setApprovalMessage } from './banSystem.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
// link_scanner_config and link_blacklist are NOT this file's tables, that
// collided with linkScanner.js's own (differently-shaped) link_scanner_config
// and left this file's "simple blocklist" section checking a link_blacklist
// table nothing ever wrote to, permanently a no-op regardless of what !links
// or the dashboard's Links page configured. See linkScanner.js for the real,
// live schema (domain_whitelist/domain_blacklist/channel_whitelist), reused
// directly below instead of a second incompatible copy.
//
// Exported so dashboard/routes/wordfilter.js (which also touches these three
// tables) can delegate here instead of keeping its own, previously-drifted
// copy (link_domain_tiers.tier was TEXT there, INTEGER severity here, a
// domain marked "block" via the dashboard was never actually enforced).
// Checked the real database before writing this: 39 guilds already have a
// link_enforcement_config row (one, 1474216491018899658, has a genuinely
// hand-configured severity mode with a real DM template and alert role),
// but the live table has no `enabled` column at all, every one of those
// rows was auto-created by dashboard/routes/wordfilter.js's GET route doing
// an unconditional INSERT OR IGNORE the moment a guild's staff so much as
// loaded the settings page. Without a real off-by-default gate, turning this
// on would have started deleting links in ~38 guilds that never asked for
// it. `enabled` defaults to 0 for exactly that reason, existing rows
// (including the one real hand-configured guild) start disabled until
// someone explicitly flips it on through the new toggle.
export function ensureLinkEnforcementSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS link_enforcement_config (
      guild_id            TEXT PRIMARY KEY,
      enabled             INTEGER NOT NULL DEFAULT 0,
      mode                TEXT    NOT NULL DEFAULT 'standard'
                            CHECK (mode IN ('standard','shadow','strike','severity','age_gate','approval')),
      alert_channel_id    TEXT,
      alert_role_id       TEXT,
      dm_template         TEXT,
      strike_window_h     INTEGER NOT NULL DEFAULT 24,
      strike_2_action     TEXT    NOT NULL DEFAULT 'timeout',
      strike_2_dur_min    INTEGER NOT NULL DEFAULT 10,
      strike_3_action     TEXT    NOT NULL DEFAULT 'kick',
      strike_3_dur_min    INTEGER NOT NULL DEFAULT 60,
      sev_tier1_action    TEXT    NOT NULL DEFAULT 'delete',
      sev_tier2_action    TEXT    NOT NULL DEFAULT 'timeout',
      sev_tier2_dur_min   INTEGER NOT NULL DEFAULT 10,
      sev_tier3_action    TEXT    NOT NULL DEFAULT 'ban',
      age_min_days        INTEGER NOT NULL DEFAULT 7,
      age_young_action    TEXT    NOT NULL DEFAULT 'ban',
      age_young_dur_min   INTEGER NOT NULL DEFAULT 0,
      age_old_action      TEXT    NOT NULL DEFAULT 'timeout',
      age_old_dur_min     INTEGER NOT NULL DEFAULT 10,
      approval_channel_id TEXT
    );

    CREATE TABLE IF NOT EXISTS link_domain_tiers (
      guild_id TEXT NOT NULL,
      domain   TEXT NOT NULL,
      tier     INTEGER NOT NULL DEFAULT 1 CHECK (tier IN (1, 2, 3)),
      PRIMARY KEY (guild_id, domain)
    );

    CREATE TABLE IF NOT EXISTS link_strikes (
      guild_id TEXT    NOT NULL,
      user_id  TEXT    NOT NULL,
      domain   TEXT,
      hit_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_link_strikes_lookup ON link_strikes (guild_id, user_id, hit_at);
  `);

  try { db.exec(`ALTER TABLE link_enforcement_config ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

  // Both tier/strike tables predate this design on a real, already-deployed
  // database (0 rows in either live), safe to rebuild outright rather than
  // migrate given there is nothing to lose.
  const tierCols = db.prepare(`PRAGMA table_info(link_domain_tiers)`).all();
  const tierType = tierCols.find(c => c.name === 'tier')?.type;
  if (tierType && tierType.toUpperCase() !== 'INTEGER') {
    db.exec(`DROP TABLE link_domain_tiers`);
    db.exec(`
      CREATE TABLE link_domain_tiers (
        guild_id TEXT NOT NULL,
        domain   TEXT NOT NULL,
        tier     INTEGER NOT NULL DEFAULT 1 CHECK (tier IN (1, 2, 3)),
        PRIMARY KEY (guild_id, domain)
      );
    `);
  }
  const strikeCols = db.prepare(`PRAGMA table_info(link_strikes)`).all().map(c => c.name);
  if (strikeCols.includes('strikes') && !strikeCols.includes('hit_at')) {
    db.exec(`DROP TABLE link_strikes`);
    db.exec(`
      CREATE TABLE link_strikes (
        guild_id TEXT    NOT NULL,
        user_id  TEXT    NOT NULL,
        domain   TEXT,
        hit_at   INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_link_strikes_lookup ON link_strikes (guild_id, user_id, hit_at);
    `);
  }
}
ensureLinkEnforcementSchema(db);

const stmts = {
  getConfig:     db.prepare(`SELECT * FROM link_enforcement_config WHERE guild_id = ?`),
  ensureConfig:  db.prepare(`INSERT OR IGNORE INTO link_enforcement_config (guild_id) VALUES (?)`),
  getDomainTier: db.prepare(`SELECT tier FROM link_domain_tiers WHERE guild_id = ? AND domain = ?`),
  recordStrike:  db.prepare(`INSERT INTO link_strikes (guild_id, user_id, domain, hit_at) VALUES (?, ?, ?, unixepoch())`),
  countStrikes:  db.prepare(`SELECT COUNT(*) AS n FROM link_strikes WHERE guild_id = ? AND user_id = ? AND hit_at > ?`),
};

// Only ever used as a source for fresh RegExp instances: a shared /g regex
// keeps lastIndex between .test() calls, which made every other link message
// slip past enforcement.
const URL_PATTERN_SOURCE = String.raw`https?:\/\/([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)`;
const HAS_URL = new RegExp(URL_PATTERN_SOURCE, 'i');

function extractDomains(text) {
  const domains = [];
  let match;
  const pattern = new RegExp(URL_PATTERN_SOURCE, 'gi');
  while ((match = pattern.exec(text)) !== null) {
    domains.push(match[1].toLowerCase());
  }
  return domains;
}

// Matches an entry from domain_whitelist/domain_blacklist against a
// candidate domain, per the *.sub / exact-path conventions already
// documented in commands/moderation/links.js's entryTypeLabel(): a bare
// domain matches itself and all subdomains, a "*.sub" entry matches only
// subdomains (not the bare domain), and a "/path" suffix additionally
// requires that literal path to appear in the message content.
function entryMatches(entry, domain, content) {
  const [entryDomain, ...pathParts] = entry.split('/');
  const isWild = entryDomain.startsWith('*.');
  const base   = isWild ? entryDomain.slice(2) : entryDomain;

  const domainOk = isWild
    ? domain.endsWith(`.${base}`)
    : (domain === base || domain.endsWith(`.${base}`));
  if (!domainOk) return false;

  if (!pathParts.length) return true;
  return content.includes('/' + pathParts.join('/'));
}

// Standard Discord/Fluxer snowflake epoch (2015-01-01T00:00:00.000Z),
// matches the identical formula already used privately in handlers/modLog.js.
function snowflakeToMs(id) {
  return Number(BigInt(id) >> 22n) + 1420070400000;
}

const MAX_TIMEOUT_MIN = 40320; // 28 days, the platform's hard cap on a single timeout

async function applyEnforcementAction(client, guildId, userId, action, durationMin, reason) {
  if (action === 'delete') return; // message is already deleted by the caller
  const { recordAutoCase } = await import('./autoModCase.js');
  const user = { id: userId };
  try {
    if (action === 'timeout') {
      const minutes = durationMin > 0 ? Math.min(durationMin, MAX_TIMEOUT_MIN) : MAX_TIMEOUT_MIN;
      const until = new Date(Date.now() + minutes * 60000).toISOString();
      await client.rest.patch(`/guilds/${guildId}/members/${userId}`, {
        body: { communication_disabled_until: until },
      });
      await recordAutoCase(client, guildId, user, 'mute', reason, 'Link enforcement', [{ name: 'Duration', value: `${minutes}m`, inline: true }]);
    } else if (action === 'kick') {
      await client.rest.delete(`/guilds/${guildId}/members/${userId}?reason=${encodeURIComponent(reason)}`);
      await recordAutoCase(client, guildId, user, 'kick', reason, 'Link enforcement');
    } else if (action === 'ban') {
      // Shared ban path: the member gets the ban notice and appeal steps.
      const { performBanAction } = await import('./banSystem.js');
      await performBanAction(client.rest, guildId, userId, reason, 'ban', 0);
      await recordAutoCase(client, guildId, user, 'ban', reason, 'Link enforcement');
    }
  } catch { /* best effort, missing permissions or role hierarchy */ }
}

async function sendStaffAlert(client, config, guildId, userId, domain, mode, actionTaken) {
  if (!config.alert_channel_id) return;

  const roleIds = (config.alert_role_id ?? '').split(',').map(r => r.trim()).filter(Boolean);
  const ping = roleIds.length ? roleIds.map(r => `<@&${r}>`).join(' ') : undefined;

  const embed = new EmbedBuilder()
    .setColor(COLORS.WARNING)
    .setTitle('🔗 Link Enforcement')
    .addFields(
      { name: 'User',   value: `<@${userId}>`, inline: true },
      { name: 'Domain', value: domain ?? 'unknown', inline: true },
      { name: 'Mode',   value: mode, inline: true },
      { name: 'Action', value: actionTaken, inline: true },
    )
    .setTimestamp();

  // Raw REST, not client.channels.fetch() + channel.send(): confirmed in
  // production that pattern fails with "channel.send is not a function"
  // for at least one channel type on v2.0.1's SDK.
  await client.rest.post(`/channels/${config.alert_channel_id}/messages`, {
    body: { content: ping, embeds: [embed.toJSON()] },
  }).catch(() => {});
}

async function sendViolationDm(client, member, config, domain, channelName) {
  if (!config.dm_template) return;
  const text = config.dm_template
    .replace(/{user}/g, member.user?.username ?? member.username ?? 'there')
    .replace(/{domain}/g, domain ?? 'that link')
    .replace(/{channel}/g, channelName ? `#${channelName}` : 'this channel');
  try {
    const dm = await member.user?.createDM?.().catch(() => null);
    if (dm) await dm.send({ content: text });
  } catch { /* DMs may be closed, non-fatal */ }
}

async function createLinkApproval(client, guildId, config, userId, userTag, domain) {
  const id = createApprovalRequest({
    guildId,
    targetId: userId,
    targetTag: userTag,
    executorId: client.user.id,
    executorTag: 'Link Enforcement (auto)',
    reason: `Posted a link (${domain}) flagged by Link Enforcement`,
  });
  if (!config.approval_channel_id) return id;
  const embed = new EmbedBuilder()
    .setColor(COLORS.WARNING)
    .setTitle('🔒 Ban Approval Required, Link Enforcement')
    .addFields(
      { name: 'User',   value: `${userTag} (\`${userId}\`)`, inline: true },
      { name: 'Domain', value: domain ?? 'unknown', inline: true },
      { name: 'Approval ID', value: `#${id}`, inline: true },
    )
    .setFooter({ text: `Use !ban approve/deny ${id}` })
    .setTimestamp();
  // Raw REST, not client.channels.fetch() + channel.send(): confirmed in
  // production that pattern fails with "channel.send is not a function"
  // for at least one channel type on v2.0.1's SDK.
  const msg = await client.rest.post(`/channels/${config.approval_channel_id}/messages`, {
    body: { embeds: [embed.toJSON()] },
  }).catch(() => null);
  if (msg?.id) setApprovalMessage(id, msg.id, config.approval_channel_id);
  return id;
}

// Returns true when the message was removed, so later handlers (the link
// auditor) don't repost a link this just blocked.
export async function enforceLink(client, message) {
  const guildId = message.guildId;
  const userId  = message.author?.id;
  if (!guildId || !userId) return false;

  const content = message.content ?? '';
  if (!HAS_URL.test(content)) return false;

  if (await isStaff(client, guildId, userId)) return false;

  const domains = extractDomains(content);
  if (!domains.length) return false;

  // ── Link scanner (!links command / dashboard Links page) ──────────────────
  // domain_blacklist is an always-blocked list, applied whether or not
  // whitelist mode is on (it used to only run inside whitelist mode, where
  // it adds nothing since every non-whitelisted domain is blocked anyway).
  // Whitelist mode blocks every domain not on domain_whitelist; an empty
  // whitelist blocks everything. Separate from the mode-based enforcement
  // below, both can be active at once.
  const scanConfig = getScanConfig(guildId);
  if (scanConfig) {
    const exemptChannels = joinList(scanConfig.channel_whitelist);
    if (!exemptChannels.includes(message.channelId)) {
      const blacklist = joinList(scanConfig.domain_blacklist);
      const whitelist = joinList(scanConfig.domain_whitelist);

      const blacklisted    = domains.find(d => blacklist.some(e => entryMatches(e, d, content)));
      const notWhitelisted = scanConfig.enabled && domains.find(d => !whitelist.some(e => entryMatches(e, d, content)));

      if (blacklisted || notWhitelisted) {
        try { await message.delete(); } catch { /* best effort */ }
        return true;
      }
    }
  }

  // ── Mode-based Link Enforcement (dashboard's standard/shadow/strike/
  // severity/age_gate/approval config) ──────────────────────────────────────
  const config = getLinkEnforcementConfig(guildId);
  if (!config?.enabled) return false;

  const domain = domains[0];

  try { await message.delete(); } catch { /* best effort */ }

  let action = 'delete', durationMin = 0;

  switch (config.mode) {
    case 'strike': {
      const windowStart = Math.floor(Date.now() / 1000) - (config.strike_window_h ?? 24) * 3600;
      const priorHits = stmts.countStrikes.get(guildId, userId, windowStart).n;
      stmts.recordStrike.run(guildId, userId, domain);
      const strikeNumber = priorHits + 1;
      if (strikeNumber === 1)      { action = 'delete'; }
      else if (strikeNumber === 2) { action = config.strike_2_action; durationMin = config.strike_2_dur_min; }
      else                          { action = config.strike_3_action; durationMin = config.strike_3_dur_min; }
      break;
    }
    case 'severity': {
      const tier = stmts.getDomainTier.get(guildId, domain)?.tier ?? 1;
      if (tier === 1)      { action = config.sev_tier1_action; }
      else if (tier === 2) { action = config.sev_tier2_action; durationMin = config.sev_tier2_dur_min; }
      else                  { action = config.sev_tier3_action; }
      break;
    }
    case 'age_gate': {
      const ageDays = (Date.now() - snowflakeToMs(userId)) / 86400000;
      if (ageDays < (config.age_min_days ?? 7)) { action = config.age_young_action; durationMin = config.age_young_dur_min; }
      else                                       { action = config.age_old_action;   durationMin = config.age_old_dur_min; }
      break;
    }
    case 'approval': {
      action = 'timeout';
      durationMin = 10; // holding action while the approval request is pending
      break;
    }
    case 'shadow':
    case 'standard':
    default:
      action = 'delete';
      break;
  }

  const reason = `Link enforcement (${config.mode}): posted ${domain}`;
  if (action !== 'delete') {
    await applyEnforcementAction(client, guildId, userId, action, durationMin, reason);
  }

  if (config.mode === 'approval') {
    const userTag = message.author?.username ?? userId;
    await createLinkApproval(client, guildId, config, userId, userTag, domain).catch(() => {});
  }

  // Shadow mode is silent in-channel by design, staff log and DM (if
  // configured) still fire below.
  if (config.mode === 'standard') {
    try {
      await message.channel?.send?.({ content: `⚠️ <@${userId}>, links aren't allowed here.` });
    } catch { /* non-fatal */ }
  }

  await sendViolationDm(client, message.member ?? { user: message.author }, config, domain, message.channel?.name);
  await sendStaffAlert(client, config, guildId, userId, domain, config.mode, action).catch(() => {});
  return true;
}

export function getLinkEnforcementConfig(guildId) {
  stmts.ensureConfig.run(guildId);
  return stmts.getConfig.get(guildId);
}

const SETTABLE_FIELDS = [
  'enabled', 'mode', 'alert_channel_id', 'alert_role_id', 'dm_template',
  'strike_window_h', 'strike_2_action', 'strike_2_dur_min', 'strike_3_action', 'strike_3_dur_min',
  'sev_tier1_action', 'sev_tier2_action', 'sev_tier2_dur_min', 'sev_tier3_action',
  'age_min_days', 'age_young_action', 'age_young_dur_min', 'age_old_action', 'age_old_dur_min',
  'approval_channel_id',
];

export function setLinkEnforcementField(guildId, field, value) {
  if (!SETTABLE_FIELDS.includes(field)) throw new Error(`Unknown link enforcement field: ${field}`);
  stmts.ensureConfig.run(guildId);
  db.prepare(`UPDATE link_enforcement_config SET ${field} = ? WHERE guild_id = ?`).run(value, guildId);
}

export function setDomainTier(guildId, domain, tier) {
  db.prepare(`
    INSERT INTO link_domain_tiers (guild_id, domain, tier) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, domain) DO UPDATE SET tier = excluded.tier
  `).run(guildId, domain.toLowerCase(), tier);
}

export function removeDomainTier(guildId, domain) {
  db.prepare(`DELETE FROM link_domain_tiers WHERE guild_id = ? AND domain = ?`).run(guildId, domain.toLowerCase());
}

export function listDomainTiers(guildId) {
  return db.prepare(`SELECT domain, tier FROM link_domain_tiers WHERE guild_id = ? ORDER BY tier, domain`).all(guildId);
}

export function getLinkScanConfig(guildId) {
  return getScanConfig(guildId) ?? null;
}
