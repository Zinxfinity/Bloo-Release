// ─── Changelog ────────────────────────────────────────────────────────────────
// Single owner of the changelog tables. Used by the bot-owner dashboard page
// (Developer → Changelog), the bot-owner `b!changelog` command, the public
// API behind bloo-bot.xyz/docs/changelog (dashboard/routes/changelog.js) and
// scripts/changelog-drafts.mjs, which pull.sh runs after every deploy.
//
// An entry is one titled change with a short Markdown body and topic tags.
// Entries without a release are drafts. Publishing gathers every draft into
// a release with a version and build number, and posts it to Fluxer through
// the changelog webhook. Commit messages from each deploy arrive as a draft
// entry so nothing slips through, to be edited or deleted before publishing.
import db from '../db.js';

export const TAGS = ['moderation', 'verification', 'tickets', 'xp', 'economy', 'community', 'feeds', 'dashboard', 'docs', 'commands', 'fixes', 'performance', 'security'];
const MAX_TITLE = 120;
const MAX_BODY = 3000;
const SITE = () => (process.env.SITE_URL || 'https://bloo-bot.xyz').replace(/\/+$/, '');

db.exec(`
  CREATE TABLE IF NOT EXISTS changelog_releases (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    version            TEXT    NOT NULL UNIQUE,
    build              INTEGER NOT NULL,
    published_at       INTEGER NOT NULL,
    published_by       TEXT,
    webhook_status     TEXT,
    webhook_error      TEXT,
    webhook_posted_at  INTEGER
  );
  CREATE TABLE IF NOT EXISTS changelog_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    release_id  INTEGER,
    title       TEXT    NOT NULL,
    body        TEXT    NOT NULL DEFAULT '',
    tags        TEXT    NOT NULL DEFAULT '[]',
    source      TEXT    NOT NULL DEFAULT 'manual',
    position    INTEGER NOT NULL DEFAULT 0,
    created_by  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_changelog_entries_release ON changelog_entries (release_id, position);
  CREATE TABLE IF NOT EXISTS changelog_commits (
    sha        TEXT PRIMARY KEY,
    entry_id   INTEGER,
    seen_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS changelog_config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

export class ChangelogError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// ── Validation ──────────────────────────────────────────────────────────────
function cleanText(s, max, field, required = true) {
  const v = String(s ?? '').replace(/\r\n/g, '\n').trim();
  if (required && !v) throw new ChangelogError(`${field} is required.`);
  if (v.length > max) throw new ChangelogError(`${field} can be at most ${max} characters.`);
  return v;
}
function cleanTags(tags) {
  const list = (Array.isArray(tags) ? tags : String(tags ?? '').split(','))
    .map(t => String(t).trim().toLowerCase()).filter(Boolean);
  const bad = list.filter(t => !TAGS.includes(t));
  if (bad.length) throw new ChangelogError(`Unknown tag${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}. Use: ${TAGS.join(', ')}.`);
  return [...new Set(list)];
}
const parseVersion = v => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? m.slice(1, 4).map(Number) : null;
};
const cmpVersion = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
export const releaseTag = version => `release-${version.replace(/\./g, '-')}`;
export const releaseAnchor = version => `v${version.replace(/\./g, '-')}`;

// ── Rows ────────────────────────────────────────────────────────────────────
const q = {
  drafts:       db.prepare(`SELECT * FROM changelog_entries WHERE release_id IS NULL ORDER BY position, id`),
  entry:        db.prepare(`SELECT * FROM changelog_entries WHERE id = ?`),
  maxPos:       db.prepare(`SELECT COALESCE(MAX(position), 0) AS p FROM changelog_entries WHERE release_id IS NULL`),
  insert:       db.prepare(`INSERT INTO changelog_entries (title, body, tags, source, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  update:       db.prepare(`UPDATE changelog_entries SET title = ?, body = ?, tags = ?, updated_at = ? WHERE id = ?`),
  del:          db.prepare(`DELETE FROM changelog_entries WHERE id = ?`),
  lastRelease:  db.prepare(`SELECT * FROM changelog_releases ORDER BY build DESC LIMIT 1`),
  release:      db.prepare(`SELECT * FROM changelog_releases WHERE id = ?`),
  releases:     db.prepare(`SELECT * FROM changelog_releases ORDER BY build DESC LIMIT ?`),
  releasesOld:  db.prepare(`SELECT * FROM changelog_releases WHERE build < ? ORDER BY build DESC LIMIT ?`),
  entriesOf:    db.prepare(`SELECT * FROM changelog_entries WHERE release_id = ? ORDER BY position, id`),
  insertRel:    db.prepare(`INSERT INTO changelog_releases (version, build, published_at, published_by) VALUES (?, ?, ?, ?)`),
  assign:       db.prepare(`UPDATE changelog_entries SET release_id = ? WHERE release_id IS NULL`),
  hook:         db.prepare(`UPDATE changelog_releases SET webhook_status = ?, webhook_error = ?, webhook_posted_at = ? WHERE id = ?`),
  commitSeen:   db.prepare(`SELECT 1 FROM changelog_commits WHERE sha = ?`),
  commitAdd:    db.prepare(`INSERT OR IGNORE INTO changelog_commits (sha, entry_id, seen_at) VALUES (?, ?, ?)`),
  cfgGet:       db.prepare(`SELECT value FROM changelog_config WHERE key = ?`),
  cfgSet:       db.prepare(`INSERT INTO changelog_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  cfgDel:       db.prepare(`DELETE FROM changelog_config WHERE key = ?`),
};

const view = e => ({ id: e.id, title: e.title, body: e.body, tags: JSON.parse(e.tags || '[]'), source: e.source, createdAt: e.created_at, updatedAt: e.updated_at });

// ── Drafts ──────────────────────────────────────────────────────────────────
export function listDrafts() { return q.drafts.all().map(view); }

export function addDraft({ title, body, tags }, by, source = 'manual') {
  const now = Date.now();
  const id = Number(q.insert.run(
    cleanText(title, MAX_TITLE, 'Title'), cleanText(body, MAX_BODY, 'Body', false),
    JSON.stringify(cleanTags(tags)), source, q.maxPos.get().p + 1, by ?? null, now, now,
  ).lastInsertRowid);
  return view(q.entry.get(id));
}

function draftOrThrow(id) {
  const e = q.entry.get(Number(id));
  if (!e) throw new ChangelogError('That entry does not exist.');
  if (e.release_id != null) throw new ChangelogError('That entry is already published and can no longer be changed.');
  return e;
}

export function editDraft(id, { title, body, tags }) {
  const e = draftOrThrow(id);
  q.update.run(
    title === undefined ? e.title : cleanText(title, MAX_TITLE, 'Title'),
    body === undefined ? e.body : cleanText(body, MAX_BODY, 'Body', false),
    tags === undefined ? e.tags : JSON.stringify(cleanTags(tags)),
    Date.now(), e.id,
  );
  return view(q.entry.get(e.id));
}

export function deleteDraft(id) { q.del.run(draftOrThrow(id).id); }

// Deploy commits become one draft per deploy, listing each new commit once.
// `commits` is [{ sha, subject }], oldest first. Returns the draft or null.
export function importCommits(commits, label) {
  const fresh = (commits ?? [])
    .map(c => ({ sha: String(c.sha ?? '').trim(), subject: String(c.subject ?? '').trim() }))
    .filter(c => c.sha && c.subject && !/^merge\b/i.test(c.subject) && !q.commitSeen.get(c.sha));
  if (!fresh.length) return null;
  return db.transaction(() => {
    const body = fresh.map(c => `- ${c.subject}`).join('\n').slice(0, MAX_BODY);
    const entry = addDraft({ title: `Deploy ${label || new Date().toISOString().slice(0, 10)} (review before publishing)`, body, tags: [] }, 'deploy', 'deploy');
    for (const c of fresh) q.commitAdd.run(c.sha, entry.id, Date.now());
    return entry;
  })();
}

// ── Releases ────────────────────────────────────────────────────────────────
export function latestRelease() {
  const r = q.lastRelease.get();
  return r ? releaseView(r) : null;
}

// The next version for patch/minor/major, counted from the last release (or
// from package.json's 2.0.0 before the first one).
export function suggestVersion(kind = 'minor', base = '2.0.0') {
  const [a, b, c] = parseVersion(q.lastRelease.get()?.version ?? base) ?? [2, 0, 0];
  return kind === 'major' ? `${a + 1}.0.0` : kind === 'patch' ? `${a}.${b}.${c + 1}` : `${a}.${b + 1}.0`;
}

export const publish = db.transaction(({ version }, by) => {
  const v = parseVersion(version);
  if (!v) throw new ChangelogError('Version must look like 2.1.0.');
  const clean = v.join('.');
  const last = q.lastRelease.get();
  if (last && cmpVersion(v, parseVersion(last.version)) <= 0) throw new ChangelogError(`Version must be higher than the last release, ${last.version}.`);
  const drafts = q.drafts.all();
  if (!drafts.length) throw new ChangelogError('There are no draft entries to publish.');
  const leftover = drafts.filter(d => d.source === 'deploy' && /review before publishing/i.test(d.title));
  if (leftover.length) throw new ChangelogError(`Review the deploy draft "${leftover[0].title}" first: rename it or delete it.`);
  const id = Number(q.insertRel.run(clean, (last?.build ?? 0) + 1, Date.now(), by ?? null).lastInsertRowid);
  q.assign.run(id);
  return releaseView(q.release.get(id));
});

function releaseView(r, { html = false } = {}) {
  const entries = q.entriesOf.all(r.id).map(view);
  const tag = releaseTag(r.version);
  return {
    id: r.id, version: r.version, build: r.build, publishedAt: r.published_at,
    anchor: releaseAnchor(r.version), url: `${SITE()}/docs/changelog/#${releaseAnchor(r.version)}`,
    webhook: { status: r.webhook_status, error: r.webhook_error, postedAt: r.webhook_posted_at },
    entries: entries.map(e => ({ ...e, tags: [...e.tags, tag], ...(html ? { html: renderMarkdown(e.body) } : {}) })),
  };
}

export function listReleases({ limit = 20 } = {}) { return q.releases.all(limit).map(r => releaseView(r)); }

// Public shape for the website: no user ids, no webhook details.
export function publicChangelog({ limit = 20, before } = {}) {
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  const rows = before ? q.releasesOld.all(Number(before), n) : q.releases.all(n);
  const releases = rows.map(r => {
    const { webhook, ...rest } = releaseView(r, { html: true });
    return { ...rest, entries: rest.entries.map(({ source, createdAt, updatedAt, ...e }) => e) };
  });
  return { releases, tags: TAGS, hasMore: rows.length === n && rows.at(-1).build > 1 };
}

// ── Markdown (the small subset entries use) ─────────────────────────────────
// Paragraphs, "- " bullets, **bold**, *italic*, `code` and [text](https://…).
// Everything is escaped first, so a body can never inject HTML.
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, text, url) => `<a href="${url}" rel="noopener">${text}</a>`);
}
export function renderMarkdown(md) {
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<ul>${list.map(li => `<li>${inline(li)}</li>`).join('')}</ul>`); list = null; } };
  for (const raw of String(md ?? '').split('\n')) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!line) { flushPara(); flushList(); }
    else if (bullet) { flushPara(); (list ??= []).push(bullet[1]); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join('');
}

// ── RSS ─────────────────────────────────────────────────────────────────────
export function rss() {
  const { releases } = publicChangelog({ limit: 30 });
  const items = releases.flatMap(r => r.entries.map(e => `
    <item>
      <title>${escapeHtml(`${e.title} (v${r.version})`)}</title>
      <link>${escapeHtml(r.url)}</link>
      <guid isPermaLink="false">bloo-changelog-${e.id}</guid>
      <pubDate>${new Date(r.publishedAt).toUTCString()}</pubDate>
      ${e.tags.map(t => `<category>${escapeHtml(t)}</category>`).join('')}
      <description>${escapeHtml(e.html)}</description>
    </item>`)).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Bloo changelog</title>
    <link>${SITE()}/docs/changelog/</link>
    <description>Every Bloo release, newest first.</description>
    <language>en</language>${items}
  </channel>
</rss>`;
}

