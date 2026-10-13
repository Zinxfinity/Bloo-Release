// ============================================================
//  handlers/cardBackgrounds.js
//
//  Rank card themes and custom backgrounds, per member (global, not per
//  server). Used by b!card, b!xp rank and the dashboard's Developer →
//  Card Backgrounds review page.
//
//  Every upload is reviewed by a bot owner before anyone sees it:
//    submit  → shrunk to 1520x400 and saved as pending/<user>.jpg,
//              overwriting any earlier pending upload. The member's current
//              approved background stays live meanwhile.
//    approve → pending file moved over approved/<user>.jpg, replacing (so
//              erasing) the old one.
//    decline → pending file deleted; the approved one is untouched.
//  Cards read the approved file from disk on every render, so nothing stale
//  can be shown after a change.
// ============================================================

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from '../db.js';
import logger from '../utils/logger.js';
import { RANK_CARD_THEMES, DEFAULT_RANK_CARD_THEME, VOTE_ONLY_THEMES } from './profileCard.js';
import { isSupporter } from './votes.js';
import { isContributor } from './contributors.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CARD_DIR = join(ROOT, 'data', 'card-backgrounds');
const APPROVED_DIR = join(CARD_DIR, 'approved');
const PENDING_DIR  = join(CARD_DIR, 'pending');
mkdirSync(APPROVED_DIR, { recursive: true });
mkdirSync(PENDING_DIR, { recursive: true });

// Upload limits. The stored file is always 1520x400 (the card at 2x) as a
// JPEG, which comes out around 60-120 KB whatever was uploaded.
export const LIMITS = { maxBytes: 8 * 1024 * 1024, maxSide: 4096, minWidth: 600, minHeight: 160, outW: 1520, outH: 400, quality: 0.84 };
const ACCEPTED = ['image/png', 'image/jpeg', 'image/gif'];

