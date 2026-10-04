// ============================================================
//  commands/general/profile.js
//  Category : General  |  Access 0, Everyone  |  Rank 0, Public
//
//  !profile [@user|userId]
// ============================================================

import { EmbedBuilder }    from '@fluxerjs/core';
import { Embed, COLORS }   from '../../config/embeds.js';
import { renderRankCard }  from '../../handlers/profileCard.js';
import { getCardProfile }  from '../../handlers/cardBackgrounds.js';
import {
  getXpConfig, getUserXp, getUserRank,
  levelProgress, getLevelName,
} from '../../handlers/xpSystem.js';
import { parseUserMention } from '@fluxerjs/core';

export default {
  name: 'profile',
  aliases: ['pfc'], // not "card": that's the b!card command
  description: 'View your profile card: XP, level, and rank.',
  usage: '{prefix}profile [@user | userId]',
  category: 'general',

  requiredPermission: null,

  cooldown: 8,

  async execute({ message, args, client }) {
    const guildId = message.guildId;
    if (!guildId) {
      await message.reply({ content: '❌ This command can only be used inside a server.' }).catch(() => {});
      return;
    }

    const cfg = getXpConfig(guildId);
    if (!cfg?.enabled) {
      await message.reply({ content: 'ℹ️ The XP system is not enabled in this server.' }).catch(() => {});
      return;
    }

    const targetId = args[0]
      ? (parseUserMention(args[0]) ?? args[0].replace(/\D/g, ''))
      : message.author.id;

    const userData = getUserXp(guildId, targetId);
    if (!userData) {
      await message.reply({
        embeds: [Embed.info('No XP data found for that user.').toJSON()],
      });
      return;
    }

    // Fetch user info for avatar
    const user = await client.rest.get(`/users/${targetId}`).catch(() => null);
    const username = user?.username ?? userData.display_name ?? targetId;
    const avatarUrl = user?.avatar
      ? `https://fluxerusercontent.com/avatars/${targetId}/${user.avatar}.png?size=128`
      : null;

    const xp = userData.xp ?? 0;
    // Totals on both sides, and the guild's custom ladder when it has one.
    const { level, next, nextLevel, progress } = levelProgress(guildId, xp);
    const levelName = getLevelName(guildId, level);
    const rank = getUserRank(guildId, targetId) ?? 0;

    // Same card as b!xp rank, with the member's b!card theme and background.
    const card = getCardProfile(targetId);
    const cardBuffer = await renderRankCard({
      theme: card.theme, background: card.background, supporter: card.supporter, contributor: card.contributor,
      username, avatarUrl, xp, level, rank, levelName,
      xpForNextLevel: next ?? xp,
      maxed: next == null, // top of a custom ladder
      nextLabel: next == null ? null : (getLevelName(guildId, nextLevel) ?? `Level ${nextLevel}`),
      fallbackName: userData.display_name,
      xpProgress: progress,
    });

    const sendTextFallback = () => {
      const embed = new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle(`${username}: ${levelName ? `Level ${level} · ${levelName}` : `Level ${level}`}`)
        .addFields(
          { name: 'XP',   value: `${xp.toLocaleString()} / ${next == null ? 'Max' : next.toLocaleString()}`, inline: true },
          { name: 'Rank', value: `#${rank}`, inline: true },
        );
      return message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
    };

    if (cardBuffer) {
      // If the image reply fails for any reason (missing Attach Files
      // permission, size limit, a network blip), fall back to text instead
      // of silently doing nothing.
      await message.reply({ files: [{ name: 'profile.png', data: cardBuffer }] }).catch(() => sendTextFallback());
    } else {
      await sendTextFallback();
    }
  },
};
