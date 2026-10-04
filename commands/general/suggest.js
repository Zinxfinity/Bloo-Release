// ============================================================
//  commands/general/suggest.js
//  Category : General  |  Everyone (status/list/delete: Bot Owner)
//
//  b!suggest <idea>                          send an idea to the Bloo team
//  b!suggest status <id> <status> [note]     bot owner: open, planned,
//                                            building, shipped, declined
//  b!suggest list [status]                   bot owner: recent suggestions
//  b!suggest delete <id>                     bot owner: remove one (spam)
//
//  Same records as the dashboard's Developer → Community page; both go
//  through handlers/suggestions.js.
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS, Embed } from '../../config/embeds.js';
import { isBotOwner } from '../../handlers/staffSystem.js';
import {
  STATUSES, MIN_LENGTH, MAX_LENGTH, SuggestionError, createSuggestion, setStatus,
  listSuggestions, deleteSuggestion, suggestionsChannelSet,
} from '../../handlers/suggestions.js';

const OWNER_SUBS = new Set(['status', 'list', 'delete']);
// One submission a minute per person.
const lastSent = new Map();
const short = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);

export default {
  name: 'suggest',
  aliases: ['suggestion', 'idea'],
  description: 'Send an idea for Bloo to the team. Members vote on it in the support server.',
  usage: '{prefix}suggest <your idea>',
  requiredPermission: null,
  cooldown: 0, // submissions have their own, below; owner subcommands have none

  async execute({ message, args, prefix }) {
    const P = prefix ?? 'b!';
    const sub = args[0]?.toLowerCase();
    const reply = embed => message.reply({ embeds: [embed.toJSON ? embed.toJSON() : embed], allowedMentions: { parse: [] } });

    if (sub && OWNER_SUBS.has(sub) && isBotOwner(message.author.id)) {
      try {
        if (sub === 'status') {
          const id = parseInt(String(args[1] ?? '').replace('#', ''), 10);
          const status = args[2]?.toLowerCase();
          if (!id || !STATUSES[status]) {
            return reply(Embed.info(`\`${P}suggest status <id> <${Object.keys(STATUSES).join('|')}> [note]\``));
          }
          const r = await setStatus(id, status, args.slice(3).join(' ') || null);
          const st = STATUSES[status];
          const lines = [
            `#${id} is now ${st.icon} **${st.label}**.`,
            r.dmSent ? 'They\'ve had a DM about it.' : 'Couldn\'t DM them (closed DMs, or nothing new to tell).',
            r.credited ? `${r.suggestion.username} is now a contributor (🏅 on their card).` : null,
            r.creditLine ? `For the changelog entry: \`${r.creditLine}\`` : null,
          ].filter(Boolean);
          return reply(Embed.success(lines.join('\n')));
        }
        if (sub === 'list') {
          const status = args[1]?.toLowerCase();
          if (status && !STATUSES[status]) return reply(Embed.info(`Status must be one of: ${Object.keys(STATUSES).join(', ')}.`));
          const rows = listSuggestions(status ?? null, 15);
          if (!rows.length) return reply(Embed.info(status ? `No ${status} suggestions.` : 'No suggestions yet.'));
          const embed = new EmbedBuilder().setColor(COLORS.INFO)
            .setTitle(status ? `${STATUSES[status].label} suggestions` : 'Recent suggestions')
            .setDescription(rows.map(s => `**#${s.id}** ${STATUSES[s.status]?.icon ?? ''} ${short(s.text.replace(/\n/g, ' '), 90)}\n-# ${s.username} · 👍 ${s.up} 👎 ${s.down}`).join('\n'))
            .setFooter({ text: `${P}suggest status <id> <status> [note]` });
          return reply(embed);
        }
        if (sub === 'delete') {
          const id = parseInt(String(args[1] ?? '').replace('#', ''), 10);
          if (!id) return reply(Embed.info(`\`${P}suggest delete <id>\``));
          return reply((await deleteSuggestion(id)) ? Embed.success(`Deleted #${id} and its post.`) : Embed.warning(`There's no suggestion #${id}.`));
        }
      } catch (err) {
        if (err instanceof SuggestionError) return reply(Embed.warning(err.message));
        throw err;
      }
    }

    const text = args.join(' ').trim();
    if (!text) {
      return reply(new EmbedBuilder().setColor(COLORS.INFO).setTitle('💡 Suggest an idea')
        .setDescription([
          `Got an idea for Bloo? \`${P}suggest <your idea>\` sends it to the team.`,
          suggestionsChannelSet() ? 'It\'s posted in the Bloo support server, where members vote on it.' : null,
          'You\'ll get a DM when it\'s planned, being built, or shipped, and if it ships you\'re credited in the changelog with a 🏅 Contributor badge on your card.',
          '',
          `Between ${MIN_LENGTH} and ${MAX_LENGTH} characters. One idea per suggestion works best.`,
        ].filter(v => v !== null).join('\n')));
    }

    const wait = 60_000 - (Date.now() - (lastSent.get(message.author.id) ?? 0));
    if (wait > 0) return reply(Embed.warning(`One suggestion a minute, please. Try again in ${Math.ceil(wait / 1000)}s.`));

    try {
      const s = await createSuggestion({
        userId: message.author.id,
        username: message.author.globalName || message.author.username,
        guildId: message.guildId ?? null,
        text,
      });
      lastSent.set(message.author.id, Date.now());
      return reply(Embed.success([
        `Thanks! Your idea is in as **suggestion #${s.id}**.`,
        s.message_id ? 'It\'s up in the support server for members to vote on.' : null,
        'You\'ll get a DM when its status changes.',
      ].filter(Boolean).join(' ')));
    } catch (err) {
      if (err instanceof SuggestionError) return reply(Embed.warning(err.message));
      throw err;
    }
  },
};
