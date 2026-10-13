import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

// ─── Fonts ────────────────────────────────────────────────────────────────────
// Theme fonts are bundled in assets/fonts (all SIL Open Font License, see
// OFL.txt there) so every card looks the same on any machine. Wide Unicode
// coverage (Korean, Chinese, Hindi, ...) comes from the system's Noto fonts:
// on Ubuntu, `apt install fonts-noto-core fonts-noto-cjk`. For local previews,
// any font dropped in assets/fonts/fallback/ is loaded too (that folder isn't
// committed; the CJK files are large).
const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
const BUNDLED_FONTS = [
  ['Noto Sans', 'NotoSans-Regular.ttf', 'normal'], ['Noto Sans', 'NotoSans-Bold.ttf', 'bold'],
  ['Poppins', 'Poppins-Regular.ttf', 'normal'], ['Poppins', 'Poppins-SemiBold.ttf', '600'], ['Poppins', 'Poppins-Bold.ttf', 'bold'],
  ['Cinzel Decorative', 'CinzelDecorative-Regular.ttf', 'normal'], ['Cinzel Decorative', 'CinzelDecorative-Bold.ttf', 'bold'],
  ['Almendra', 'Almendra-Regular.ttf', 'normal'], ['Almendra', 'Almendra-Bold.ttf', 'bold'],
  ['Uncial Antiqua', 'UncialAntiqua-Regular.ttf', 'normal'],
  ['Press Start 2P', 'PressStart2P-Regular.ttf', 'normal'],
  ['Audiowide', 'Audiowide-Regular.ttf', 'normal'],
];
// Family names for the optional local fallback files, keyed by file name
// without "-Regular"/"-Bold". They must be static fonts: node-canvas can't
// use variable ones ("Font[wght].ttf") and silently falls back to boxes.
const FALLBACK_FAMILIES = {
  NotoSansKR: 'Noto Sans KR', NotoSansSC: 'Noto Sans SC', NotoSansJP: 'Noto Sans JP',
  NotoSansDevanagari: 'Noto Sans Devanagari', NotoSansArabic: 'Noto Sans Arabic', NotoSansThai: 'Noto Sans Thai',
};
const FALLBACK = '"Noto Sans", "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", "Noto Sans CJK JP", "Noto Sans Arabic", "Noto Sans Devanagari", "Noto Sans Thai", "Noto Sans Hebrew", "DejaVu Sans", sans-serif';
const font = ([family, weight = 'normal'], size) => `${weight} ${size}px ${family ? `"${family}", ` : ''}${FALLBACK}`;

// Which characters a theme's display font really has. Text with anything
// else (another script, or Vietnamese letters in a fantasy font) is drawn
// entirely in Noto instead of letter by letter, which mixed styles and, in
// the pixel font, dropped letters like the "ặ" in "Đặng". Emoji and custom
// emoji tags don't count, since they're drawn as images.
const LATIN_FULL  = /^[\u0000-\u024F\u1E00-\u1EFF\u2000-\u206F\u20A0-\u20CF\s]*$/u; // incl. Vietnamese
const LATIN_BASIC = /^[\u0000-\u024F\u2000-\u206F\u20A0-\u20CF\s]*$/u;
const LATIN_PIXEL = /^[\u0000-\u017F\u2000-\u206F\s]*$/u;
const EMOJI_ALL = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u200D\uFE0F\u20E3]|[\u{E0020}-\u{E007F}]|<a?:\w+:\d+>/gu;

// Font and size for a role (name, level, small) given the text it'll draw.
function roleFont(t, role, text, size) {
  const plain = String(text ?? '').replace(EMOJI_ALL, '');
  if ((t.covers ?? LATIN_FULL).test(plain)) return { font: font(t.fonts[role], size), size };
  const scaled = Math.round(size * (t.fallbackScale ?? 1));
  const weight = (t.fonts[role][1] ?? 'normal') === 'normal' ? 'normal' : 'bold';
  return { font: font(['Noto Sans', weight], scaled), size: scaled };
}

let _canvas = null;

