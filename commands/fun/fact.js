// ============================================================
//  commands/fun/fact.js
//  Category : General  |  Access 0  |  Rank 0 (public)
//
//  Shares a random weird/interesting fact.
//  !fact
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';

const FACTS = [
  "A group of flamingos is called a flamboyance.",
  "Honey never spoils. Archaeologists have found 3,000-year-old honey in Egyptian tombs that was still edible.",
  "Cleopatra lived closer in time to the Moon landing than to the construction of the Great Pyramid.",
  "A day on Venus is longer than a year on Venus.",
  "Crows can hold grudges. They remember human faces and warn their friends about people who've wronged them.",
  "The shortest war in history lasted 38 to 45 minutes, between Britain and Zanzibar in 1896.",
  "Wombat poop is cube-shaped. They use it to mark territory.",
  "Bananas are berries, but strawberries are not.",
  "There are more possible chess games than atoms in the observable universe.",
  "Octopuses have three hearts and blue blood.",
  "A bolt of lightning is five times hotter than the surface of the Sun.",
  "The inventor of the Pringles can is now buried in one.",
  "Scotland's national animal is the unicorn.",
  "Lobsters were once considered so undesirable that they were fed to prisoners and servants.",
  "A snail can sleep for three years.",
  "The dot above a lowercase 'i' and 'j' is called a tittle.",
  "Polar bear fur isn't actually white. It's transparent, and looks white because the fur reflects light.",
  "Sharks are older than trees.",
  "If you remove all the empty space from atoms, all of humanity would fit in the volume of a sugar cube.",
  "The average person walks about 100,000 miles in their lifetime, roughly four times around the Earth.",
  "Butterflies taste with their feet.",
  "There's a species of jellyfish that is biologically immortal. It can revert to its juvenile form.",
  "The longest recorded flight of a chicken is 13 seconds.",
  "A group of owls is called a parliament.",
  "Cats are the only domestic animals that don't taste sweetness.",
  "The eiffel tower can be 15cm taller during summer due to thermal expansion.",
  "Sloths take two weeks to digest a single leaf.",
  "A group of cats is called a clowder.",
  "Humans share 60% of their DNA with bananas.",
  "The shortest commercially scheduled flight in the world is 57 seconds, from Westray to Papa Westray in Scotland.",
];

export default {
  name: 'fact',
  aliases: ['funfact', 'weirdfact'],
  description: 'Shares a random interesting fact.',
  usage: '{prefix}fact',
  category: 'fun',

  requiredPermission: null,

  cooldown: 5,

  async execute({ message }) {
    const fact = FACTS[Math.floor(Math.random() * FACTS.length)];

    const embed = new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle('🧠  Random Fact')
      .setDescription(fact)
      .setFooter({ text: `Requested by ${message.author.username}` })
      .setTimestamp();

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
