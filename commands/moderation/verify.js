// ============================================================
//  commands/moderation/verify.js
//  Category : Moderation  |  Access 0  |  Rank 0 (everyone)
//
//  !verify             , post a react-to-get-link message
//  !verify @user       , staff: manually verify a user
//  !verify status      , staff: show captcha config
// ============================================================

import { Embed }                              from '../../config/embeds.js';
import db                                     from '../../db.js';
import { giveHeldAutorole }                   from '../../handlers/autoroleGate.js';
import { getMemberPermissionBitsLive }           from '../../handlers/staffSystem.js';
import { Permissions }                           from '../../config/guildPermissions.js';
import {
  getAntiRaidConfig, createVerifyToken,
  registerVerifyMessage, unregisterVerifyMessage,
} from '../../handlers/antiRaid/index.js';

const SITE         = process.env.SITE_URL || 'https://bloo-bot.xyz';
const VERIFY_EMOJI = '✅';

function parseUserId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

export default {
  name: 'verify',
  aliases: ['getverify', 'reverify'],
  description: 'Get or resend a verification link. Staff can manually verify a member.',
  usage: '{prefix}verify [@user | status]',
  category: 'moderation',

  requiredPermission: null,

  cooldown: 30,

  async execute({ message, args, client, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    const userId  = message.author.id;

    if (!guildId) {
      await message.reply({ embeds: [Embed.danger('Server only.').toJSON()] }).catch(() => {});
      return;
    }

    const cfg = getAntiRaidConfig(guildId);

    // ── status ────────────────────────────────────────────────────────────────
    if (args[0]?.toLowerCase() === 'status') {
      const authorBits = await getMemberPermissionBitsLive(client, guildId, userId);
      if ((authorBits & Permissions.KICK_MEMBERS) === 0n) {
        await message.reply({ embeds: [Embed.denied('Kick Members permission required.').toJSON()] }).catch(() => {});
        return;
      }
      await message.reply({
        embeds: [Embed.info('🛡️  Captcha / Anti-Raid Status')
          .addFields(
            { name: '🔒  Raid Mode',      value: cfg?.enabled        ? '✅ Active' : '❌ Off',                                   inline: true },
            { name: '🧩  Captcha',         value: cfg?.captcha_enabled ? '✅ Enabled' : '❌ Disabled',                            inline: true },
            { name: '🔀  Verify Mode',     value: (cfg?.verify_mode ?? 'web') === 'dm' ? '📱 In-DM image' : '🌐 Web captcha',   inline: true },
            { name: '🎭  Verified Role',   value: cfg?.verified_role_id  ? `<@&${cfg.verified_role_id}>`  : '❌ Not set',         inline: true },
            { name: '📋  Verify Channel',  value: cfg?.verify_channel_id ? `<#${cfg.verify_channel_id}>` : '❌ Not set',         inline: true },
            { name: '🕐  Min Account Age', value: `${cfg?.min_account_age ?? 7} day(s)`,                                         inline: true },
            { name: '⚡  Raid Action',     value: cfg?.action ?? 'kick',                                                         inline: true },
          )
          .setFooter({ text: `Configure with ${PREFIX}antiraid on|off|role|channel|mode` })
          .toJSON()],
      });
      return;
    }

    // ── manual verify by staff ────────────────────────────────────────────────
    const targetId = parseUserId(args[0]);
    if (targetId) {
      const authorBits = await getMemberPermissionBitsLive(client, guildId, userId);
      if ((authorBits & Permissions.KICK_MEMBERS) === 0n) {
        await message.reply({ embeds: [Embed.denied('Kick Members permission required to manually verify members.').toJSON()] }).catch(() => {});
        return;
      }
      if (!cfg?.verified_role_id) {
        await message.reply({ embeds: [Embed.warning('No Verified Role').setDescription(`No verified role is set. Configure with \`${PREFIX}antiraid role @Role\`.`).toJSON()] }).catch(() => {});
        return;
      }
      try {
        await client.rest.put(`/guilds/${guildId}/members/${targetId}/roles/${cfg.verified_role_id}`);
        await giveHeldAutorole(client, db, guildId, targetId);
        await message.reply({
          embeds: [Embed.success('✅  Manually Verified')
            .setDescription(`<@${targetId}> has been granted <@&${cfg.verified_role_id}>.`)
            .addFields({ name: '👮  By', value: message.author.username, inline: true })
            .toJSON()],
        });
      } catch (err) {
        await message.reply({ embeds: [Embed.danger('Failed').setDescription(`Could not assign role: ${err.message}`).toJSON()] }).catch(() => {});
      }
      return;
    }

    // ── self-verify flow ──────────────────────────────────────────────────────
    if (!cfg?.captcha_enabled) {
      await message.reply({ embeds: [Embed.info('No Verification Required').setDescription('This server does not have captcha verification enabled.').toJSON()] });
      return;
    }

    // Check if already verified
    if (cfg.verified_role_id) {
      try {
        const member = await client.rest.get(`/guilds/${guildId}/members/${userId}`).catch(() => null);
        const roles  = member?.roles ?? [];
        if (roles.includes(cfg.verified_role_id)) {
          await message.reply({ embeds: [Embed.success('Already Verified').setDescription('You are already verified in this server!').toJSON()] }).catch(() => {});
          return;
        }
      } catch { /* can't check, proceed */ }
    }

    const verifyMode = cfg.verify_mode ?? 'web';
    const channelId  = message.channelId;

    let promptMsg;
    try {
      promptMsg = await message.reply({
        embeds: [{
          color: 0x4ade80,
          title: verifyMode === 'dm' ? '🛡️  Get Your Verification Code' : '🛡️  Get Your Verification Link',
          description: verifyMode === 'dm'
            ? `React ✅ below and Bloo will DM you an image with a code to type back.\n-# This prompt will be removed automatically after use.`
            : `React ✅ below and Bloo will DM you a personal verification link.\n-# This prompt will be removed automatically after use.`,
          footer: { text: `Bloo · ${SITE.replace(/^https?:\/\//, '')}` },
          timestamp: new Date().toISOString(),
        }],
      });
    } catch (err) {
      console.warn(`[VERIFY] Could not post prompt: ${err.message}`);
      return;
    }

    try {
      await client.rest.put(
        `/channels/${channelId}/messages/${promptMsg.id}/reactions/${encodeURIComponent(VERIFY_EMOJI)}/@me`
      );
    } catch { /* missing Add Reactions, prompt still works via DM */ }

    registerVerifyMessage(guildId, channelId, promptMsg.id);
  },
};
