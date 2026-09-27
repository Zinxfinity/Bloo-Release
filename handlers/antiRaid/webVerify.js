// ─── Web verify, token issuance and the DM/channel prompt ─────────────────────

import logger from '../../utils/logger.js';
import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';
import { stmts } from './schema.js';
import { siteUrl } from '../../config/site.js';

function generateToken() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

export function createVerifyToken(guildId, userId) {
  const token = generateToken();
  stmts.insertToken.run(token, guildId, userId);
  return token;
}

export function consumeVerifyToken(token) {
  const row = stmts.getToken.get(token);
  if (!row) return null;
  stmts.markTokenUsed.run(token);
  return row; // { token, guild_id, user_id }
}

export async function sendWebVerify(client, member, guildId, userId, config) {
  const token     = createVerifyToken(guildId, userId);
  const verifyUrl = `${siteUrl()}/verify?guild=${guildId}&user=${userId}&token=${token}`;

  const embed = new EmbedBuilder()
    .setColor(COLORS.WARNING)
    .setTitle('Verification Required')
    .setDescription(
      `To gain access to the server, please complete verification:\n\n**[Click here to verify](${verifyUrl})**\n\nThis link expires in **10 minutes**.`
    );

  let dmSent  = false;
  let dmError = null;
  try {
    // Previously this whole chain had one .catch(() => null), which threw
    // away the actual error (closed DMs vs. user not found vs. a REST
    // error), same gap fixed in captcha.js's sendDmCaptcha.
    const user = await client.users.fetch(userId);
    const dm   = await user.createDM();
    await dm.send({ embeds: [embed.toJSON()] });
    dmSent = true;
  } catch (err) {
    dmError = err;
  }

  if (dmSent) return;

  if (config.verify_channel_id) {
    try {
      await client.rest.post(`/channels/${config.verify_channel_id}/messages`, {
        body: {
          content: `<@${userId}>`,
          embeds: [embed.toJSON()],
        },
      });
      logger.warn(`[ANTIRAID] DM web verify link failed for ${userId} in ${guildId} (${dmError?.message ?? 'unknown error'}), posted channel fallback instead`);
    } catch (err) {
      logger.warn(`[ANTIRAID] DM web verify link failed for ${userId} in ${guildId} (${dmError?.message ?? 'unknown error'}), AND channel fallback also failed: ${err.message}`);
    }
  } else {
    logger.warn(`[ANTIRAID] DM web verify link failed for ${userId} in ${guildId} (${dmError?.message ?? 'unknown error'}) and no verify channel set, member has no way to verify`);
  }
}
