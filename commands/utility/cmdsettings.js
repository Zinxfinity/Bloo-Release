// ============================================================
//  commands/utility/cmdsettings.js
//  Category : Utility  |  Manage Server
//
//  b!cmdsettings                        show the settings
//  b!cmdsettings keep on|off            keep members' command messages
//  b!cmdsettings staff on|off           keep staff command messages
//  b!cmdsettings economy on|off         keep economy command messages
//  b!cmdsettings ping on|off            Bloo's replies ping the person
//
//  Deleting is the default for every group; developer commands are always
//  deleted. Stored in handlers/guildSettings.js, applied in
//  handlers/commandHandler.js. Also on the dashboard's Bloo Core page.
// ============================================================

import { Embed } from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';
import { getCommandMessageSettings, setCommandMessageSetting } from '../../handlers/guildSettings.js';
import { isEconomyReleased } from '../../config/features.js';

const KEYS = { keep: 'general', general: 'general', staff: 'staff', economy: 'economy', eco: 'economy', ping: 'ping' };
const ON = ['on', 'yes', 'true', 'keep', 'enable'], OFF = ['off', 'no', 'false', 'delete', 'disable'];

export default {
  name: 'cmdsettings',
  aliases: ['cmdset'],
  description: 'Choose whether Bloo deletes command messages after they run, and whether its replies ping.',
  usage: '{prefix}cmdsettings [keep|staff|economy|ping] [on|off]',
  requiredPermission: Permissions.MANAGE_GUILD,
  cooldown: 3,

  async execute({ message, args, prefix }) {
    const guildId = message.guildId;
    const P = prefix;
    const reply = e => message.reply({ embeds: [e.toJSON()] });
    const ecoOut = await isEconomyReleased();

    const key = KEYS[args[0]?.toLowerCase()];
    const val = args[1]?.toLowerCase();
    if (key) {
      if (key === 'economy' && !ecoOut) return reply(Embed.info('The economy isn\'t released yet. This setting will be here when it is.'));
      if (!ON.includes(val) && !OFF.includes(val)) return reply(Embed.warning(`Usage: \`${P}cmdsettings ${args[0].toLowerCase()} on|off\``));
      const on = ON.includes(val);
      setCommandMessageSetting(guildId, key, on);
      const what = {
        general: on ? 'Members\' command messages now stay in the chat.' : 'Members\' command messages are deleted once they run.',
        staff: on ? 'Staff command messages now stay in the chat.' : 'Staff command messages are deleted once they run.',
        economy: on ? 'Economy command messages now stay in the chat.' : 'Economy command messages are deleted once they run.',
        ping: on ? 'Bloo\'s replies ping the person again.' : 'Bloo still replies, but without pinging the person.',
      }[key];
      return reply(Embed.success(what));
    }

    const s = getCommandMessageSettings(guildId);
    const word = b => b ? '**kept**' : '**deleted**';
    return reply(Embed.info([
      `Members' commands: ${word(s.keep.general)} · \`${P}cmdsettings keep on|off\``,
      `Staff commands: ${word(s.keep.staff)} · \`${P}cmdsettings staff on|off\``,
      ...(ecoOut ? [`Economy commands: ${word(s.keep.economy)} · \`${P}cmdsettings economy on|off\``] : []),
      `Replies ping the person: **${s.replyPing ? 'yes' : 'no'}** · \`${P}cmdsettings ping on|off\``,
      '',
      '-# Staff commands are ones that need a permission to use. Developer commands are always deleted, and so is any command used where commands aren\'t allowed.',
    ].join('\n'), '💬 Command messages'));
  },
};
