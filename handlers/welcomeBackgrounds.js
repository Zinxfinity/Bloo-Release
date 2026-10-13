// ─── Welcome card backgrounds ─────────────────────────────────────────────────
// A server's welcome card can use the theme's own background, the server's
// banner (or icon) from Fluxer, or an image the server owner uploads.
//
// Uploads: server owners only (checked by the caller: b!welcome card, the
// dashboard). One image per server, cropped to the card and stored as JPEG in
// data/welcome-backgrounds/; a new upload replaces the old one. Deleted when
// Bloo leaves the server. Bot owners can switch uploads off everywhere and
// remove any server's image (dashboard: Developer → Card Backgrounds).
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { CardError, fetchImage, processImage, LIMITS } from './cardBackgrounds.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WELCOME_BG_DIR = join(ROOT, 'data', 'welcome-backgrounds');
mkdirSync(WELCOME_BG_DIR, { recursive: true });

// The card is 900x320; stored at 2x so it stays sharp.
export const WELCOME_SHAPE = { outW: 1800, outH: 640, minWidth: 600, minHeight: 200 };
export const BACKGROUND_MODES = ['theme', 'server', 'custom'];

// The welcome_config columns this uses (card_background, the three colours,
// card_upload_*) are created in handlers/welcomeSystem.js, which owns that table.
db.exec(`CREATE TABLE IF NOT EXISTS card_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

const isId = id => /^\d{15,22}$/.test(String(id ?? ''));
export function welcomeBgPath(guildId) {
  if (!isId(guildId)) throw new CardError('Invalid server ID.');
  return join(WELCOME_BG_DIR, `${guildId}.jpg`);
}

// ── Bot-owner switch (on unless turned off) ──────────────────────────────────
export function welcomeUploadsEnabled() {
  return db.prepare(`SELECT value FROM card_settings WHERE key = 'welcome_uploads_enabled'`).get()?.value !== '0';
}
export function setWelcomeUploadsEnabled(on) {
  db.prepare(`INSERT INTO card_settings (key, value) VALUES ('welcome_uploads_enabled', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(on ? '1' : '0');
  return welcomeUploadsEnabled();
}

// ── Saving ───────────────────────────────────────────────────────────────────
// source: a Fluxer attachment ({ url, size }) or an image Buffer (dashboard).
export async function saveWelcomeUpload(guildId, source, { by = null, guildName = null } = {}) {
  if (!welcomeUploadsEnabled()) throw new CardError('Custom welcome card images are switched off right now. The theme and server banner backgrounds still work.');
  const path = welcomeBgPath(guildId);
  let raw;
  if (Buffer.isBuffer(source)) {
    if (source.length > LIMITS.maxBytes) throw new CardError(`That image is over ${LIMITS.maxBytes / 1024 / 1024} MB. Please upload a smaller one.`);
    raw = source;
  } else {
    if (!source?.url) throw new CardError('Attach an image to your message.');
    if (source.size && source.size > LIMITS.maxBytes) throw new CardError(`That image is over ${LIMITS.maxBytes / 1024 / 1024} MB. Please upload a smaller one.`);
    raw = await fetchImage(source.url);
  }
  const jpeg = await processImage(raw, WELCOME_SHAPE);
  writeFileSync(path, jpeg); // replaces the old one
  db.prepare(`INSERT OR IGNORE INTO welcome_config (guild_id) VALUES (?)`).run(guildId);
  db.prepare(`UPDATE welcome_config SET card_background = 'custom', card_upload_by = ?, card_upload_at = unixepoch(), card_upload_guild_name = ? WHERE guild_id = ?`)
    .run(by, guildName, guildId);
  return { bytes: jpeg.length };
}

// Removes a server's image. The card goes back to the theme background.
export function removeWelcomeUpload(guildId) {
  const path = welcomeBgPath(guildId);
  const had = existsSync(path);
  rmSync(path, { force: true });
  try {
    db.prepare(`UPDATE welcome_config SET card_background = 'theme', card_upload_by = NULL, card_upload_at = NULL WHERE guild_id = ? AND card_background = 'custom'`).run(guildId);
  } catch { /* welcome_config not created yet */ }
  return had;
}

// Every stored image, for the bot owner's review list.
export function listWelcomeUploads() {
  return readdirSync(WELCOME_BG_DIR).filter(f => /^\d{15,22}\.jpg$/.test(f)).map(f => {
    const guildId = f.slice(0, -4);
    const row = db.prepare(`SELECT card_background, card_upload_by, card_upload_at, card_upload_guild_name FROM welcome_config WHERE guild_id = ?`).get(guildId) ?? {};
    return { guildId, guildName: row.card_upload_guild_name ?? null, by: row.card_upload_by ?? null, at: row.card_upload_at ?? null, inUse: row.card_background === 'custom', bytes: statSync(join(WELCOME_BG_DIR, f)).size };
  }).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

// ── Server banner / icon, cached on disk ─────────────────────────────────────
// The "server" background is made once and kept as a card-sized JPEG
// (1800x640, the same as uploads), named after the banner or icon's ID from
// Fluxer. That ID changes when the owner changes their banner or icon, so a
// new one is fetched by itself and the old file deleted. One file per server
// at most; removed when the server stops using it or Bloo leaves.
const CDN = 'https://fluxerusercontent.com';
const serverFile = (guildId, key) => join(WELCOME_BG_DIR, `server-${guildId}-${key}.jpg`);
const serverFilesOf = guildId => readdirSync(WELCOME_BG_DIR).filter(f => f.startsWith(`server-${guildId}-`));

// A banner is cropped like an upload; smaller ones are allowed, since it's
// the server's real banner rather than something chosen for the card.
const BANNER_SHAPE = { ...WELCOME_SHAPE, minWidth: 300, minHeight: 100 };

// A small square icon becomes a soft, card-sized colour wash: cropped to the
// card's shape, shrunk right down, then enlarged in two steps.
async function blurredWash(buffer) {
  const { createCanvas, loadImage } = await import('canvas');
  const img = await loadImage(buffer);
  const { outW, outH } = WELCOME_SHAPE;
  const TW = 36, TH = 13;
  const tiny = createCanvas(TW, TH), tc = tiny.getContext('2d');
  const s = Math.max(TW / img.width, TH / img.height);
  tc.drawImage(img, (TW - img.width * s) / 2, (TH - img.height * s) / 2, img.width * s, img.height * s);
  const mid = createCanvas(TW * 8, TH * 8), mc = mid.getContext('2d');
  mc.imageSmoothingQuality = 'high';
  mc.drawImage(tiny, 0, 0, TW * 8, TH * 8);
  const out = createCanvas(outW, outH), oc = out.getContext('2d');
  oc.fillStyle = '#0b0f0d'; oc.fillRect(0, 0, outW, outH); // transparent icons get a dark base
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(mid, 0, 0, outW, outH);
  return out.toBuffer('image/jpeg', { quality: 0.84 });
}

// The first address that answers (PNG, then JPEG).
async function download(kind, guildId, hash, size) {
  for (const ext of ['png', 'jpg']) {
    // animated=false: an animated banner/icon comes back as an animated PNG
    // otherwise, which can't be drawn.
    try { return await fetchImage(`${CDN}/${kind}/${guildId}/${hash}.${ext}?size=${size}&animated=false`); } catch { /* next */ }
  }
  return null;
}

const inFlight = new Map(); // guildId -> Promise, so two joins at once fetch once
export async function serverBackground(guild) {
  if (!isId(guild?.id)) return null;
  const banner = guild.banner ?? null, icon = guild.icon ?? null;
  const wanted = [banner && `banner-${banner}`, icon && `icon-${icon}`].filter(Boolean);
  // Already made for the current banner or icon?
  for (const key of wanted) {
    const path = serverFile(guild.id, key);
    if (existsSync(path)) return { src: path, blur: false };
  }
  if (!wanted.length) return null;
  if (inFlight.has(guild.id)) return inFlight.get(guild.id);
  const job = (async () => {
    let key = null, jpeg = null;
    if (banner) {
      const raw = await download('banners', guild.id, banner, 1024);
      if (raw) { try { jpeg = await processImage(raw, BANNER_SHAPE); key = `banner-${banner}`; } catch { /* unusable, try the icon */ } }
    }
    if (!jpeg && icon) {
      const raw = await download('icons', guild.id, icon, 256);
      if (raw) { try { jpeg = await blurredWash(raw); key = `icon-${icon}`; } catch { /* unusable */ } }
    }
    if (!jpeg) return null;
    for (const f of serverFilesOf(guild.id)) rmSync(join(WELCOME_BG_DIR, f), { force: true }); // the old banner/icon
    const path = serverFile(guild.id, key);
    writeFileSync(path, jpeg);
    return { src: path, blur: false };
  })().finally(() => inFlight.delete(guild.id));
  inFlight.set(guild.id, job);
  return job;
}

// Drops a server's cached banner/icon (it switched background, or Bloo left).
export function removeServerCache(guildId) {
  if (!isId(guildId)) return 0;
  const files = serverFilesOf(guildId);
  for (const f of files) rmSync(join(WELCOME_BG_DIR, f), { force: true });
  return files.length;
}

// ── Which background a card should use ──────────────────────────────────────
// guild: needs id, plus icon/banner hashes when the server background is wanted.
export async function backgroundFor(guild, config) {
  const mode = config?.card_background;
  if (mode === 'custom') {
    const path = welcomeBgPath(guild.id);
    if (welcomeUploadsEnabled() && existsSync(path)) return { src: path, blur: false };
    return null;
  }
  // The theme shows when there's no banner or icon, or neither could be used.
  if (mode === 'server') return serverBackground(guild);
  return null;
}

export const cardColors = config => ({
  accent: config?.card_accent || null,
  title: config?.card_title_color || null,
  subtitle: config?.card_subtitle_color || null,
});
