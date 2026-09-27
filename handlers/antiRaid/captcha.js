// ─── DM image captcha, generation, canvas rendering, and response handling ────

import db from '../../db.js';
import logger from '../../utils/logger.js';
import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';
import { stmts } from './schema.js';
import { getAntiRaidConfig } from './config.js';
import { giveHeldAutorole } from '../autoroleGate.js';

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1

function randomCode(length = 6) {
  const arr = crypto.getRandomValues(new Uint8Array(length));
  return [...arr].map(b => CHARS[b % CHARS.length]).join('');
}

function renderCaptchaImage(createCanvas, code) {
  const width  = 280;
  const height = 90;
  const canvas = createCanvas(width, height);
  const ctx    = canvas.getContext('2d');

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 8; i++) {
    ctx.strokeStyle = `hsl(${Math.random() * 360},50%,60%)`;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(Math.random() * width, Math.random() * height);
    ctx.lineTo(Math.random() * width, Math.random() * height);
    ctx.stroke();
  }

  ctx.font         = 'bold 38px sans-serif';
  ctx.textBaseline = 'middle';
  const charSpacing = (width - 40) / code.length;

  for (let i = 0; i < code.length; i++) {
    const hue = Math.floor(Math.random() * 360);
    ctx.fillStyle = `hsl(${hue},80%,70%)`;
    ctx.save();
    ctx.translate(20 + i * charSpacing + charSpacing / 2, height / 2);
    ctx.rotate((Math.random() - 0.5) * 0.4);
    ctx.fillText(code[i], 0, 0);
    ctx.restore();
  }

  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.3})`;
    ctx.beginPath();
    ctx.arc(Math.random() * width, Math.random() * height, Math.random() * 2, 0, Math.PI * 2);
    ctx.fill();
  }

  return canvas.toBuffer('image/png');
}

export async function sendDmCaptcha(client, member, guildId, userId, config) {
  const code = randomCode();
  stmts.upsertSession.run(userId, guildId, code);

  // Opportunistic cleanup of expired sessions (5% chance to avoid running every join)
  if (Math.random() < 0.05) {
    try { db.prepare(`DELETE FROM dm_captcha_sessions WHERE expires_at <= unixepoch()`).run(); } catch { /* non-fatal */ }
  }

  // Try to render with canvas, fall back to text if canvas unavailable
  let imageBuffer = null;
  try {
    const { createCanvas } = await import('canvas');
    imageBuffer = renderCaptchaImage(createCanvas, code);
  } catch { /* canvas not available, text fallback */ }

  const embed = new EmbedBuilder()
    .setColor(COLORS.WARNING)
    .setTitle('Verification Required')
    .setDescription(
      imageBuffer
        ? 'Enter the code shown in the image to verify. You have **3 attempts** and **10 minutes**.'
        : `Your verification code is: **\`${code}\`**\n\nReply with this code to gain access.\nExpires in **10 minutes**.\n\n*Tip: Enable images for a more secure captcha.*`
    );

  let dmSent  = false;
  let dmError = null;
  try {
    // Each step used to have its own inline .catch(() => null), which
    // swallowed the real error before it ever reached this outer
    // try/catch, meaning nothing anywhere recorded WHY a DM failed
    // (closed DMs vs. user not found vs. a REST error), just that it did.
    const user = await client.users.fetch(userId);
    const dm   = await user.createDM();
    const payload = { embeds: [embed.toJSON()] };
    if (imageBuffer) {
      // Inline `files` comes back INVALID_FORM_BODY from this Fluxer API
      // regardless of payload shape (confirmed against DMs and guild
      // channels, see ticketSystem/lifecycle.js's transcript attachment).
      // The presigned upload flow is what it actually accepts.
      const uploaded = await dm.uploadAttachmentsForSend([
        { id: 0, filename: 'captcha.png', data: imageBuffer, contentType: 'image/png' },
      ]);
      payload.uploadedAttachments = uploaded;
    }
    await dm.send(payload);
    dmSent = true;
  } catch (err) {
    dmError = err;
  }

  if (dmSent) return;

  // Dashboard's own copy for this mode promises "if their DMs are closed,
  // Bloo posts a prompt in your verify channel instead" (the Verify
  // Channel ID field is even labeled "nudge posted here if DMs closed"),
  // matching what sendWebVerify already does. This mode never actually
  // did it, closed DMs left the member with no message anywhere, just a
  // warn log only an admin reading server logs would ever see.
  if (config.verify_channel_id) {
    // Text-only fallback (no captcha image): there's no established
    // pattern in this codebase for uploading a file buffer through
    // client.rest.post for a channel message, only DM sends do that.
    // The plain-text code the embed already falls back to when canvas
    // is unavailable works fine here too.
    // Session-response handling (events/guild/messageCreate.js) only
    // listens for real DMs, so this can't tell the member to reply here
    // in the channel, that reply would never be seen.
    const fallbackEmbed = new EmbedBuilder()
      .setColor(COLORS.WARNING)
      .setTitle('Verification Required')
      .setDescription(
        `I couldn't DM you the verification code, your DMs may be closed to the bot.\n\nSend me a direct message and reply with this code to verify:\n\n**\`${code}\`**\n\nExpires in **10 minutes**.`
      );
    try {
      await client.rest.post(`/channels/${config.verify_channel_id}/messages`, {
        body: { content: `<@${userId}>`, embeds: [fallbackEmbed.toJSON()] },
      });
      logger.warn(`[ANTIRAID] DM captcha failed for ${userId} in ${guildId} (${dmError?.message ?? 'unknown error'}), posted channel fallback instead`);
    } catch (err) {
      logger.warn(`[ANTIRAID] DM captcha failed for ${userId} in ${guildId} (${dmError?.message ?? 'unknown error'}), AND channel fallback also failed: ${err.message}`);
    }
  } else {
    logger.warn(`[ANTIRAID] DM captcha failed for ${userId} in ${guildId} (${dmError?.message ?? 'unknown error'}) and no verify channel set, member has no way to verify`);
  }
}

// Called from a DM message event when a user responds to the captcha.
// Returns { verified: boolean, expired: boolean, tooManyAttempts: boolean }
export async function handleDmResponse(client, guildId, userId, response) {
  const session = stmts.getSession.get(userId, guildId);

  if (!session || session.expires_at <= Math.floor(Date.now() / 1000)) {
    stmts.deleteSession.run(userId, guildId);
    return { verified: false, expired: true };
  }

  if (session.attempts >= 3) {
    stmts.deleteSession.run(userId, guildId);
    return { verified: false, tooManyAttempts: true };
  }

  if (response.trim().toUpperCase() !== session.code) {
    stmts.incrementAttempts.run(userId, guildId);
    const remaining = 3 - (session.attempts + 1);
    return { verified: false, remaining };
  }

  // Correct, grant role
  stmts.deleteSession.run(userId, guildId);

  const config = getAntiRaidConfig(guildId);
  if (config?.verified_role_id) {
    try {
      await client.rest.put(
        `/guilds/${guildId}/members/${userId}/roles/${config.verified_role_id}`
      );
    } catch (err) {
      logger.warn(`[ANTIRAID] Failed to assign verified role to ${userId} in ${guildId}:`, err.message);
      return { verified: false, roleFailed: true };
    }
    await giveHeldAutorole(client, db, guildId, userId);
  }

  return { verified: true };
}
