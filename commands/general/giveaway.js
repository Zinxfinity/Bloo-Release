import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import { resolveAccess } from '../../handlers/commandPermissions.js';
import { Permissions } from '../../config/guildPermissions.js';
import {
  createGiveaway, getGiveaway, listGiveaways,
  endGiveaway, rerollGiveaway, postGiveawayEmbed,
  GiveawayError, pauseGiveaway, resumeGiveaway, extendGiveaway, editGiveaway,
  setGiveawayBlacklist, setGiveawayBonus, listGiveawayBonuses, listGiveawayEntries, deleteGiveaway,
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
  description: 'Manage giveaways: create, end, reroll, list, pause, resume, extend, edit, bonus, blacklist, entries, delete.',
  usage: '{prefix}giveaway <create|end|reroll|list> [args]\n{prefix}giveaway <pause|resume> <id>\n{prefix}giveaway extend <id> <30m|2h|3d>\n{prefix}giveaway edit <id> <prize|description|winners|role|level|days|ping> <value>\n{prefix}giveaway bonus <id> @role <extra entries|off>\n{prefix}giveaway blacklist <id> <add|remove> @user\n{prefix}giveaway entries <id>\n{prefix}giveaway delete <id>',
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
    if (['pause', 'resume', 'extend', 'edit', 'bonus', 'blacklist', 'entries', 'delete'].includes(sub)) {
      return handleManage(message, sub, args.slice(1), guildId, prefix);
    }

    await message.reply({ embeds: [Embed.warning(`Unknown subcommand. Use \`${prefix}giveaway create|end|reroll|list|pause|resume|extend|edit|bonus|blacklist|entries|delete\``).toJSON()] });
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

// ─── pause / resume / extend / edit / bonus / blacklist / entries / delete ──
// The dashboard's giveaway controls, by command. All go through
// handlers/giveawaySystem.js, the same functions the dashboard now uses.
async function handleManage(message, sub, args, guildId, prefix) {
  const reply = e => message.reply({ embeds: [e.toJSON()] });
  const id = parseInt(args[0], 10);
  if (!id) return reply(Embed.warning(`Give the giveaway's ID from \`${prefix}giveaway list\`.`));
  const userOf = s => s?.match(/^<@!?(\d+)>$/)?.[1] ?? (/^\d{15,25}$/.test(s ?? '') ? s : null);
  const roleOf = s => s?.match(/^<@&(\d+)>$/)?.[1] ?? (/^\d{15,25}$/.test(s ?? '') ? s : null);
  try {
    if (sub === 'pause') {
      pauseGiveaway(guildId, id);
      return reply(Embed.success(`Giveaway #${id} paused. Nobody can enter, and it won't end until you resume it.`));
    }
    if (sub === 'resume') {
      const gw = resumeGiveaway(guildId, id);
      return reply(Embed.success(`Giveaway #${id} resumed. It now ends <t:${gw.ends_at}:R>, pushed back by the time it was paused.`));
    }
    if (sub === 'extend') {
      const s = parseDuration(args[1]);
      if (!s) return reply(Embed.warning(`Usage: \`${prefix}giveaway extend <id> <30m|2h|3d>\``));
      const gw = extendGiveaway(guildId, id, s);
      return reply(Embed.success(`Giveaway #${id} now ends <t:${gw.ends_at}:R>.`));
    }
    if (sub === 'edit') {
      const field = args[1]?.toLowerCase();
      const raw = args.slice(2).join(' ').trim();
      if (!field || !raw) return reply(Embed.warning(`Usage: \`${prefix}giveaway edit <id> <prize|description|winners|role|level|days|ping> <value>\` (\`off\` clears role, level, days and ping)`));
      const off = raw.toLowerCase() === 'off';
      const value = ['winners', 'level', 'days'].includes(field) ? (off ? null : Number(raw))
        : ['role', 'ping'].includes(field) ? (off ? null : roleOf(raw))
        : raw;
      if (['role', 'ping'].includes(field) && !off && !value) return reply(Embed.warning('Mention a role, or use `off`.'));
      editGiveaway(guildId, id, field, value);
      return reply(Embed.success(`Giveaway #${id}: ${field} ${off ? 'cleared' : 'updated'}. The giveaway message updates on its next refresh.`));
    }
    if (sub === 'bonus') {
      const role = roleOf(args[1]);
      const raw = args[2]?.toLowerCase();
      if (!role || !raw) {
        const list = listGiveawayBonuses(id);
        return reply(Embed.info(list.length ? list.map(b => `<@&${b.role_id}>: +${b.bonus_entries} entr${b.bonus_entries === 1 ? 'y' : 'ies'}`).join('\n') : 'No bonus entries.', `Giveaway #${id} bonus entries`)
          .setFooter({ text: `${prefix}giveaway bonus <id> @role <1-19|off>` }));
      }
      const extra = raw === 'off' ? null : Number(raw);
      setGiveawayBonus(guildId, id, role, extra);
      return reply(Embed.success(extra ? `Members with <@&${role}> get **${extra}** extra entr${extra === 1 ? 'y' : 'ies'} in giveaway #${id}.` : `<@&${role}> no longer gets bonus entries in giveaway #${id}.`));
    }
    if (sub === 'blacklist') {
      const action = args[1]?.toLowerCase();
      const user = userOf(args[2]);
      if (!['add', 'remove'].includes(action) || !user) return reply(Embed.warning(`Usage: \`${prefix}giveaway blacklist <id> <add|remove> @user\``));
      setGiveawayBlacklist(guildId, id, user, action === 'add');
      return reply(Embed.success(action === 'add' ? `<@${user}> can't enter giveaway #${id}, and any entry they had is removed.` : `<@${user}> can enter giveaway #${id} again.`));
    }
    if (sub === 'entries') {
      const entries = listGiveawayEntries(id);
      if (getGiveaway(id)?.guild_id !== guildId) return reply(Embed.warning(`No giveaway #${id} in this server.`));
      const shown = entries.slice(0, 40).map(e => `<@${e.user_id}>${e.bonus ? ` (+${e.bonus})` : ''}`).join(', ');
      return reply(Embed.info(entries.length ? `${shown}${entries.length > 40 ? ` and ${entries.length - 40} more` : ''}` : 'No entries yet.', `Giveaway #${id}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`));
    }
    if (sub === 'delete') {
      const gw = deleteGiveaway(guildId, id);
      return reply(Embed.success(`Giveaway #${id} (**${gw.prize}**) deleted, with its entries. Its message in the channel stays; delete it by hand if you want.`));
    }
  } catch (err) {
    if (err instanceof GiveawayError) return reply(Embed.warning(err.message));
    throw err;
  }
}
