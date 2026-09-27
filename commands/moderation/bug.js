// ============================================================
//  commands/moderation/bug.js
//
//  Internal bug tracker, separate from !bugreport (that command
//  just fires a webhook post and forgets it, no persistence).
//  Bugs here are ones a user reported through a ticket, staff
//  reviews it and logs a confirmed/worth-tracking bug by hand.
//  Numbered per-guild, like ticket case IDs and modlog cases.
//
//  Deliberately just a counter + description right now, no
//  status/notes/removal workflow, add that later only if it
//  ends up actually needed (e.g. by !bugreport).
//
//  !bug add [@reporter] <description>          , log a new bug (Bot Owner)
//  !bug list                                    , list logged bugs
// ============================================================

import { Embed } from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';
import { isBotOwner } from '../../handlers/staffSystem.js';
import { addBug, listBugs } from '../../handlers/bugTracker.js';

function parseUserId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

function formatBugLine(b) {
  const reporter = b.reporter_id ? `<@${b.reporter_id}>` : 'Unknown';
  const desc = b.description.length > 80 ? `${b.description.slice(0, 80)}…` : b.description;
  return `**#${b.bug_number}**, ${reporter}: ${desc}`;
}

export default {
  name: 'bug',
  aliases: ['bugs', 'bugtrack'],
  description: 'Log bugs found through tickets and list them by number.',
  usage: '{prefix}bug <add | list>',
  category: 'moderation',

  requiredPermission: Permissions.KICK_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    if (!guildId) {
      await message.reply({ embeds: [Embed.danger('Server Only').setDescription('Bug tracking can only be used inside a server.').toJSON()] }).catch(() => {});
      return;
    }

    const [sub, ...rest] = args;
    const subCmd = sub?.toLowerCase();

    if (subCmd === 'add' && !isBotOwner(message.author.id)) {
      await message.reply({ embeds: [Embed.denied('Logging a bug is Bot Owner only.').toJSON()] }).catch(() => {});
      return;
    }

    switch (subCmd) {

      // ── add [@reporter] <description> ────────────────────────
      case 'add': {
        const reporterId  = parseUserId(rest[0]);
        const description = (reporterId ? rest.slice(1) : rest).join(' ').trim();
        if (!description) {
          await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}bug add [@reporter] <description>\``).toJSON()] }).catch(() => {});
          return;
        }
        const bugNumber = addBug(guildId, reporterId, message.author.id, description);
        await message.reply({ embeds: [Embed.success(
          reporterId ? `Reported by <@${reporterId}>.` : description,
          `🐛 Bug #${bugNumber} Logged`
        ).toJSON()] }).catch(() => {});
        return;
      }

      // ── list ─────────────────────────────────────────────────
      case 'list': {
        const bugs = listBugs(guildId);
        if (!bugs.length) {
          await message.reply({ embeds: [Embed.info('No bugs logged yet.').toJSON()] }).catch(() => {});
          return;
        }
        const shown = bugs.slice(0, 20);
        await message.reply({ embeds: [Embed.info(
          shown.map(formatBugLine).join('\n') + (bugs.length > shown.length ? `\n-# ...and ${bugs.length - shown.length} more` : ''),
          '🐛 Logged Bugs'
        ).toJSON()] }).catch(() => {});
        return;
      }

      default:
        await message.reply({ embeds: [Embed.info(
          `\`${PREFIX}bug add [@reporter] <description>\`: log a new bug *(Bot Owner)*\n` +
          `\`${PREFIX}bug list\`: list logged bugs`,
          '🐛 Bug Tracker'
        ).toJSON()] }).catch(() => {});
    }
  },
};
