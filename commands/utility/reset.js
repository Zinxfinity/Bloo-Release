// ============================================================
//  commands/utility/reset.js
//  Category : Utility  |  Administrator (everything: Server Owner)
//
//  b!reset                       list the areas that can be reset
//  b!reset <area>                show what it would clear
//  b!reset <area> confirm        clear it
//  b!reset all confirm           every area (Server Owner only)
//
//  Settings only; members' records stay. Shared with the dashboard's
//  Reset Settings page (handlers/serverReset.js).
// ============================================================

import { Embed } from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';
import { isBotOwner, isRealOwner } from '../../handlers/staffSystem.js';
import { RESET_AREAS, previewReset, resetArea, ResetError } from '../../handlers/serverReset.js';

export default {
  name: 'reset',
  aliases: ['resetsettings'],
  description: 'Put one area of Bloo\'s settings for this server back to the defaults, or all of them.',
  usage: '{prefix}reset [area] [confirm]',
  requiredPermission: Permissions.ADMINISTRATOR,
  cooldown: 5,

  async execute({ message, args, prefix }) {
    const guildId = message.guildId;
    const P = prefix;
    const reply = e => message.reply({ embeds: [e.toJSON()] });
    const area = args[0]?.toLowerCase();
    const isOwner = isBotOwner(message.author.id) || await isRealOwner(guildId, message.author.id);

    if (!area) {
      const lines = Object.entries(RESET_AREAS).map(([k, a]) => `\`${k}\` ${a.label}${a.ownerOnly ? ' *(Server Owner)*' : ''}`);
      return reply(Embed.info(
        `Pick what to put back to the defaults:\n${lines.join('\n')}\n\`all\` Everything above *(Server Owner)*\n\n` +
        `\`${P}reset <area>\` shows what it clears, then \`${P}reset <area> confirm\` does it.\n` +
        '-# Only settings are cleared. Members keep their XP, warnings, mod cases, tickets and appeals.',
        '🧹 Reset settings'));
    }

    if (area !== 'all' && !RESET_AREAS[area]) return reply(Embed.warning(`There's no area called \`${area}\`. Run \`${P}reset\` to see them.`));
    const a = area === 'all' ? { label: 'Everything', what: 'every setting Bloo has for this server' } : RESET_AREAS[area];

    if (args[1]?.toLowerCase() !== 'confirm') {
      const n = previewReset(guildId, area);
      return reply(Embed.warning(
        `This clears **${a.label}**: ${a.what}.\n\n` +
        (n ? `That's ${n} saved item${n === 1 ? '' : 's'}. It can't be undone.\n\nRun \`${P}reset ${area} confirm\` to go ahead.` : 'Nothing is set there yet, so there\'s nothing to clear.'),
        '🧹 Reset settings'));
    }

    try {
      const { rows } = await resetArea(guildId, area, { isOwner });
      return reply(Embed.success(rows
        ? `**${a.label}** ${area === 'all' ? 'are' : 'is'} back to the defaults (${rows} item${rows === 1 ? '' : 's'} cleared).${area === 'all' || area === 'general' ? ` The prefix is \`b!\` again.` : ''}`
        : `**${a.label}** had nothing set, so nothing changed.`));
    } catch (err) {
      if (err instanceof ResetError) return reply(Embed.denied(err.message));
      throw err;
    }
  },
};
