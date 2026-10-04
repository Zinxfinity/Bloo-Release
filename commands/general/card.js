// ============================================================
//  commands/general/card.js
//  Category : General  |  Everyone (review subcommands: Bot Owner)
//
//  Rank card look, per member and the same in every server:
//    b!card                       your theme and background status
//    b!card themes                every theme drawn with your avatar and name
//                                 (also b!card theme list)
//    b!card theme <name>          pick a theme
//    b!card background            attach an image to submit it for review
//    b!card background remove     remove your background (and any pending one)
//    b!card preview               see your card
//  Bot owners:
//    b!card review [@user]        next background waiting (or a member's)
//    b!card approve @user         put it live, replacing the old one
//    b!card decline @user [why]   delete it and tell the member why
//    b!card remove @user          take a live background down
//    b!card backgrounds on|off    let members submit backgrounds (off by default)
//    b!card showcase Name | Rank | Next rank
//                                 the theme gallery with your avatar and your own text
// ============================================================

import { parseUserMention } from '@fluxerjs/core';
import { Embed } from '../../config/embeds.js';
import { isBotOwner } from '../../handlers/staffSystem.js';
import { renderRankCard, renderThemeGallery, RANK_CARD_THEMES, VOTE_ONLY_THEMES } from '../../handlers/profileCard.js';
import {
  getCardProfile, setCardTheme, submitBackground, approveBackground, declineBackground,
  cancelPending, removeBackground, listBackgrounds, cardFilePaths, CardError, LIMITS,
  backgroundsEnabled, setBackgroundsEnabled,
} from '../../handlers/cardBackgrounds.js';
import { getUserXp, getUserRank, levelProgress, getLevelName } from '../../handlers/xpSystem.js';

const attachmentsOf = message => Array.isArray(message.attachments)
  ? message.attachments
  : [...(message.attachments?.values?.() ?? [])];
const targetOf = arg => (arg ? (parseUserMention(arg) ?? arg.replace(/\D/g, '')) : '');
const themeList = () => Object.entries(RANK_CARD_THEMES).map(([k, v]) => `\`${k}\` ${v}${VOTE_ONLY_THEMES.has(k) ? ' (for voters, see `b!vote`)' : ''}`).join(' · ');

// A card for `userId`, using their real XP here when they have any. `override`
// lets review show a pending background before it's approved.
async function cardFor(client, guildId, userId, override = {}) {
  const profile = getCardProfile(userId);
  const row = guildId ? getUserXp(guildId, userId) : null;
  const xp = row?.xp ?? 0;
  const { level, next, nextLevel, progress } = levelProgress(guildId, xp);
  const user = await client.rest.get(`/users/${userId}`).catch(() => null);
  return renderRankCard({
    theme: profile.theme,
    background: profile.background,
    supporter: profile.supporter,
    username: user?.username ?? row?.display_name ?? userId,
    fallbackName: row?.display_name,
    avatarUrl: user?.avatar ? `https://fluxerusercontent.com/avatars/${userId}/${user.avatar}.png?size=128` : null,
    xp, level, rank: getUserRank(guildId, userId) ?? 0,
    levelName: getLevelName(guildId, level),
    xpForNextLevel: next ?? xp, maxed: next == null, xpProgress: progress,
    nextLabel: next == null ? null : (getLevelName(guildId, nextLevel) ?? `Level ${nextLevel}`),
    ...override,
  });
}

const reply = (message, kind, text) => message.reply({ embeds: [Embed[kind](text).toJSON()] });

// Every theme drawn with this member's avatar and name. XP numbers are a
// fixed example, so the gallery is about the look, not their progress.
async function galleryFor(client, guildId, userId, override = {}) {
  const user = await client.rest.get(`/users/${userId}`).catch(() => null);
  const row = guildId ? getUserXp(guildId, userId) : null;
  return renderThemeGallery({
    username: user?.username ?? row?.display_name ?? 'You',
    fallbackName: row?.display_name,
    avatarUrl: user?.avatar ? `https://fluxerusercontent.com/avatars/${userId}/${user.avatar}.png?size=128` : null,
    level: 12, rank: 1, xp: 18420, xpForNextLevel: 24000, xpProgress: 0.62,
    levelName: '✨ Your Level', nextLabel: 'Next Level',
    ...override,
  });
}