async function getCanvas() {
  if (_canvas) return _canvas;
  try {
    _canvas = await import('canvas');
  } catch {
    return null;
  }
  const register = (file, family, weight = 'normal') => {
    try { _canvas.registerFont(file, { family, weight }); return true; } catch { return false; }
  };
  let bundled = 0;
  for (const [family, file, weight] of BUNDLED_FONTS) {
    const path = join(FONT_DIR, file);
    if (existsSync(path) && register(path, family, weight)) bundled++;
  }
  const fallbackDir = join(FONT_DIR, 'fallback');
  if (existsSync(fallbackDir)) {
    for (const file of readdirSync(fallbackDir).filter(f => /\.(ttf|otf)$/i.test(f))) {
      const [, base, style] = file.match(/^(.+?)(?:-(Regular|Bold))?\.(?:ttf|otf)$/i);
      register(join(fallbackDir, file), FALLBACK_FAMILIES[base] ?? base, /bold/i.test(style ?? '') ? 'bold' : 'normal');
    }
  }
  if (!bundled) {
    // No bundled fonts (an old checkout): use what the system has.
    register('/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf', 'Noto Sans')
      || register('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'DejaVu Sans');
  }
  return _canvas;
}

// ─── Emoji ────────────────────────────────────────────────────────────────────
// The card's fonts have no emoji, so they came out as boxes ("1F375"). Emoji
// are drawn as Twemoji images instead, cached in memory; one that can't be
// fetched is left out rather than drawn as a box. Custom Fluxer emoji tags
// (<:name:id>) are dropped, since only their image would make sense here.
const TWEMOJI = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@16.0.1/assets/72x72/'; // Emoji 16.0
// One emoji: a keycap (like 1 in a box), a flag pair, a tag-sequence flag
// (England, Scotland, Wales), or a pictograph with its variation selector,
// skin tone and any zero-width joins (families, professions with a tone).
const EMOJI_RE = /([0-9#*]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|\p{Extended_Pictographic}[\u{E0020}-\u{E007E}]+\u{E007F}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)/u;
const emojiCache = new Map();

function twemojiUrl(emoji) {
  const points = [...emoji].map(c => c.codePointAt(0).toString(16));
  // Twemoji file names drop FE0F except inside ZWJ sequences.
  const name = (emoji.includes('\u200D') ? points : points.filter(p => p !== 'fe0f')).join('-');
  return `${TWEMOJI}${name}.png`;
}

async function emojiImage(loadImage, emoji) {
  if (!emojiCache.has(emoji)) emojiCache.set(emoji, loadImage(twemojiUrl(emoji)).catch(() => null));
  return emojiCache.get(emoji);
}

// Splits text into plain runs and emoji, loading each emoji's image once.
async function textParts(loadImage, text) {
  const clean = String(text ?? '').replace(/<a?:\w+:\d+>/g, '').replace(/\s{2,}/g, ' ').trim();
  const parts = [];
  for (const piece of clean.split(EMOJI_RE)) {
    if (!piece) continue;
    if (EMOJI_RE.test(piece)) {
      const img = await emojiImage(loadImage, piece);
      if (img) parts.push({ img });
    } else {
      // Split between double O's, so each is drawn on its own: Cinzel
      // Decorative (the Arcane Tome theme) otherwise joins "OO" into one
      // ornament, and "Bloo" drew as "BLꝏ". (A zero-width non-joiner
      // didn't stop it.) Looks the same in every other font.
      for (const run of piece.split(/(?<=[Oo])(?=[Oo])/)) if (run) parts.push({ text: run });
    }
  }
  return parts;
}

const partWidth = (ctx, p, size) => p.img ? size * 1.15 : ctx.measureText(p.text).width;
const partsWidth = (ctx, parts, size) => parts.reduce((w, p) => w + partWidth(ctx, p, size), 0);

// Draws text with inline emoji, cut with an ellipsis if it's wider than maxW.
// Returns the width it drew.
function drawParts(ctx, parts, x, y, size, maxW) {
  let used = 0;
  for (const p of parts) {
    const w = partWidth(ctx, p, size);
    if (used + w > maxW) {
      if (p.text) {
        let t = p.text;
        while (t && used + ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
        ctx.fillText(t.trimEnd() + '…', x + used, y);
        used += ctx.measureText(t.trimEnd() + '…').width;
      }
      return used;
    }
    if (p.img) ctx.drawImage(p.img, x + used + size * 0.05, y - size * 0.86, size, size);
    else ctx.fillText(p.text, x + used, y);
    used += w;
  }
  return used;
}

// Names made of unassigned or invisible characters (a common way to look
// nameless) have no glyph in any font and came out as boxes or a dash.
// Unassigned, private-use and control characters are removed. Format
// characters stay: emoji need them (the joiners in family and profession
// emoji, the tags that make the England flag). A name with nothing visible
// left uses the fallback.
// Fluxer serves an animated avatar, icon or banner as an animated PNG when
// asked for .png, which the canvas library can't read (it drew as coloured
// stripes). animated=false gets the still image. Only for drawing: chat
// embeds can keep the animated one.
export function stillImageUrl(url) {
  if (!url || !/^https:\/\/fluxerusercontent\.com\//.test(url)) return url;
  try {
    const u = new URL(url.replace(/\.(webp|jpg|gif)(?=\?|$)/, '.png'));
    u.searchParams.set('animated', 'false');
    return u.toString();
  } catch { return url; }
}

function visibleName(name, fallback) {
  const clean = v => String(v ?? '').replace(/[\p{Cn}\p{Co}\p{Cc}]/gu, '').trim();
  const visible = v => /[^\p{Cf}\s]/u.test(v);
  const n = clean(name), f = clean(fallback);
  return visible(n) ? n : visible(f) ? f : 'Member';
}

// ─── Drawing helpers ──────────────────────────────────────────────────────────
// Every shape starts a fresh path. Without beginPath() each roundRect added to
// the shapes before it, so a later fill repainted everything drawn earlier (the
// old card's "missing" avatar and always-full bar).
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (!r) { ctx.rect(x, y, w, h); return; }
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A rectangle with its corners cut off, for plaques and frames.
function notchedPath(ctx, x, y, w, h, n) {
  ctx.beginPath();
  ctx.moveTo(x + n, y); ctx.lineTo(x + w - n, y); ctx.lineTo(x + w, y + n);
  ctx.lineTo(x + w, y + h - n); ctx.lineTo(x + w - n, y + h); ctx.lineTo(x + n, y + h);
  ctx.lineTo(x, y + h - n); ctx.lineTo(x, y + n); ctx.closePath();
}

// Seeded random numbers, so a theme's embers, stars and speckles are the same
// on every card instead of changing each time.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withGlow(ctx, color, blur, fn) {
  if (!color) return fn();
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  fn();
  ctx.restore();
}

function glowDot(ctx, x, y, r, color, alpha) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color.replace('ALPHA', alpha));
  g.addColorStop(1, color.replace('ALPHA', 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// ─── Themes ───────────────────────────────────────────────────────────────────
// Every theme shares the same layout (avatar left, name and level name, Rank
// and Level badges top right, XP figures over the bar) and supplies its own
// fonts, colours and drawing for the background, frame, avatar ring, badges
// and bar. A theme's font list is [family, weight]; FALLBACK covers anything
// the family can't draw.
// W and H are the rank card's size. Welcome cards borrow the theme
// backgrounds at their own size by swapping these for the (synchronous)
// background call only; see renderWelcomeCard.
let W = 760, H = 200;
const PAD = 28;

const barRound = (ctx, x, y, w, h, p, t) => {
  roundRectPath(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = t.colors.track;
  ctx.fill();
  if (t.colors.trackLine) { ctx.strokeStyle = t.colors.trackLine; ctx.lineWidth = 1.5; ctx.stroke(); }
  if (p <= 0) return;
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  t.colors.bar.forEach((c, i, all) => g.addColorStop(all.length === 1 ? 0 : i / (all.length - 1), c));
  withGlow(ctx, t.glow?.bar, 14, () => {
    roundRectPath(ctx, x, y, Math.max(h, p * w), h, h / 2);
    ctx.fillStyle = g;
    ctx.fill();
  });
};

const ringSimple = (ctx, cx, cy, r, t) => {
  withGlow(ctx, t.glow?.ring, 16, () => {
    ctx.beginPath();
    ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
    ctx.fillStyle = t.colors.ring;
    ctx.fill();
  });
  ctx.beginPath();
  ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
  ctx.fillStyle = t.colors.avatarBg;
  ctx.fill();
};

const THEMES = {
  // ── Bloo: the original green card ──────────────────────────────────────────
  bloo: {
    label: 'Bloo',
    fonts: { name: ['Noto Sans', 'bold'], level: ['Noto Sans', 'bold'], small: ['Noto Sans'], badge: ['Noto Sans', 'bold'] },
    colors: { text: '#e7fbef', muted: '#8fae98', accent: '#4ade80', track: '#223328', bar: ['#22c55e', '#4ade80'],
      ring: '#4ade80', avatarBg: '#0f1611', badgeBg: 'rgba(74, 222, 128, 0.12)', badgeLabel: '#8fae98', badgeValue: '#4ade80' },
    background(ctx) {
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#17241b'); bg.addColorStop(1, '#0f1611');
      roundRectPath(ctx, 0, 0, W, H, 18);
      ctx.fillStyle = bg; ctx.fill();
      roundRectPath(ctx, 0.5, 0.5, W - 1, H - 1, 18);
      ctx.strokeStyle = 'rgba(74, 222, 128, 0.28)'; ctx.lineWidth = 1; ctx.stroke();
    },
    ring: ringSimple, bar: barRound,
  },

  // ── Aurora Glass: modern, frosted glass over soft aurora light ─────────────
  aurora: {
    label: 'Aurora Glass',
    fonts: { name: ['Poppins', 'bold'], level: ['Poppins', '600'], small: ['Poppins'], badge: ['Poppins', '600'] },
    colors: { text: '#ffffff', muted: 'rgba(255, 255, 255, 0.68)', accent: '#a5f3fc', track: 'rgba(255, 255, 255, 0.14)',
      bar: ['#2dd4bf', '#818cf8', '#f472b6'], ring: 'rgba(255, 255, 255, 0.85)', avatarBg: '#141a33',
      badgeBg: 'rgba(255, 255, 255, 0.12)', badgeLabel: 'rgba(255, 255, 255, 0.7)', badgeValue: '#ffffff', badgeLine: 'rgba(255, 255, 255, 0.25)' },
    background(ctx) {
      roundRectPath(ctx, 0, 0, W, H, 22);
      ctx.save(); ctx.clip();
      ctx.fillStyle = '#0b1026'; ctx.fillRect(0, 0, W, H);
      glowDot(ctx, 140, 20, 260, 'rgba(124, 58, 237, ALPHA)', 0.75);
      glowDot(ctx, 520, 210, 280, 'rgba(20, 184, 166, ALPHA)', 0.6);
      glowDot(ctx, 740, 10, 220, 'rgba(236, 72, 153, ALPHA)', 0.55);
      // Frosted panel.
      roundRectPath(ctx, 10, 10, W - 20, H - 20, 16);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.07)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
    },
    ring(ctx, cx, cy, r, t) {
      const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      g.addColorStop(0, '#2dd4bf'); g.addColorStop(0.5, '#818cf8'); g.addColorStop(1, '#f472b6');
      ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, r + 1, 0, Math.PI * 2); ctx.fillStyle = t.colors.avatarBg; ctx.fill();
    },
    bar: barRound,
  },

  // ── Clean Light: modern, white and minimal ─────────────────────────────────
  light: {
    label: 'Clean Light',
    light: true,
    fonts: { name: ['Poppins', 'bold'], level: ['Poppins', '600'], small: ['Poppins'], badge: ['Poppins', '600'] },
    colors: { text: '#0f172a', muted: '#64748b', accent: '#2563eb', track: '#e8eef6', bar: ['#3b82f6', '#2563eb'],
      ring: '#e2e8f0', avatarBg: '#f1f5f9', badgeBg: '#f1f5f9', badgeLabel: '#64748b', badgeValue: '#0f172a', letter: '#2563eb' },
    background(ctx) {
      roundRectPath(ctx, 0, 0, W, H, 20);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.save(); ctx.clip();
      glowDot(ctx, W - 40, -30, 200, 'rgba(37, 99, 235, ALPHA)', 0.08);
      ctx.restore();
      roundRectPath(ctx, 0.5, 0.5, W - 1, H - 1, 20);
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1; ctx.stroke();
    },
    ring: ringSimple, bar: barRound,
  },

  // ── Neon Arcade: retro-futurist glow over a synthwave grid ─────────────────
  neon: {
    label: 'Neon Arcade',
    covers: LATIN_BASIC,
    fonts: { name: ['Audiowide'], level: ['Audiowide'], small: ['Noto Sans'], badge: ['Audiowide'] },
    colors: { text: '#fdf4ff', muted: '#c4b5fd', accent: '#22d3ee', track: '#150b2e', trackLine: '#22d3ee',
      bar: ['#f0abfc', '#e879f9', '#22d3ee'], ring: '#22d3ee', avatarBg: '#0b0518',
      badgeBg: 'rgba(34, 211, 238, 0.08)', badgeLabel: '#e879f9', badgeValue: '#22d3ee', badgeLine: '#22d3ee', level: '#e879f9' },
    glow: { name: '#e879f9', level: '#e879f9', accent: '#22d3ee', bar: '#e879f9', ring: '#22d3ee', badge: '#22d3ee' },
    background(ctx) {
      roundRectPath(ctx, 0, 0, W, H, 14);
      ctx.save(); ctx.clip();
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#12052b'); bg.addColorStop(0.62, '#2a0b3d'); bg.addColorStop(1, '#07030f');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      // Horizon and a perspective grid below it.
      const HY = 118;
      glowDot(ctx, W / 2, HY, 330, 'rgba(232, 121, 249, ALPHA)', 0.25);
      ctx.strokeStyle = 'rgba(232, 121, 249, 0.28)'; ctx.lineWidth = 1;
      for (let i = 1; i <= 7; i++) {
        const y = HY + Math.pow(i / 7, 1.8) * (H - HY);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      for (let i = -14; i <= 14; i++) {
        ctx.beginPath(); ctx.moveTo(W / 2 + i * 18, HY); ctx.lineTo(W / 2 + i * 120, H); ctx.stroke();
      }
      const rnd = seededRandom(7);
      for (let i = 0; i < 40; i++) glowDot(ctx, rnd() * W, rnd() * (HY - 20), 1.6, 'rgba(255, 255, 255, ALPHA)', 0.3 + rnd() * 0.6);
      ctx.restore();
      withGlow(ctx, '#e879f9', 18, () => {
        roundRectPath(ctx, 2, 2, W - 4, H - 4, 12);
        ctx.strokeStyle = '#e879f9'; ctx.lineWidth = 2; ctx.stroke();
      });
    },
    ring: ringSimple,
    bar: barRound,
  },

  // ── Pixel Quest: retro 8-bit ───────────────────────────────────────────────
  pixel: {
    label: 'Pixel Quest',
    fonts: { name: ['Press Start 2P'], level: ['Press Start 2P'], small: ['Press Start 2P'], badge: ['Press Start 2P'] },
    sizes: { name: 20, level: 12, small: 10, badgeLabel: 8, badgeValue: 12, letter: 44 },
    badgeShape: 'pixel', avatarShape: 'square', pixelate: 32,
    covers: LATIN_PIXEL, fallbackScale: 1.3,
    colors: { text: '#fff1e8', muted: '#c2c3c7', accent: '#ffec27', track: '#000000', bar: ['#00e436'],
      ring: '#ffec27', avatarBg: '#1d2b53', badgeBg: '#000000', badgeLabel: '#ff77a8', badgeValue: '#ffec27', badgeLine: '#fff1e8', level: '#29adff' },
    background(ctx) {
      ctx.fillStyle = '#1d2b53'; ctx.fillRect(0, 0, W, H);
      const rnd = seededRandom(3);
      ctx.fillStyle = '#29366f';
      for (let y = 0; y < H; y += 8) for (let x = (y / 8) % 2 ? 4 : 0; x < W; x += 8) if (rnd() < 0.35) ctx.fillRect(x, y, 4, 4);
      // Stepped pixel border.
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, 8); ctx.fillRect(0, H - 8, W, 8); ctx.fillRect(0, 0, 8, H); ctx.fillRect(W - 8, 0, 8, H);
      ctx.fillStyle = '#fff1e8';
      ctx.fillRect(8, 8, W - 16, 4); ctx.fillRect(8, H - 12, W - 16, 4); ctx.fillRect(8, 8, 4, H - 16); ctx.fillRect(W - 12, 8, 4, H - 16);
    },
    ring(ctx, cx, cy, r, t) {
      const s = r * 2;
      ctx.fillStyle = '#000000'; ctx.fillRect(cx - r - 8, cy - r - 8, s + 16, s + 16);
      ctx.fillStyle = t.colors.ring; ctx.fillRect(cx - r - 4, cy - r - 4, s + 8, s + 8);
      ctx.fillStyle = t.colors.avatarBg; ctx.fillRect(cx - r, cy - r, s, s);
    },
    // Chunky segments instead of a smooth bar.
    bar(ctx, x, y, w, h, p, t) {
      ctx.fillStyle = '#fff1e8'; ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
      ctx.fillStyle = t.colors.track; ctx.fillRect(x, y, w, h);
      const n = 24, gap = 3, seg = (w - gap * (n + 1)) / n, lit = Math.round(p * n);
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = i < lit ? (i === lit - 1 ? '#a8ff60' : t.colors.bar[0]) : '#1d2b53';
        ctx.fillRect(Math.round(x + gap + i * (seg + gap)), y + gap, Math.floor(seg), h - gap * 2);
      }
    },
  },

  // ── Arcane Tome: fantasy parchment and ink ─────────────────────────────────
  tome: {
    label: 'Arcane Tome',
    light: true,
    covers: LATIN_BASIC,
    fonts: { name: ['Cinzel Decorative', 'bold'], level: ['Almendra', 'bold'], small: ['Almendra'], badge: ['Almendra', 'bold'] },
    sizes: { name: 28, level: 20, small: 16 },
    badgeShape: 'plaque',
    colors: { text: '#3b2412', muted: '#6b4a2b', accent: '#8b2c1a', track: 'rgba(59, 36, 18, 0.14)', trackLine: '#8a6a3a',
      bar: ['#7a2415', '#a8391f', '#c2542c'], ring: '#b08a3e', avatarBg: '#e9d3a4',
      badgeBg: 'rgba(139, 44, 26, 0.08)', badgeLabel: '#6b4a2b', badgeValue: '#8b2c1a', badgeLine: '#8a6a3a', letter: '#8b2c1a' },
    background(ctx) {
      roundRectPath(ctx, 0, 0, W, H, 10);
      ctx.save(); ctx.clip();
      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#f4e4c1'); bg.addColorStop(1, '#e3c894');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      const rnd = seededRandom(11);
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = `rgba(110, 72, 30, ${rnd() * 0.08})`;
        ctx.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2);
      }
      const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, W * 0.62);
      v.addColorStop(0, 'rgba(90, 55, 20, 0)'); v.addColorStop(1, 'rgba(90, 55, 20, 0.38)');
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
      ctx.restore();
      // Double gilt frame with corner flourishes.
      ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = 2;
      notchedPath(ctx, 7, 7, W - 14, H - 14, 12); ctx.stroke();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(138, 106, 58, 0.7)';
      notchedPath(ctx, 12, 12, W - 24, H - 24, 10); ctx.stroke();
      ctx.fillStyle = '#8a6a3a';
      for (const [x, y] of [[14, 14], [W - 14, 14], [14, H - 14], [W - 14, H - 14]]) {
        ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.fill();
      }
    },
    ring(ctx, cx, cy, r, t) {
      ctx.beginPath(); ctx.arc(cx, cy, r + 7, 0, Math.PI * 2); ctx.fillStyle = '#8a6a3a'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0, Math.PI * 2); ctx.fillStyle = '#d9b865'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, r + 2, 0, Math.PI * 2); ctx.fillStyle = '#8a6a3a'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, r + 1, 0, Math.PI * 2); ctx.fillStyle = t.colors.avatarBg; ctx.fill();
    },
    bar: barRound,
  },

  // ── Dragon's Hoard: fantasy crimson, gold and embers ───────────────────────
  dragon: {
    label: "Dragon's Hoard",
    covers: LATIN_BASIC,
    fonts: { name: ['Almendra', 'bold'], level: ['Almendra', 'bold'], small: ['Almendra'], badge: ['Almendra', 'bold'] },
    sizes: { name: 32, level: 20, small: 16 },
    badgeShape: 'plaque',
    colors: { text: '#f8e9c4', muted: '#cfae7c', accent: '#f0b84a', track: '#2a0c0c', trackLine: '#c9a24a',
      bar: ['#e0301e', '#ff7a1a', '#ffc94a'], ring: '#c9a24a', avatarBg: '#1a0707',
      badgeBg: 'rgba(20, 5, 5, 0.6)', badgeLabel: '#cfae7c', badgeValue: '#f0b84a', badgeLine: '#c9a24a', letter: '#f0b84a' },
    glow: { bar: '#ff7a1a', ring: 'rgba(240, 184, 74, 0.7)', name: 'rgba(255, 120, 40, 0.45)' },
    background(ctx) {
      roundRectPath(ctx, 0, 0, W, H, 14);
      ctx.save(); ctx.clip();
      const bg = ctx.createRadialGradient(180, 110, 20, 300, 100, 620);
      bg.addColorStop(0, '#4a0e0c'); bg.addColorStop(0.5, '#230707'); bg.addColorStop(1, '#0c0304');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      // Scale pattern, faint.
      ctx.strokeStyle = 'rgba(201, 162, 74, 0.07)'; ctx.lineWidth = 1;
      for (let row = 0; row < 12; row++) for (let col = 0; col < 34; col++) {
        const x = col * 24 + (row % 2 ? 12 : 0), y = row * 18;
        ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI); ctx.stroke();
      }
      const rnd = seededRandom(23);
      for (let i = 0; i < 55; i++) {
        const x = rnd() * W, y = H - Math.pow(rnd(), 1.6) * H;
        glowDot(ctx, x, y, 2 + rnd() * 5, rnd() < 0.5 ? 'rgba(255, 140, 40, ALPHA)' : 'rgba(255, 210, 90, ALPHA)', 0.5 + rnd() * 0.5);
      }
      glowDot(ctx, W / 2, H + 40, 260, 'rgba(255, 90, 20, ALPHA)', 0.22);
      ctx.restore();
      ctx.strokeStyle = '#c9a24a'; ctx.lineWidth = 2;
      notchedPath(ctx, 6, 6, W - 12, H - 12, 14); ctx.stroke();
      ctx.strokeStyle = 'rgba(201, 162, 74, 0.35)'; ctx.lineWidth = 1;
      notchedPath(ctx, 11, 11, W - 22, H - 22, 11); ctx.stroke();
    },
    ring: ringSimple,
    bar: barRound,
  },

  // ── Elven Grove: fantasy forest light, vines and fireflies ─────────────────
  grove: {
    label: 'Elven Grove',
    covers: LATIN_BASIC,
    fonts: { name: ['Uncial Antiqua'], level: ['Uncial Antiqua'], small: ['Almendra'], badge: ['Uncial Antiqua'] },
    sizes: { name: 29, level: 18, small: 16 },
    colors: { text: '#eefae6', muted: '#a8cdb0', accent: '#c6f39a', track: '#0e3024', trackLine: '#5e9e73',
      bar: ['#3fbf7f', '#8fe38d', '#e2f7a8'], ring: '#c6f39a', avatarBg: '#0a221a',
      badgeBg: 'rgba(198, 243, 154, 0.09)', badgeLabel: '#a8cdb0', badgeValue: '#c6f39a', badgeLine: 'rgba(198, 243, 154, 0.35)' },
    glow: { bar: 'rgba(198, 243, 154, 0.6)', ring: 'rgba(198, 243, 154, 0.5)' },
    background(ctx) {
      roundRectPath(ctx, 0, 0, W, H, 20);
      ctx.save(); ctx.clip();
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#0f3a2c'); bg.addColorStop(1, '#06180f');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      // Light rays from the top.
      for (const [x0, w0, a] of [[210, 70, 0.07], [380, 50, 0.05], [560, 90, 0.06]]) {
        ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0 + w0, 0); ctx.lineTo(x0 + w0 + 140, H); ctx.lineTo(x0 + 60, H); ctx.closePath();
        ctx.fillStyle = `rgba(255, 244, 190, ${a})`; ctx.fill();
      }
      const rnd = seededRandom(5);
      for (let i = 0; i < 26; i++) glowDot(ctx, rnd() * W, rnd() * H, 3 + rnd() * 5, 'rgba(214, 255, 140, ALPHA)', 0.35 + rnd() * 0.5);
      // Vines along the bottom and top edges, with leaves.
      const vine = (y, dir) => {
        ctx.strokeStyle = 'rgba(94, 158, 115, 0.55)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, y);
        for (let x = 0; x <= W; x += 60) ctx.quadraticCurveTo(x + 30, y + dir * 14 * ((x / 60) % 2 ? 1 : -1), x + 60, y);
        ctx.stroke();
        ctx.fillStyle = 'rgba(111, 190, 130, 0.55)';
        for (let x = 20; x < W; x += 46) {
          ctx.save(); ctx.translate(x, y + dir * 6); ctx.rotate((x % 92 ? 0.7 : -0.7) * dir);
          ctx.beginPath(); ctx.ellipse(0, 0, 9, 4, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        }
      };
      vine(H - 8, -1); vine(8, 1);
      ctx.restore();
      roundRectPath(ctx, 0.5, 0.5, W - 1, H - 1, 20);
      ctx.strokeStyle = 'rgba(198, 243, 154, 0.3)'; ctx.lineWidth = 1; ctx.stroke();
    },
    ring: ringSimple,
    bar: barRound,
  },
  // ── Supporter: only for people who voted for Bloo on FluxerList ────────────
  supporter: {
    label: 'Supporter',
    voteOnly: true,
    fonts: { name: ['Poppins', 'bold'], level: ['Poppins', '600'], small: ['Poppins'], badge: ['Poppins', '600'] },
    colors: { text: '#f3f4ff', muted: '#b8c4d8', accent: '#a5a2f7', track: 'rgba(70, 65, 217, 0.18)', trackLine: 'rgba(139, 136, 240, 0.5)',
      bar: ['#4ade80', '#2dd4bf', '#6d69ec'], ring: '#8b88f0', avatarBg: '#0e1a2a', letter: '#4ade80',
      badgeBg: 'rgba(70, 65, 217, 0.18)', badgeLabel: '#b8c4d8', badgeValue: '#a5a2f7', badgeLine: 'rgba(139, 136, 240, 0.5)', level: '#4ade80' },
    glow: { ring: 'rgba(110, 106, 236, 0.6)', bar: 'rgba(45, 212, 191, 0.45)', name: 'rgba(139, 136, 240, 0.3)' },
    background(ctx) {
      roundRectPath(ctx, 0, 0, W, H, 20);
      ctx.save(); ctx.clip();
      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#0c2a1f'); bg.addColorStop(0.55, '#0d1a2e'); bg.addColorStop(1, '#13113a');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      glowDot(ctx, 120, 100, 220, 'rgba(74, 222, 128, ALPHA)', 0.3);
      glowDot(ctx, W - 80, -20, 260, 'rgba(70, 65, 217, ALPHA)', 0.45);
      // Small four-point sparkles, kept to the edges and around the avatar so
      // none lands on the text.
      const rnd = seededRandom(42);
      for (let i = 0; i < 70; i++) {
        const x = rnd() * W, y = rnd() * H, r = 1.5 + rnd() * 3.5;
        if (x > 172 && y > 14 && y < H - 14) continue;
        ctx.fillStyle = (i % 3 ? 'rgba(196, 194, 255, ' : 'rgba(134, 239, 172, ') + (0.25 + rnd() * 0.5) + ')';
        ctx.beginPath();
        ctx.moveTo(x, y - r * 2); ctx.lineTo(x + r * 0.5, y - r * 0.5); ctx.lineTo(x + r * 2, y); ctx.lineTo(x + r * 0.5, y + r * 0.5);
        ctx.lineTo(x, y + r * 2); ctx.lineTo(x - r * 0.5, y + r * 0.5); ctx.lineTo(x - r * 2, y); ctx.lineTo(x - r * 0.5, y - r * 0.5);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      roundRectPath(ctx, 1, 1, W - 2, H - 2, 20);
      const edge = ctx.createLinearGradient(0, 0, W, 0);
      edge.addColorStop(0, 'rgba(74, 222, 128, 0.7)'); edge.addColorStop(1, 'rgba(110, 106, 236, 0.9)');
      ctx.strokeStyle = edge; ctx.lineWidth = 2; ctx.stroke();
    },
    ring: ringSimple,
    bar: barRound,
  },
};