// ── Webhook ─────────────────────────────────────────────────────────────────
const WEBHOOK_RE = /^https:\/\/(api\.)?fluxer\.app\/(api\/)?(v\d+\/)?webhooks\/\d+\/[\w-]+$/;
export function getWebhookUrl() { return q.cfgGet.get('webhook_url')?.value || process.env.CHANGELOG_WEBHOOK_URL || ''; }
export function webhookSummary() {
  const url = getWebhookUrl();
  if (!url) return { configured: false };
  const id = /webhooks\/(\d+)\//.exec(url)?.[1];
  return { configured: true, fromEnv: !q.cfgGet.get('webhook_url')?.value, hint: id ? `webhook …${id.slice(-4)}` : 'set' };
}
export function setWebhookUrl(url) {
  const v = String(url ?? '').trim();
  if (!v) { q.cfgDel.run('webhook_url'); return webhookSummary(); }
  if (!WEBHOOK_RE.test(v)) throw new ChangelogError('That does not look like a Fluxer webhook URL (https://api.fluxer.app/webhooks/<id>/<token>).');
  q.cfgSet.run('webhook_url', v);
  return webhookSummary();
}

const COLOR = 0x4ade80;
// One release as a single tidy embed: entry titles grouped by topic, with
// the full write-ups left on the docs changelog. Returned as a list of
// messages (always one) so postRelease stays the same shape.
const TOPIC_HEADINGS = {
  moderation: '🛡️ Moderation', verification: '🔐 Verification', tickets: '🎫 Tickets', xp: '⭐ XP and levels',
  economy: '💰 Economy', community: '💬 Community', feeds: '📰 Feeds', dashboard: '🖥️ Dashboard', docs: '📘 Docs',
  commands: '⌨️ Commands', performance: '⚡ Performance', security: '🔒 Security', fixes: '🔧 Fixes',
};
const TOPIC_ORDER = Object.keys(TOPIC_HEADINGS);
const DESC_LIMIT = 3900; // Fluxer's embed description limit is 4096; leave room for the "more" line

