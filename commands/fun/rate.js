// ============================================================
//  commands/fun/rate.js
//  Category : General  |  Access 0  |  Rank 0 (public)
//
//  Bot rates anything out of 10 with a witty comment.
//  Uses a seeded hash so the same input always gets the same score.
//  !rate <anything>
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0;
  }
  return h;
}

const COMMENTS = {
  10: ["Absolute perfection. Don't even question it.", "Peak. We're done here.", "The universe made this and called it a day.", "Flawless. Genuinely iconic."],
  9:  ["So close to perfect it stings.", "Basically a 10. Round up.", "Chef's kiss. Nearly immaculate.", "Would recommend to everyone."],
  8:  ["Very solid. Respectable.", "Good stuff. I approve.", "No notes, honestly.", "Would hang out with this."],
  7:  ["Not bad at all. Could be worse.", "Solid seven. A reliable choice.", "Gets the job done with style.", "I'd give this a second chance."],
  6:  ["It's fine. Nothing to write home about.", "Decent but forgettable.", "Could be a 7 with some effort.", "Exists. Does its job. Moving on."],
  5:  ["Right in the middle. Bold choice.", "Exactly average. Statistically acceptable.", "Not great, not terrible.", "I've seen worse. I've also seen better."],
  4:  ["A little rough around the edges.", "Questionable but not illegal.", "Needs work. Significant work.", "I've been kinder to things that deserved it less."],
  3:  ["Yikes. This is giving problems.", "I wouldn't recommend this to anyone.", "The audacity of this even existing.", "Hard pass. Next."],
  2:  ["Truly a choice that was made.", "I feel personally attacked by this.", "Somehow worse than I expected.", "How. WHY."],
  1:  ["Legendary in the worst possible way.", "I want to unlearn this.", "The single most cursed thing I've rated.", "Even the number 1 feels generous."],
  0:  ["Couldn't even scrape together a 1. Extraordinary.", "I have no words. This is a new low.", "Deleted from my memory immediately.", "A zero. Clean, honest, devastating."],
};

function ratingColor(score) {
  if (score >= 8) return COLORS.SUCCESS;
  if (score >= 6) return COLORS.WARNING;
  if (score >= 4) return 0xFF8C00; // orange
  return COLORS.DANGER;
}

function bar(score) {
  const filled = score;
  return '🟩'.repeat(filled) + '⬛'.repeat(10 - filled);
}

export default {
  name: 'rate',
  aliases: ['ratethis', 'howgood'],
  description: 'Bot rates anything you give it out of 10.',
  usage: '{prefix}rate <anything>',
  category: 'fun',

  requiredPermission: null,

  cooldown: 4,

  async execute({ message, args, prefix }) {
    const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';
    const thing  = args.join(' ').trim();

    if (!thing) {
      await message.reply(`Usage: \`${PREFIX}rate <anything>\``).catch(() => {});
      return;
    }

    const score    = hashString(thing.toLowerCase()) % 11; // 0–10
    const comments = COMMENTS[score];
    const comment  = comments[hashString(thing + 'comment') % comments.length];

    const embed = new EmbedBuilder()
      .setColor(ratingColor(score))
      .setTitle(`🔢  I rate: ${thing.slice(0, 100)}`)
      .setDescription(`**${score}/10**, ${comment}`)
      .addFields({ name: 'Meter', value: bar(score), inline: false })
      .setFooter({ text: `Rated by ${message.author.username}` })
      .setTimestamp();

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
