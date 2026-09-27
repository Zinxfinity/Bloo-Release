import logger from '../utils/logger.js';

let _canvas = null;

async function getCanvas() {
  if (_canvas) return _canvas;
  try {
    _canvas = await import('canvas');
    // Register fonts if available
    try {
      _canvas.registerFont('/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf', { family: 'Noto Sans' });
    } catch {
      try {
        _canvas.registerFont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', { family: 'DejaVu Sans' });
      } catch { /* no system font, canvas will use default */ }
    }
    return _canvas;
  } catch {
    return null;
  }
}

/**
 * Render an XP rank card PNG buffer.
 * @param {{ username: string, avatarUrl: string|null, xp: number, level: number, levelName?: string|null, rank: number, xpForNextLevel: number, xpProgress: number }} data
 * @returns {Promise<Buffer|null>}
 */
export async function renderRankCard(data) {
  const cv = await getCanvas();
  if (!cv) return null;

  const { createCanvas, loadImage } = cv;
  const { username, avatarUrl, xp, level, levelName, rank, xpForNextLevel, xpProgress } = data;

  const W = 700, H = 175;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#141c14';
  ctx.roundRect?.(0, 0, W, H, 16);
  ctx.fill();

  // Avatar
  const AVATAR_SIZE = 110;
  const AVATAR_X    = 32;
  const AVATAR_Y    = (H - AVATAR_SIZE) / 2;

  if (avatarUrl) {
    try {
      // node-canvas: always fetch PNG
      const pngUrl = avatarUrl.includes('.png') ? avatarUrl : avatarUrl.replace(/\.(webp|jpg)/, '.png');
      const img    = await loadImage(pngUrl).catch(() => loadImage(avatarUrl).catch(() => null));
      if (img) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(AVATAR_X + AVATAR_SIZE / 2, AVATAR_Y + AVATAR_SIZE / 2, AVATAR_SIZE / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, AVATAR_X, AVATAR_Y, AVATAR_SIZE, AVATAR_SIZE);
        ctx.restore();
      }
    } catch { /* avatar load failed, skip */ }
  }

  // Username
  const TEXT_X = AVATAR_X + AVATAR_SIZE + 24;
  ctx.fillStyle = '#d1fae5';
  ctx.font      = 'bold 28px "Noto Sans", "DejaVu Sans", sans-serif';
  ctx.fillText(username.slice(0, 20), TEXT_X, 48);

  // Rank
  ctx.fillStyle = '#4ade80';
  ctx.font      = 'bold 20px "Noto Sans", "DejaVu Sans", sans-serif';
  ctx.fillText(`Rank #${rank}`, W - 140, 48);

  // Level
  ctx.fillStyle = '#4ade80';
  ctx.font      = 'bold 22px "Noto Sans", "DejaVu Sans", sans-serif';
  ctx.fillText(levelName ? `Level ${level} · ${levelName}` : `Level ${level}`, TEXT_X, 90);

  // XP text
  ctx.fillStyle = '#8aa88a';
  ctx.font      = '16px "Noto Sans", "DejaVu Sans", sans-serif';
  ctx.fillText(`${xp.toLocaleString()} / ${xpForNextLevel.toLocaleString()} XP`, TEXT_X, 118);

  // Progress bar track
  const BAR_X = TEXT_X;
  const BAR_Y = 130;
  const BAR_W = W - TEXT_X - 32;
  const BAR_H = 18;

  ctx.fillStyle = '#1e2e1e';
  ctx.roundRect?.(BAR_X, BAR_Y, BAR_W, BAR_H, 9);
  ctx.fill();

  // Progress bar fill
  const fillW = Math.max(0, Math.min(1, xpProgress)) * BAR_W;
  if (fillW > 0) {
    ctx.fillStyle = '#4ade80';
    ctx.roundRect?.(BAR_X, BAR_Y, fillW, BAR_H, 9);
    ctx.fill();
  }

  return canvas.toBuffer('image/png');
}
