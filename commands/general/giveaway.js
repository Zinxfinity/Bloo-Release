import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import { resolveAccess } from '../../handlers/commandPermissions.js';
import { Permissions } from '../../config/guildPermissions.js';
import {
  createGiveaway, getGiveaway, listGiveaways,
  endGiveaway, rerollGiveaway, postGiveawayEmbed,
} from '../../handlers/giveawaySystem.js';

function parseDuration(str) {
  const match = str?.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const units = { s: 1, m: 60, h: 3600, d: 86400 };
  return parseInt(match[1], 10) * units[match[2].toLowerCase()];
}

export default {
  name: 'giveaway',
  aliases: ['gw'],
  description: 'Manage giveaways. Subcommands: create, end, reroll, list.',
  usage: '{prefix}giveaway <create|end|reroll|list> [args]',
  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 5,

  async execute({ message, args, prefix, client }) {
    const guildId    = message.guildId;
    const executorId = message.author.id;
    const sub        = args[0]?.toLowerCase();

    if (!sub || sub === 'list') return handleList(message, guildId, prefix);
    if (sub === 'create') return handleCreate(client, message, args.slice(1), guildId, executorId, prefix);
    if (sub === 'end')    return handleEnd(client, message, args.slice(1), guildId, executorId);
    if (sub === 'reroll') return handleReroll(client, message, args.slice(1), guildId, executorId);

    await message.reply({ embeds: [Embed.warning(`Unknown subcommand. Use \`${prefix}giveaway create|end|reroll|list\``).toJSON()] });
  },
};

async function handleCreate(client, message, args, guildId, executorId, prefix) {
  // Usage: !giveaway create <duration> <winners> <prize...>
  // Example: !giveaway create 1h 2 Nitro Classic
  if (args.length < 3) {
    return message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}giveaway create <duration> <winners> <prize>\``).toJSON()] });
  }

  const durationS = parseDuration(args[0]);
  if (!durationS) {
    return message.reply({ embeds: [Embed.danger('Invalid duration. Examples: `10m`, `2h`, `7d`').toJSON()] });
  }

  const winnerCount = parseInt(args[1], 10);
  if (!winnerCount || winnerCount < 1 || winnerCount > 20) {
    return message.reply({ embeds: [Embed.danger('Winner count must be 1–20.').toJSON()] });
  }

  const prize   = args.slice(2).join(' ');
  const endsAt  = Math.floor(Date.now() / 1000) + durationS;

  const id = createGiveaway({
    guildId,
    channelId:   message.channelId,
    hostId:      executorId,
    prize,
    winnerCount,
    endsAt,
  });

  await postGiveawayEmbed(client, id);
  await message.reply({ embeds: [Embed.success(`Giveaway created for **${prize}**!`).toJSON()] });
}

async function handleEnd(client, message, args, guildId, executorId) {
  const id = parseInt(args[0], 10);
  if (!id) return message.reply({ embeds: [Embed.warning('Provide a giveaway ID.').toJSON()] });

  const gw = getGiveaway(id);
  if (!gw || gw.guild_id !== guildId) {
    return message.reply({ embeds: [Embed.danger('Giveaway not found.').toJSON()] });
  }

  if (gw.host_id !== executorId && !await resolveAccess(client, guildId, executorId, 'giveaway', Permissions.KICK_MEMBERS)) {
    return message.reply({ embeds: [Embed.denied('Only the host or Kick Members or higher can end this giveaway.').toJSON()] });
  }

  const winners = await endGiveaway(client, id);
  if (winners === null) {
    return message.reply({ embeds: [Embed.danger('Giveaway already ended or cancelled.').toJSON()] });
  }

  const mention = winners.length ? winners.map(u => `<@${u}>`).join(', ') : 'No valid entries';
  await message.reply({ embeds: [Embed.success(`Giveaway ended. Winner(s): ${mention}`).toJSON()] });
}

async function handleReroll(client, message, args, guildId, executorId) {
  const id = parseInt(args[0], 10);
  if (!id) return message.reply({ embeds: [Embed.warning('Provide a giveaway ID to reroll.').toJSON()] });

  const gw = getGiveaway(id);
  if (!gw || gw.guild_id !== guildId) {
    return message.reply({ embeds: [Embed.danger('Giveaway not found.').toJSON()] });
  }

  const winners = await rerollGiveaway(client, id);
  if (!winners) return message.reply({ embeds: [Embed.danger('Giveaway has not ended yet.').toJSON()] });

  const mention = winners.length ? winners.map(u => `<@${u}>`).join(', ') : 'No valid entries';
  await message.reply({ embeds: [Embed.success(`Rerolled! New winner(s): ${mention}`).toJSON()] });
}

async function handleList(message, guildId, prefix) {
  const giveaways = listGiveaways(guildId);
  if (!giveaways.length) {
    return message.reply({ embeds: [Embed.info('No giveaways found.').toJSON()] });
  }

  const lines = giveaways.slice(0, 10).map(gw =>
    `**#${gw.id}**: ${gw.prize} | ${gw.status} | ends <t:${gw.ends_at}:R>`
  );

  const embed = new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle('Giveaways')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Use ${prefix}giveaway end <id> to end one early.` });

  await message.reply({ embeds: [embed.toJSON()] });
}
