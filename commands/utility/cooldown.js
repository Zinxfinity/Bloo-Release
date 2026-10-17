// ============================================================
//  commands/utility/cooldown.js
//  Category : Utility  |  Manage Server (settings), Manage Messages (lift)
//
//  b!cooldown                     show the cooldown and spam settings
//  b!cooldown <3-10> | reset      seconds members wait between uses
//  b!cooldown lockout on|off      lock out repeat spammers after the 1-hour pause
//  b!cooldown staff exempt|include  whether staff are covered by the spam limit
//  b!cooldown lift <@user>        clear someone's spam pause or lockout
//  b!cooldown paused              who is paused or locked out right now
//
//  Cooldown rules live in handlers/commandHandler.js (Gate 3), spam rules
//  in handlers/commandSpam.js. Permissions are checked per subcommand
//  (internalAccess), so b!permissions can only disable this command.
// ============================================================

import { Embed } from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';
import { getCommandCooldown, setCommandCooldown, COOLDOWN_MIN_S, COOLDOWN_MAX_S } from '../../handlers/guildSettings.js';
import { getSpamSettings, setSpamSetting, liftSpam, blockedInGuild, BURST_MAX, BURST_WINDOW_MS } from '../../handlers/commandSpam.js';
import { isBotOwner, isRealOwner, getMemberPermissionBitsLive } from '../../handlers/staffSystem.js';

const explain = s =>
  `Members wait **${s}s** between uses of the same command. ` +
  (s > COOLDOWN_MIN_S
    ? `The server owner and anyone with **Administrator** or **Manage Messages** only wait ${COOLDOWN_MIN_S}s.`
    : `${COOLDOWN_MIN_S}s is the shortest it can be.`) +
  ' Commands with a longer cooldown of their own keep it.';

async function has(client, message, perm) {
  const userId = message.author.id;
  if (isBotOwner(userId) || await isRealOwner(message.guildId, userId)) return true;
  const bits = await getMemberPermissionBitsLive(client, message.guildId, userId);
  return (bits & (perm | Permissions.ADMINISTRATOR)) !== 0n;
}

export default {
  name: 'cooldown',
  description: `Set the command cooldown (${COOLDOWN_MIN_S} to ${COOLDOWN_MAX_S} seconds) and how command spam is handled.`,
  usage: `{prefix}cooldown [${COOLDOWN_MIN_S}-${COOLDOWN_MAX_S} | reset | lockout on|off | staff exempt|include | lift <@user> | paused]`,
  requiredPermission: Permissions.MANAGE_MESSAGES,
  internalAccess: true,
  cooldown: 5,

  async execute({ message, args, prefix, client }) {
    const guildId = message.guildId;
    const P = prefix;
    const sub = args[0]?.toLowerCase();
    const reply = e => message.reply({ embeds: [e.toJSON()] });
    const denied = perm => reply(Embed.denied(`You need the **${perm}** permission for that.`));

    if (!sub) {
      const spam = getSpamSettings(guildId);
      return reply(Embed.info(
        `${explain(getCommandCooldown(guildId))}\n\n` +
        `**Command spam:** more than ${BURST_MAX} commands in ${BURST_WINDOW_MS / 1000}s gets a warning, then pauses of 1, 2, 4, 8... minutes up to an hour. ` +
        (spam.lockout ? 'After that, they\'re **locked out** until staff lift it.' : 'Lockout after the hour is **off**.') +
        ` Staff are **${spam.staffExempt ? 'exempt' : 'included'}**.\n\n` +
        `\`${P}cooldown <${COOLDOWN_MIN_S}-${COOLDOWN_MAX_S}>\` · \`${P}cooldown lockout on|off\` · \`${P}cooldown staff exempt|include\` · \`${P}cooldown lift <@user>\` · \`${P}cooldown paused\``,
        '⏱️ Cooldown and spam'));
    }

    if (sub === 'lift' || sub === 'paused') {
      if (!await has(client, message, Permissions.MANAGE_MESSAGES)) return denied('Manage Messages');
      if (sub === 'paused') {
        const rows = blockedInGuild(guildId);
        return reply(Embed.info(rows.length
          ? rows.map(r => `<@${r.user_id}>: ${r.locked ? 'locked out' : `paused until <t:${Math.floor(r.paused_until / 1000)}:t>`} (strike ${r.strikes})`).join('\n') + `\n\nLift with \`${P}cooldown lift <@user>\`.`
          : 'Nobody is paused or locked out.', '⏳ Paused for command spam'));
      }
      const userId = args[1]?.replace(/[<@!>]/g, '');
      if (!/^\d{5,25}$/.test(userId ?? '')) return reply(Embed.warning(`Usage: \`${P}cooldown lift <@user>\``));
      return reply(liftSpam(guildId, userId)
        ? Embed.success(`<@${userId}> can use commands again, and their spam strikes are cleared.`, '✅ Lifted')
        : Embed.info(`<@${userId}> wasn't paused, locked out or on any strikes.`));
    }

    if (!await has(client, message, Permissions.MANAGE_GUILD)) return denied('Manage Server');

    if (sub === 'lockout') {
      const on = { on: true, off: false }[args[1]?.toLowerCase()];
      if (on === undefined) return reply(Embed.warning(`Usage: \`${P}cooldown lockout on\` or \`off\``));
      setSpamSetting(guildId, 'lockout', on);
      return reply(Embed.success(on
        ? `Anyone who keeps spamming after an hour-long pause is now locked out of commands until staff run \`${P}cooldown lift <@user>\`.`
        : 'Repeat spammers now get another hour-long pause instead of a lockout.', '🔒 Lockout ' + (on ? 'on' : 'off')));
    }

    if (sub === 'staff') {
      const on = { exempt: true, include: false }[args[1]?.toLowerCase()];
      if (on === undefined) return reply(Embed.warning(`Usage: \`${P}cooldown staff exempt\` or \`include\``));
      setSpamSetting(guildId, 'staffExempt', on);
      return reply(Embed.success(on
        ? 'The server owner and anyone with Administrator or Manage Messages are exempt from the spam limit.'
        : 'Staff are covered by the spam limit too. Only bot owners are exempt.', '🛡️ Staff ' + (on ? 'exempt' : 'included')));
    }

    try {
      const s = setCommandCooldown(guildId, sub === 'reset' ? null : Number(sub.replace(/s$/, '')));
      return reply(Embed.success(explain(s), `⏱️ Cooldown set to ${s}s`));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      return reply(Embed.warning(`${err.message} Use \`${P}cooldown reset\` to go back to ${COOLDOWN_MIN_S}s.`));
    }
  },
};