export function releaseMessages(release) {
  // Each entry goes under its first topic tag; untagged ones go under "Other".
  const groups = new Map();
  for (const e of release.entries) {
    const topic = e.tags.find(t => TOPIC_HEADINGS[t]) ?? 'other';
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(e.title);
  }
  const order = [...groups.keys()].sort((a, b) => (TOPIC_ORDER.indexOf(a) + 1 || 99) - (TOPIC_ORDER.indexOf(b) + 1 || 99));

  const lines = [];
  let shown = 0;
  outer: for (const topic of order) {
    const block = [`**${TOPIC_HEADINGS[topic] ?? '✨ Other'}**`];
    for (const title of groups.get(topic)) {
      const next = [...lines, ...block, `• ${title}`].join('\n');
      if (next.length > DESC_LIMIT) { if (block.length > 1) lines.push(...block); break outer; }
      block.push(`• ${title}`);
      shown++;
    }
    lines.push(...block, '');
  }
  let desc = lines.join('\n').trim();
  const hidden = release.entries.length - shown;
  desc += `\n\n${hidden > 0 ? `…and ${hidden} more. ` : ''}[Read the full notes](${release.url})`;

  return [[{
    title: `Bloo v${release.version}`, url: release.url, color: COLOR,
    description: desc,
    footer: { text: `Build ${release.build} · ${release.entries.length} change${release.entries.length === 1 ? '' : 's'}` },
    timestamp: new Date(release.publishedAt).toISOString(),
  }]];
}