db.exec(`
  CREATE TABLE IF NOT EXISTS card_profiles (
    user_id          TEXT PRIMARY KEY,
    theme            TEXT,
    has_background   INTEGER NOT NULL DEFAULT 0,
    has_pending      INTEGER NOT NULL DEFAULT 0,
    pending_at       INTEGER,
    pending_name     TEXT,
    pending_guild    TEXT,
    reviewed_by      TEXT,
    reviewed_at      INTEGER,
    last_decision    TEXT,
    decline_reason   TEXT,
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

db.exec(`CREATE TABLE IF NOT EXISTS card_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

const q = {
  setting:    db.prepare(`SELECT value FROM card_settings WHERE key = ?`),
  setSetting: db.prepare(`INSERT INTO card_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`),
  get:     db.prepare(`SELECT * FROM card_profiles WHERE user_id = ?`),
  ensure:  db.prepare(`INSERT OR IGNORE INTO card_profiles (user_id) VALUES (?)`),
  theme:   db.prepare(`UPDATE card_profiles SET theme = ?, updated_at = unixepoch() WHERE user_id = ?`),
  pending: db.prepare(`UPDATE card_profiles SET has_pending = 1, pending_at = unixepoch(), pending_name = ?, pending_guild = ?, updated_at = unixepoch() WHERE user_id = ?`),
  approve: db.prepare(`UPDATE card_profiles SET has_background = 1, has_pending = 0, reviewed_by = ?, reviewed_at = unixepoch(), last_decision = 'approved', decline_reason = NULL, updated_at = unixepoch() WHERE user_id = ?`),
  decline: db.prepare(`UPDATE card_profiles SET has_pending = 0, reviewed_by = ?, reviewed_at = unixepoch(), last_decision = 'declined', decline_reason = ?, updated_at = unixepoch() WHERE user_id = ?`),
  cancel:  db.prepare(`UPDATE card_profiles SET has_pending = 0, updated_at = unixepoch() WHERE user_id = ?`),
  remove:  db.prepare(`UPDATE card_profiles SET has_background = 0, updated_at = unixepoch() WHERE user_id = ?`),
  list:    db.prepare(`SELECT * FROM card_profiles WHERE has_pending = 1 OR has_background = 1 ORDER BY has_pending DESC, pending_at ASC, updated_at DESC`),
  del:     db.prepare(`DELETE FROM card_profiles WHERE user_id = ?`),
};

export class CardError extends Error {}

// Custom backgrounds are held back until the bot owner switches them on
// (b!card backgrounds on, or the dashboard's Card Backgrounds page). While
// off, nothing can be submitted and cards never draw a custom background,
// even one approved during testing. Themes work either way.
export function backgroundsEnabled() {
  return q.setting.get('backgrounds_enabled')?.value === '1';
}
export function setBackgroundsEnabled(on) {
  q.setSetting.run('backgrounds_enabled', on ? '1' : '0');
  return backgroundsEnabled();
}
const isId = id => /^\d{15,22}$/.test(String(id ?? ''));

// File paths for a member, with no database access, so the dashboard's My
// Data delete can use them inside its own transaction.
export function cardFilePaths(userId) {
  if (!isId(userId)) throw new CardError('Invalid user ID.');
  return { approved: join(APPROVED_DIR, `${userId}.jpg`), pending: join(PENDING_DIR, `${userId}.jpg`) };
}

export function getCardProfile(userId) {
  const row = q.get.get(userId);
  const supporter = isSupporter(userId);
  // A vote-only theme falls back to the default while there's no vote, and
  // comes back by itself if they vote again (the saved choice is kept).
  const saved = row?.theme && RANK_CARD_THEMES[row.theme] ? row.theme : DEFAULT_RANK_CARD_THEME;
  const theme = VOTE_ONLY_THEMES.has(saved) && !supporter ? DEFAULT_RANK_CARD_THEME : saved;
  const { approved } = cardFilePaths(userId);
  return {
    theme,
    supporter,
    contributor: isContributor(userId),
    background: backgroundsEnabled() && row?.has_background && existsSync(approved) ? approved : null,
    pending: !!row?.has_pending,
    pendingAt: row?.pending_at ?? null,
    lastDecision: row?.last_decision ?? null,
    declineReason: row?.decline_reason ?? null,
  };
}

export function setCardTheme(userId, theme) {
  const key = String(theme ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const match = Object.keys(RANK_CARD_THEMES).find(k => k === key || RANK_CARD_THEMES[k].toLowerCase().replace(/[^a-z]/g, '') === key);
  if (!match) throw new CardError(`Unknown theme. Choose from: ${Object.values(RANK_CARD_THEMES).join(', ')}.`);
  if (VOTE_ONLY_THEMES.has(match) && !isSupporter(userId)) {
    throw new CardError(`The ${RANK_CARD_THEMES[match]} theme is a thank-you for voting for Bloo. Vote with \`b!vote\`, then pick it again.`);
  }
  q.ensure.run(userId);
  q.theme.run(match, userId);
  return match;
}

// ─── Upload processing ────────────────────────────────────────────────────────
// Downloads an attachment (size-capped while reading), checks it's a real
// image within limits, and returns it cropped to the card's shape.
export async function fetchImage(url) {
  if (!/^https:\/\//i.test(url)) throw new CardError('That upload has an unexpected address.');
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new CardError(`Couldn't download the image (${res.status}).`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > LIMITS.maxBytes) throw new CardError(tooBig());
  const chunks = []; let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > LIMITS.maxBytes) throw new CardError(tooBig());
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const tooBig = () => `That image is over ${LIMITS.maxBytes / 1024 / 1024} MB. Please upload a smaller one.`;

// shape: the size to crop to (the rank card by default; welcome cards pass their own).
export async function processImage(buffer, shape = LIMITS) {
  const { createCanvas, loadImage } = await import('canvas');
  // Sniff the real format rather than trusting the name or content type.
  const sig = buffer.subarray(0, 12);
  const isPng  = sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4E && sig[3] === 0x47;
  const isJpeg = sig[0] === 0xFF && sig[1] === 0xD8;
  const isGif  = sig.toString('ascii', 0, 4) === 'GIF8';
  const isWebp = sig.toString('ascii', 0, 4) === 'RIFF' && sig.toString('ascii', 8, 12) === 'WEBP';
  if (isWebp) throw new CardError('WebP images aren\'t supported yet. Please upload a PNG or JPEG.');
  if (!isPng && !isJpeg && !isGif) throw new CardError('That isn\'t a PNG, JPEG or GIF image.');

  let img;
  try { img = await loadImage(buffer); } catch { throw new CardError('That image couldn\'t be read. It may be damaged.'); }
  if (img.width > LIMITS.maxSide || img.height > LIMITS.maxSide) {
    throw new CardError(`That image is ${img.width}x${img.height}. The largest allowed is ${LIMITS.maxSide}x${LIMITS.maxSide}.`);
  }
  if (img.width < (shape.minWidth ?? LIMITS.minWidth) || img.height < (shape.minHeight ?? LIMITS.minHeight)) {
    throw new CardError(`That image is ${img.width}x${img.height}, too small to look sharp. Use at least ${shape.minWidth ?? LIMITS.minWidth}x${shape.minHeight ?? LIMITS.minHeight} (ideally ${shape.outW}x${shape.outH}).`);
  }

  // Cover-crop to the card's shape, centred.
  const { outW, outH } = shape;
  const scale = Math.max(outW / img.width, outH / img.height);
  const w = img.width * scale, h = img.height * scale;
  const canvas = createCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, outW, outH); // transparent PNGs get a black base
  ctx.drawImage(img, (outW - w) / 2, (outH - h) / 2, w, h);
  return canvas.toBuffer('image/jpeg', { quality: LIMITS.quality });
}

// ─── Submit / review ──────────────────────────────────────────────────────────
// attachment: { url, size, contentType, filename } from the Fluxer message.
export async function submitBackground(userId, attachment, { name = null, guildId = null } = {}) {
  if (!backgroundsEnabled()) throw new CardError("Custom backgrounds aren't available yet. You can still pick a theme with `b!card themes`.");
  if (!isId(userId)) throw new CardError('Invalid user ID.');
  if (!attachment?.url) throw new CardError('Attach an image to your message.');
  if (attachment.size && attachment.size > LIMITS.maxBytes) throw new CardError(tooBig());
  if (attachment.contentType && !ACCEPTED.includes(attachment.contentType.split(';')[0]) && !attachment.contentType.startsWith('image/')) {
    throw new CardError('That file isn\'t an image.');
  }
  const jpeg = await processImage(await fetchImage(attachment.url));
  const { pending } = cardFilePaths(userId);
  writeFileSync(pending, jpeg); // replaces any earlier pending upload
  q.ensure.run(userId);
  q.pending.run(name, guildId, userId);
  notifyOwners(`🖼️ **New card background to review** from ${name ?? userId} (\`${userId}\`). Review it on the dashboard (Developer → Card Backgrounds) or with \`b!card review\`.`).catch(() => {});
  return { bytes: jpeg.length };
}

export async function approveBackground(userId, by) {
  const { approved, pending } = cardFilePaths(userId);
  if (!q.get.get(userId)?.has_pending || !existsSync(pending)) throw new CardError('That member has no background waiting for review.');
  renameSync(pending, approved); // overwrites, so the old background is gone
  q.approve.run(by ?? null, userId);
  notifyUser(userId, '✅ Your rank card background was approved. It shows on `b!xp rank` now.').catch(() => {});
}

export async function declineBackground(userId, by, reason = null) {
  const { pending } = cardFilePaths(userId);
  if (!q.get.get(userId)?.has_pending) throw new CardError('That member has no background waiting for review.');
  rmSync(pending, { force: true });
  const why = reason ? String(reason).slice(0, 300) : null;
  q.decline.run(by ?? null, why, userId);
  notifyUser(userId, `❌ Your rank card background wasn't approved${why ? `: ${why}` : '.'} You can upload a different one with \`b!card background\`.`).catch(() => {});
}

// Member withdraws their own pending upload.
export function cancelPending(userId) {
  const { pending } = cardFilePaths(userId);
  const had = !!q.get.get(userId)?.has_pending;
  rmSync(pending, { force: true });
  q.cancel.run(userId);
  return had;
}

// Removes the live background (member's own choice, or a bot owner).
export function removeBackground(userId, { notify = false } = {}) {
  const { approved } = cardFilePaths(userId);
  const had = !!q.get.get(userId)?.has_background;
  rmSync(approved, { force: true });
  q.remove.run(userId);
  if (had && notify) notifyUser(userId, '🗑️ Your rank card background was removed by the bot owner.').catch(() => {});
  return had;
}

export function listBackgrounds() {
  return q.list.all().map(r => {
    const { approved, pending } = cardFilePaths(r.user_id);
    const size = p => (existsSync(p) ? statSync(p).size : null);
    return {
      userId: r.user_id, name: r.pending_name, theme: r.theme ?? DEFAULT_RANK_CARD_THEME,
      pending: !!r.has_pending, pendingAt: r.pending_at, pendingGuild: r.pending_guild, pendingBytes: size(pending),
      approved: !!r.has_background, approvedBytes: size(approved), reviewedAt: r.reviewed_at, reviewedBy: r.reviewed_by,
    };
  });
}

// For My Data deletion and b!card reset: files and row.
export function deleteCardData(userId) {
  const { approved, pending } = cardFilePaths(userId);
  rmSync(approved, { force: true });
  rmSync(pending, { force: true });
  return q.del.run(userId).changes;
}

// ─── Notifications ────────────────────────────────────────────────────────────
// Plain REST so both the bot and the dashboard process can send them.
const API = () => (process.env.FLUXER_API || 'https://api.fluxer.app').replace(/\/+$/, '');
async function rest(method, path, body) {
  const res = await fetch(`${API()}${path}`, {
    method,
    headers: { Authorization: `Bot ${process.env.FLUXER_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Fluxer answered ${res.status}`);
  return res.status === 204 ? null : res.json();
}
async function notifyUser(userId, content) {
  try {
    const dm = await rest('POST', '/users/@me/channels', { recipient_id: userId });
    if (dm?.id) await rest('POST', `/channels/${dm.id}/messages`, { content, allowed_mentions: { parse: [] } });
  } catch (err) {
    logger.debug(`[CARD] Couldn't DM ${userId}: ${err.message}`);
  }
}
async function notifyOwners(content) {
  const owners = (process.env.BOT_OWNERS ?? '').split(',').map(s => s.trim()).filter(isId);
  for (const id of owners) await notifyUser(id, content);
}