export const RANK_CARD_THEMES = Object.fromEntries(Object.entries(THEMES).map(([k, t]) => [k, t.label]));
export const DEFAULT_RANK_CARD_THEME = 'bloo';
// Themes only voters can use (handlers/votes.js decides who that is).
export const VOTE_ONLY_THEMES = new Set(Object.keys(THEMES).filter(k => THEMES[k].voteOnly));

// ─── Badges ───────────────────────────────────────────────────────────────────
function badge(ctx, t, label, value, rightX, y) {
  const s = { badgeLabel: 13, badgeValue: 20, ...t.sizes };
  ctx.font = font(t.fonts.badge, s.badgeLabel);
  const lw = ctx.measureText(label).width;
  ctx.font = font(t.fonts.badge, s.badgeValue);
  const vw = ctx.measureText(value).width;
  const h = 36, w = lw + vw + 36, x = rightX - w;
  const shape = t.badgeShape ?? 'pill';
  if (shape === 'pixel') {
    ctx.fillStyle = t.colors.badgeLine; ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
    ctx.fillStyle = t.colors.badgeBg; ctx.fillRect(x, y, w, h);
  } else {
    if (shape === 'plaque') notchedPath(ctx, x, y, w, h, 8); else roundRectPath(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = t.colors.badgeBg; ctx.fill();
    if (t.colors.badgeLine) {
      withGlow(ctx, t.glow?.badge, 10, () => { ctx.strokeStyle = t.colors.badgeLine; ctx.lineWidth = 1.2; ctx.stroke(); });
    }
  }
  const baseY = y + h / 2 + s.badgeValue * 0.36;
  ctx.fillStyle = t.colors.badgeLabel;
  ctx.font = font(t.fonts.badge, s.badgeLabel);
  ctx.fillText(label, x + 14, baseY - 1);
  ctx.fillStyle = t.colors.badgeValue;
  ctx.font = font(t.fonts.badge, s.badgeValue);
  withGlow(ctx, t.glow?.accent, 10, () => ctx.fillText(value, x + 22 + lw, baseY));
  return x;
}

// ─── Rank card ────────────────────────────────────────────────────────────────
/**
 * Render an XP rank card PNG buffer.
 * @param {{ username: string, avatarUrl: string|null, xp: number, level: number, levelName?: string|null, rank: number, xpForNextLevel: number, xpProgress: number, maxed?: boolean, nextLabel?: string|null, fallbackName?: string|null, theme?: string, background?: string|null, supporter?: boolean }} data
 * @returns {Promise<Buffer|null>}
 */
export async function renderRankCard(data) {
  const cv = await getCanvas();
  if (!cv) return null;

  const { createCanvas, loadImage } = cv;
  const { username, avatarUrl, xp, level, levelName, rank, xpForNextLevel, xpProgress, maxed, nextLabel } = data;
  const t = THEMES[data.theme] ?? THEMES[DEFAULT_RANK_CARD_THEME];
  const s = { name: 30, level: 19, small: 15, letter: 56, ...t.sizes };
  const c = t.colors;
  const nextParts = !maxed && nextLabel ? await textParts(loadImage, nextLabel) : null;
  const shownName = visibleName(username, data.fallbackName);

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  t.background(ctx);

  // An approved custom background (handlers/cardBackgrounds.js) replaces the
  // theme's, under a tint that keeps the text readable: stronger on the left
  // where the text sits. Read from disk every time, so a newly approved image
  // shows straight away.
  if (data.background) {
    const bgImg = await loadImage(data.background).catch(() => null);
    if (bgImg) {
      const r = t.avatarShape === 'square' ? 0 : 16;
      ctx.save();
      roundRectPath(ctx, 0, 0, W, H, r);
      ctx.clip();
      ctx.drawImage(bgImg, 0, 0, W, H);
      const base = t.light ? '250, 247, 240' : '8, 10, 14';
      const tint = ctx.createLinearGradient(0, 0, W, 0);
      tint.addColorStop(0, `rgba(${base}, ${t.light ? 0.82 : 0.72})`);
      tint.addColorStop(0.55, `rgba(${base}, ${t.light ? 0.7 : 0.55})`);
      tint.addColorStop(1, `rgba(${base}, ${t.light ? 0.5 : 0.3})`);
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      roundRectPath(ctx, 1, 1, W - 2, H - 2, r);
      ctx.strokeStyle = c.accent;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // Avatar in the theme's ring; the first letter of the name when there's none.
  const AV = 128, AX = PAD + 2, AY = (H - AV) / 2, CX = AX + AV / 2, CY = AY + AV / 2, R = AV / 2;
  t.ring(ctx, CX, CY, R - 4, t);

  // avatarImage: an already-loaded image, so a gallery of every theme only
  // downloads the avatar once.
  let img = data.avatarImage ?? null;
  if (!img && avatarUrl) {
    const pngUrl = stillImageUrl(avatarUrl);
    img = await loadImage(pngUrl).catch(() => loadImage(avatarUrl).catch(() => null));
    if (!img) logger.debug(`[CARD] Avatar didn't load: ${pngUrl}`);
  }
  const square = t.avatarShape === 'square';
  const ir = R - 6, ix = CX - ir, iy = CY - ir;
  ctx.save();
  if (square) roundRectPath(ctx, ix, iy, ir * 2, ir * 2, 0);
  else { ctx.beginPath(); ctx.arc(CX, CY, ir, 0, Math.PI * 2); }
  ctx.clip();
  if (img && t.pixelate) {
    // Downscale then blow up with smoothing off, for a pixel-art avatar.
    const small = createCanvas(t.pixelate, t.pixelate);
    small.getContext('2d').drawImage(img, 0, 0, t.pixelate, t.pixelate);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, ix, iy, ir * 2, ir * 2);
    ctx.imageSmoothingEnabled = true;
  } else if (img) {
    ctx.drawImage(img, ix, iy, ir * 2, ir * 2);
  } else {
    ctx.fillStyle = c.avatarBg;
    ctx.fillRect(ix, iy, ir * 2, ir * 2);
    const letter = [...shownName].find(ch => /\p{L}|\p{N}/u.test(ch))?.toUpperCase() ?? '?';
    ctx.fillStyle = c.letter ?? c.accent;
    ctx.font = roleFont(t, 'name', letter, s.letter).font;
    ctx.textAlign = 'center';
    ctx.fillText(letter, CX, CY + s.letter * 0.36);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  // Rank and level badges, top right.
  const TX = AX + AV + 28, RIGHT = W - PAD - 4, TOP = PAD - 2;
  const levelX = badge(ctx, t, 'LEVEL', String(level), RIGHT, TOP);
  const rankX  = badge(ctx, t, 'RANK', `#${rank}`, levelX - 10, TOP);

  // Small badges under Rank and Level, right to left: Supporter (voters on
  // FluxerList), then Contributor (credited for a bug report or a shipped idea).
  const pills = [data.supporter && '💚 SUPPORTER', data.contributor && '🏅 CONTRIBUTOR'].filter(Boolean);
  let pillX = RIGHT + 8;
  for (const label of pills) {
    const size = t.sizes?.badgeLabel ? t.sizes.badgeLabel + 2 : 13; // pixel text runs large
    ctx.font = font(t.fonts.badge, size);
    const parts = await textParts(loadImage, label);
    const w = partsWidth(ctx, parts, size) + 22, h = 24, x = pillX - 8 - w, y = TOP + 44;
    if (t.badgeShape === 'pixel') {
      ctx.fillStyle = c.badgeLine ?? c.accent; ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
      ctx.fillStyle = c.badgeBg; ctx.fillRect(x, y, w, h);
    } else {
      roundRectPath(ctx, x, y, w, h, h / 2);
      ctx.fillStyle = c.badgeBg; ctx.fill();
      if (c.badgeLine) { ctx.strokeStyle = c.badgeLine; ctx.lineWidth = 1; ctx.stroke(); }
    }
    ctx.fillStyle = c.badgeValue;
    drawParts(ctx, parts, x + 11, y + 12 + size * 0.38, size, w);
    pillX = x - (t.badgeShape === 'pixel' ? 4 : 0);
  }

  // Name, cut to fit beside the badges. Without a level name underneath, it
  // sits lower so there's no gap.
  ctx.fillStyle = c.text;
  const nf = roleFont(t, 'name', shownName, s.name);
  ctx.font = nf.font;
  const nameParts = await textParts(loadImage, shownName);
  withGlow(ctx, t.glow?.name, 12, () =>
    drawParts(ctx, nameParts, TX, levelName ? PAD + 32 : PAD + 52, nf.size, rankX - TX - 14));

  if (levelName) {
    ctx.fillStyle = c.level ?? c.accent;
    const lf = roleFont(t, 'level', levelName, s.level);
    ctx.font = lf.font;
    const lp = await textParts(loadImage, levelName);
    withGlow(ctx, t.glow?.level, 10, () => drawParts(ctx, lp, TX, PAD + 68, lf.size, (pills.length ? pillX - 14 : RIGHT) - TX));
  }

  // XP figures above the bar: amount on the left; percentage, and what's next,
  // on the right ("27% to 🫖 Tea Lover").
  const BAR_H = 22, BAR_Y = H - PAD - BAR_H - 2, BAR_W = RIGHT - TX;
  const TEXT_Y = BAR_Y - 11;
  const progress = maxed ? 1 : Math.max(0, Math.min(1, Number(xpProgress) || 0));
  ctx.font = font(t.fonts.small, s.small);
  ctx.fillStyle = c.muted;
  const xpText = maxed ? `${xp.toLocaleString()} XP · Max level` : `${xp.toLocaleString()} / ${xpForNextLevel.toLocaleString()} XP`;
  ctx.fillText(xpText, TX, TEXT_Y);

  const pct = `${Math.floor(progress * 100)}%`;
  const bold = [t.fonts.small[0], 'bold'];
  ctx.font = font(bold, s.small);
  const pctW = ctx.measureText(pct + (nextParts?.length ? ' ' : '')).width;
  ctx.font = font(t.fonts.small, s.small);
  const toW = nextParts?.length ? ctx.measureText('to ').width : 0;
  const maxNext = BAR_W / 2 - pctW - toW;
  const xf = roleFont(t, 'small', nextLabel, s.small);
  ctx.font = xf.font;
  const nextW = nextParts?.length ? Math.min(partsWidth(ctx, nextParts, xf.size), maxNext) : 0;
  let x = RIGHT - pctW - toW - nextW;
  ctx.font = font(bold, s.small);
  ctx.fillStyle = c.accent;
  withGlow(ctx, t.glow?.accent, 8, () => ctx.fillText(pct, x, TEXT_Y));
  if (nextParts?.length) {
    x += pctW;
    ctx.font = font(t.fonts.small, s.small);
    ctx.fillStyle = c.muted;
    ctx.fillText('to ', x, TEXT_Y);
    ctx.font = xf.font;
    drawParts(ctx, nextParts, x + toW, TEXT_Y, xf.size, maxNext);
  }

  t.bar(ctx, TX, BAR_Y, BAR_W, BAR_H, progress, t);

  return canvas.toBuffer('image/png');
}

// ─── Theme gallery ────────────────────────────────────────────────────────────
// Every theme side by side, each labelled with its name and the command to
// pick it. `data` is the same as renderRankCard's, minus theme and background
// (the gallery always shows the themes' own backgrounds).
// ─── Welcome cards ────────────────────────────────────────────────────────────
// The member's avatar in the middle with up to two lines of text under it,
// on one of the rank card themes. The server picks the theme; vote-only
// themes stay a perk for voters' own cards.
export const WELCOME_CARD_THEMES = Object.fromEntries(Object.entries(THEMES).filter(([, t]) => !t.voteOnly).map(([k, t]) => [k, t.label]));
const WC_W = 900, WC_H = 320;

const HEX = /^#[0-9a-f]{6}$/i;
const hexRgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; };

// A server's own colours over a theme: the accent recolours the avatar ring
// and glow, the other two the lines of text. Anything unset keeps the theme's.
function withServerColors(t, colors = {}) {
  const accent = HEX.test(colors.accent ?? '') ? colors.accent : null;
  const title = HEX.test(colors.title ?? '') ? colors.title : null;
  const subtitle = HEX.test(colors.subtitle ?? '') ? colors.subtitle : null;
  if (!accent && !title && !subtitle) return t;
  return {
    ...t,
    colors: {
      ...t.colors,
      ...(accent ? { ring: accent, accent, letter: accent, trackLine: accent } : {}),
      ...(title ? { text: title } : {}),
      ...(subtitle ? { muted: subtitle } : {}),
    },
    glow: {
      ...t.glow,
      ...(accent ? { ring: hexRgba(accent, 0.55) } : {}),
      ...(accent && t.glow?.name ? { name: hexRgba(accent, 0.3) } : {}),
    },
  };
}

/**
 * @param {{ theme?: string, avatarUrl?: string|null, name: string, title?: string, subtitle?: string,
 *           colors?: { accent?: string, title?: string, subtitle?: string },
 *           background?: { src: string|Buffer, blur?: boolean } }} data
 * @returns {Promise<Buffer|null>}
 */
export async function renderWelcomeCard(data) {
  const cv = await getCanvas();
  if (!cv) return null;
  const { createCanvas, loadImage } = cv;
  const t = withServerColors(WELCOME_CARD_THEMES[data.theme] ? THEMES[data.theme] : THEMES[DEFAULT_RANK_CARD_THEME], data.colors);
  const c = t.colors;
  const name = visibleName(data.name, 'New member');

  const canvas = createCanvas(WC_W, WC_H);
  const ctx = canvas.getContext('2d');
  // Synchronous, so no other card can be drawn while W and H are swapped.
  const [w0, h0] = [W, H];
  W = WC_W; H = WC_H;
  try { t.background(ctx); } finally { W = w0; H = h0; }

  // A server background (an upload, or its banner or icon, blurred) over the
  // theme, under a tint that's strongest where the text sits.
  // The first that loads of the background and its fallback (a banner that
  // isn't there falls back to the icon).
  let bgUsed = null, bg = null;
  for (const option of [data.background, data.background?.fallback]) {
    if (!option?.src) continue;
    bg = await loadImage(option.src).catch(() => null);
    if (bg) { bgUsed = option; break; }
  }
  if (bg) {
    data = { ...data, background: bgUsed };
    {
      const r = t.avatarShape === 'square' ? 0 : 16;
      ctx.save();
      roundRectPath(ctx, 0, 0, WC_W, WC_H, r);
      ctx.clip();
      const scale = Math.max(WC_W / bg.width, WC_H / bg.height);
      const bw = bg.width * scale, bh = bg.height * scale, bx = (WC_W - bw) / 2, by = (WC_H - bh) / 2;
      if (data.background.blur) {
        // Shrink then stretch back with smoothing: a soft colour wash, so a
        // small icon or a busy banner still works behind the text.
        // Cropped to the card's shape first (no stretching), then enlarged in
        // two steps so it comes out smooth rather than blocky.
        const TW = 36, TH = 13;
        const tiny = createCanvas(TW, TH), tc = tiny.getContext('2d');
        const ts = Math.max(TW / bg.width, TH / bg.height);
        tc.drawImage(bg, (TW - bg.width * ts) / 2, (TH - bg.height * ts) / 2, bg.width * ts, bg.height * ts);
        const mid = createCanvas(TW * 8, TH * 8), mc = mid.getContext('2d');
        mc.imageSmoothingQuality = 'high';
        mc.drawImage(tiny, 0, 0, TW * 8, TH * 8);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(mid, 0, 0, WC_W, WC_H);
      } else {
        ctx.drawImage(bg, bx, by, bw, bh);
      }
      // An uploaded image can be busy, so it's darkened more than a blurred one.
      const base = t.light ? '250, 247, 240' : '8, 10, 14';
      const k = data.background.blur ? 0 : 0.12;
      const tint = ctx.createLinearGradient(0, 0, 0, WC_H);
      tint.addColorStop(0, `rgba(${base}, ${(t.light ? 0.45 : 0.3) + k})`);
      tint.addColorStop(0.55, `rgba(${base}, ${(t.light ? 0.7 : 0.55) + k})`);
      tint.addColorStop(1, `rgba(${base}, ${Math.min(0.92, (t.light ? 0.85 : 0.78) + k)})`);
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, WC_W, WC_H);
      ctx.restore();
      roundRectPath(ctx, 1, 1, WC_W - 2, WC_H - 2, r);
      ctx.strokeStyle = c.accent;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // Avatar, centred near the top, in the theme's ring.
  const AV = 150, CX = WC_W / 2, CY = 26 + AV / 2, R = AV / 2;
  t.ring(ctx, CX, CY, R - 4, t);
  let img = null;
  if (data.avatarUrl) {
    const pngUrl = stillImageUrl(data.avatarUrl);
    img = await loadImage(pngUrl).catch(() => loadImage(data.avatarUrl).catch(() => null));
  }
  const ir = R - 6, ix = CX - ir, iy = CY - ir;
  ctx.save();
  if (t.avatarShape === 'square') roundRectPath(ctx, ix, iy, ir * 2, ir * 2, 0);
  else { ctx.beginPath(); ctx.arc(CX, CY, ir, 0, Math.PI * 2); }
  ctx.clip();
  if (img && t.pixelate) {
    const small = createCanvas(t.pixelate, t.pixelate);
    small.getContext('2d').drawImage(img, 0, 0, t.pixelate, t.pixelate);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, ix, iy, ir * 2, ir * 2);
    ctx.imageSmoothingEnabled = true;
  } else if (img) {
    ctx.drawImage(img, ix, iy, ir * 2, ir * 2);
  } else {
    ctx.fillStyle = c.avatarBg;
    ctx.fillRect(ix, iy, ir * 2, ir * 2);
    const letter = [...name].find(ch => /\p{L}|\p{N}/u.test(ch))?.toUpperCase() ?? '?';
    const lf = roleFont(t, 'name', letter, 64);
    ctx.fillStyle = c.letter ?? c.accent;
    ctx.font = lf.font;
    ctx.textAlign = 'center';
    ctx.fillText(letter, CX, CY + lf.size * 0.36);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  // Up to two lines, centred. Either can be left out.
  const title = String(data.title ?? '').trim(), subtitle = String(data.subtitle ?? '').trim();
  const maxW = WC_W - 90;
  const line = async (text, role, size, color, glow, y) => {
    const parts = await textParts(loadImage, text);
    // Shrink a long line to fit (down to 70%) before cutting it short.
    let f = roleFont(t, role, text, size);
    ctx.font = f.font;
    const natural = partsWidth(ctx, parts, f.size);
    if (natural > maxW) {
      f = roleFont(t, role, text, Math.max(Math.floor(size * 0.7), Math.floor(size * maxW / natural)));
      ctx.font = f.font;
    }
    const w = Math.min(partsWidth(ctx, parts, f.size), maxW);
    ctx.fillStyle = color;
    withGlow(ctx, glow, 12, () => drawParts(ctx, parts, CX - w / 2, y, f.size, maxW));
  };
  // Cards show at about half size in chat, so the text runs large; a lone
  // second line gets bigger still.
  const titleSize = Math.round((t.sizes?.name ?? 30) * 1.45);
  const subSize = Math.round((t.sizes?.small ?? 15) * (title ? 1.75 : 2.1));
  const top = CY + R + 18;
  if (title) await line(title, 'name', titleSize, c.text, t.glow?.name, top + titleSize * 0.9);
  if (subtitle) await line(subtitle, 'small', subSize, c.muted, null, title ? top + titleSize * 0.9 + subSize * 1.55 : top + subSize * 1.2);

  return canvas.toBuffer('image/png');
}

export async function renderThemeGallery(data) {
  const cv = await getCanvas();
  if (!cv) return null;
  const { createCanvas, loadImage } = cv;

  let avatarImage = null;
  if (data.avatarUrl) {
    const pngUrl = stillImageUrl(data.avatarUrl);
    avatarImage = await loadImage(pngUrl).catch(() => loadImage(data.avatarUrl).catch(() => null));
  }

  const keys = Object.keys(THEMES);
  const COLS = 2, GAP = 24, LABEL = 40, MARGIN = 28, HEADER = data.title ? 64 : 0;
  const rows = Math.ceil(keys.length / COLS);
  const sheet = createCanvas(MARGIN * 2 + COLS * W + (COLS - 1) * GAP, MARGIN * 2 + HEADER + rows * (LABEL + H) + (rows - 1) * GAP);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#0d1210';
  ctx.fillRect(0, 0, sheet.width, sheet.height);

  if (data.title) {
    ctx.fillStyle = '#e7fbef';
    ctx.font = font(['Noto Sans', 'bold'], 30);
    ctx.fillText(data.title, MARGIN, MARGIN + 34);
  }

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const x = MARGIN + (i % COLS) * (W + GAP);
    const y = MARGIN + HEADER + Math.floor(i / COLS) * (LABEL + H + GAP);
    ctx.fillStyle = '#e7fbef';
    ctx.font = font(['Noto Sans', 'bold'], 20);
    ctx.fillText(THEMES[key].label, x + 2, y + 26);
    const labelW = ctx.measureText(THEMES[key].label).width;
    ctx.fillStyle = '#8fae98';
    ctx.font = font(['Noto Sans'], 16);
    ctx.fillText(`b!card theme ${key}${THEMES[key].voteOnly ? '  ·  for voters (b!vote)' : ''}`, x + labelW + 14, y + 26);
    const card = await renderRankCard({ ...data, theme: key, background: null, avatarImage });
    ctx.drawImage(await loadImage(card), x, y + LABEL, W, H);
  }
  return sheet.toBuffer('image/png');
}
