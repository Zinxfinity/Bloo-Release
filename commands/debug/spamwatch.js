// ============================================================
//  commands/debug/spamwatch.js
//  Category : Debug  |  Access: Bot Owner
//
//  b!spamwatch [count]   the latest command-spam strikes across every
//                        server, newest first (handlers/commandSpam.js)
// ============================================================

import { Embed } from '../../config/embeds.js';
import { recentStrikes } from '../../handlers/commandSpam.js';

export default {
  name: 'spamwatch',
  description: 'See the latest command-spam strikes across every server.',
  usage: '{prefix}spamwatch [count]',
  requiredPermission: 'BOT_OWNER',
  cooldown: 0,

  async execute({ message, args, client }) {
    const rows = recentStrikes(Math.min(Number(args[0]) || 15, 30));
    if (!rows.length) return message.reply({ embeds: [Embed.success('No command spam recorded anywhere.', '🚨 Spam watch').toJSON()] });
    const guildName = id => client?.guilds?.cache?.get?.(id)?.name ?? id;
    const lines = rows.map(r =>
      `<t:${Math.floor(r.at / 1000)}:R> <@${r.user_id}> in **${guildName(r.guild_id)}**: strike ${r.strike}, ${r.outcome}${r.commands ? ` (${r.commands})` : ''}`);
    let text = lines.join('\n');
    if (text.length > 4000) text = `${text.slice(0, 3990)}…`;
    return message.reply({ embeds: [Embed.warning(text, `🚨 Spam watch: last ${rows.length}`).toJSON()] });
  },
};