export default {
  name: 'card',
  aliases: ['profilecard', 'rankcard'],
  description: 'Choose your rank card theme and background.',
  usage: '{prefix}card\n{prefix}card themes\n{prefix}card theme <name>\n{prefix}card preview',
  requiredPermission: null,
  internalAccess: true,
  cooldown: 5,

  async execute({ message, args, client, prefix }) {
    const userId  = message.author.id;
    const guildId = message.guildId;
    const sub     = args[0]?.toLowerCase();
    const owner   = isBotOwner(userId);

    try {
      if (!sub) {
        const p = getCardProfile(userId);
        const on = backgroundsEnabled();
        const bg = p.pending ? 'Waiting for review' : p.background ? 'Custom (approved)' : 'Theme default';
        const lines = [
          `**Theme:** ${RANK_CARD_THEMES[p.theme]}`,
          on ? `**Background:** ${bg}` : null,
          on && p.lastDecision === 'declined' && !p.pending && p.declineReason ? `Your last upload wasn't approved: ${p.declineReason}` : null,
          '',
          on
            ? `\`${prefix}card theme <name>\` to change theme, \`${prefix}card background\` with an image attached to submit a background, \`${prefix}card preview\` to see it.`
            : `\`${prefix}card themes\` to see the themes, \`${prefix}card theme <name>\` to pick one, \`${prefix}card preview\` to see it.`,
          owner ? `-# Bot owner: custom backgrounds are **${on ? 'on' : 'off'}** (\`${prefix}card backgrounds ${on ? 'off' : 'on'}\`).` : null,
        ].filter(l => l !== null);
        return reply(message, 'info', lines.join('\n'));
      }

      if (sub === 'themes' || (sub === 'theme' && (!args[1] || args[1].toLowerCase() === 'list'))) {
        const buf = await galleryFor(client, guildId, userId);
        const text = `**Rank card themes**\n${themeList()}\n\nPick one with \`${prefix}card theme <name>\`, then \`${prefix}card preview\` to see it.`;
        return buf ? message.reply({ content: text, files: [{ name: 'card-themes.png', data: buf }] }) : reply(message, 'info', text);
      }

      if (sub === 'showcase') {
        if (!owner) return reply(message, 'denied', 'Only the bot owner can make a showcase.');
        const [name, rank, next] = args.slice(1).join(' ').split('|').map(s => s.trim());
        if (!name) return reply(message, 'info', `Usage: \`${prefix}card showcase Name | Current rank | Next rank\`\nExample: \`${prefix}card showcase Robbie | 🍵 Tea Taster | 🫖 Tea Lover\``);
        const buf = await galleryFor(client, guildId, userId, { username: name, levelName: rank || null, nextLabel: next || null, title: null });
        return buf ? message.reply({ files: [{ name: 'card-showcase.png', data: buf }] }) : reply(message, 'warning', 'Cards can\'t be drawn right now.');
      }

      if (sub === 'theme') {
        const key = setCardTheme(userId, args.slice(1).join(' '));
        return reply(message, 'success', `Your rank card theme is now **${RANK_CARD_THEMES[key]}**. See it with \`${prefix}card preview\`.`);
      }

      if (sub === 'preview') {
        const buf = await cardFor(client, guildId, userId);
        if (!buf) return reply(message, 'warning', 'Cards can\'t be drawn right now.');
        return message.reply({ files: [{ name: 'card.png', data: buf }] });
      }

      if (sub === 'backgrounds') {
        if (!owner) return reply(message, 'denied', 'Only the bot owner can switch custom backgrounds on or off.');
        const want = args[1]?.toLowerCase();
        if (!['on', 'off'].includes(want)) return reply(message, 'info', `Custom backgrounds are **${backgroundsEnabled() ? 'on' : 'off'}**. Use \`${prefix}card backgrounds on|off\`.`);
        const on = setBackgroundsEnabled(want === 'on');
        return reply(message, 'success', on
          ? 'Custom backgrounds are **on**. Members can submit them with `b!card background`, and each still needs your approval.'
          : 'Custom backgrounds are **off**. Nothing can be submitted, and cards show their theme background only. Approved backgrounds are kept for when you switch them back on.');
      }

      if ((sub === 'background' || sub === 'bg') && !backgroundsEnabled()) {
        return reply(message, 'info', `Custom backgrounds aren't available yet. You can still pick a theme with \`${prefix}card themes\`.`);
      }

      if (sub === 'background' || sub === 'bg') {
        if (['remove', 'clear', 'reset'].includes(args[1]?.toLowerCase())) {
          const hadLive = removeBackground(userId);
          const hadPending = cancelPending(userId);
          return reply(message, hadLive || hadPending ? 'success' : 'info',
            hadLive || hadPending ? 'Your background is removed. Your card uses the theme\'s own background again.' : 'You don\'t have a custom background.');
        }
        const file = attachmentsOf(message)[0];
        if (!file) {
          return reply(message, 'info', [
            `Attach an image to \`${prefix}card background\` to submit it.`,
            `PNG, JPEG or GIF, up to ${LIMITS.maxBytes / 1024 / 1024} MB and ${LIMITS.maxSide}x${LIMITS.maxSide}. It's cropped to the card's shape (${LIMITS.outW}x${LIMITS.outH} works best).`,
            'Every background is checked by the bot owner before it shows. Your current one stays until the new one is approved.',
          ].join('\n'));
        }
        const hadPending = getCardProfile(userId).pending;
        await submitBackground(userId, file, { name: message.author.username, guildId });
        return reply(message, 'success', `${hadPending ? 'Your new upload replaced the one that was waiting. ' : ''}Your background is submitted for review. You'll get a DM when it's approved or declined.`);
      }

      // ── Bot owner review ─────────────────────────────────────────────────
      if (['review', 'approve', 'decline', 'remove'].includes(sub)) {
        if (!owner) return reply(message, 'denied', 'Only the bot owner reviews card backgrounds.');

        if (sub === 'review') {
          const all = listBackgrounds().filter(b => b.pending);
          const pick = args[1] ? all.find(b => b.userId === targetOf(args[1])) : all[0];
          if (!pick) return reply(message, 'info', all.length ? 'That member has nothing waiting.' : 'No backgrounds are waiting for review.');
          const buf = await cardFor(client, guildId, pick.userId, { background: cardFilePaths(pick.userId).pending });
          return message.reply({
            content: `**${all.length}** waiting. This one is from <@${pick.userId}> (${pick.name ?? pick.userId}).\n\`${prefix}card approve ${pick.userId}\` or \`${prefix}card decline ${pick.userId} [reason]\``,
            allowedMentions: { parse: [] },
            files: buf ? [{ name: 'review.png', data: buf }] : [],
          });
        }

        const target = targetOf(args[1]);
        if (!/^\d{15,22}$/.test(target)) return reply(message, 'warning', `Usage: \`${prefix}card ${sub} @user${sub === 'decline' ? ' [reason]' : ''}\``);
        if (sub === 'approve') { await approveBackground(target, userId); return reply(message, 'success', `Approved <@${target}>'s background. Their old one is replaced.`); }
        if (sub === 'decline') { await declineBackground(target, userId, args.slice(2).join(' ') || null); return reply(message, 'success', `Declined <@${target}>'s background and deleted it.`); }
        if (sub === 'remove') {
          const had = removeBackground(target, { notify: true });
          return reply(message, had ? 'success' : 'info', had ? `Removed <@${target}>'s background.` : 'That member has no live background.');
        }
      }

      return reply(message, 'warning', `Unknown option. Try \`${prefix}card\`, \`${prefix}card themes\`, \`${prefix}card theme <name>\`, \`${prefix}card background\` or \`${prefix}card preview\`.`);
    } catch (err) {
      if (err instanceof CardError) return reply(message, 'warning', err.message);
      throw err;
    }
  },
};