async function send(url, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${url}?wait=true`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (res.status === 429 && attempt === 0) {
      const data = await res.json().catch(() => ({}));
      const wait = Math.min(10, Number(data.retry_after ?? res.headers.get('retry-after') ?? 2));
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Fluxer answered ${res.status}`);
    return;
  }
  throw new Error('Fluxer is rate limiting the webhook; try again in a minute.');
}

// Posts a release to the changelog webhook and records how it went.
export async function postRelease(releaseId) {
  const row = q.release.get(Number(releaseId));
  if (!row) throw new ChangelogError('That release does not exist.');
  const url = getWebhookUrl();
  if (!url) { q.hook.run('skipped', 'No changelog webhook is set.', null, row.id); return { ok: false, status: 'skipped' }; }
  try {
    for (const embeds of releaseMessages(releaseView(row))) {
      await send(url, { username: 'Bloo Updates', avatar_url: process.env.BLOO_PFP_URL || `${SITE()}/assets/bloo-pfp.png`, embeds });
    }
    q.hook.run('posted', null, Date.now(), row.id);
    return { ok: true, status: 'posted' };
  } catch (e) {
    q.hook.run('failed', String(e.message).slice(0, 300), null, row.id);
    return { ok: false, status: 'failed', error: e.message };
  }
}

export async function testWebhook() {
  const url = getWebhookUrl();
  if (!url) throw new ChangelogError('No changelog webhook is set.');
  await send(url, { username: 'Bloo Updates', avatar_url: process.env.BLOO_PFP_URL || `${SITE()}/assets/bloo-pfp.png`, embeds: [{ title: 'Changelog webhook connected', description: 'New Bloo releases will be posted here.', color: COLOR }] });
  return { ok: true };
}
