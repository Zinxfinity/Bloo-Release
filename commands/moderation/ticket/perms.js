// ─── Ticket opener permissions ────────────────────────────────────────────────
// !ticket perms                        , what openers can do by default
// !ticket perms <attach|embed|react> <on|off>
//                                      , change the server default (new tickets)
// !ticket allow <attach|embed|react>   , in a ticket: let its opener do it
// !ticket deny <attach|embed|react>    , in a ticket: stop its opener doing it
//
// allow/deny only change the ticket they're run in, and never need a name:
// they always apply to whoever opened that ticket. Staff only: the ticket's
// support roles, or whoever meets the close requirement (Kick Members by
// default), but not the opener themselves.

import { Embed } from '../../../config/embeds.js';
import { resolveAccess } from '../../../handlers/commandPermissions.js';
import { Permissions } from '../../../config/guildPermissions.js';
import {
  getTicketByChannel, getTicketConfig, setTicketField, ticketSupportRoles,
  TICKET_PERMS, ticketPermKey, openerPermKeys, setOpenerPerm,
} from '../../../handlers/ticketSystem/index.js';

const list = () => Object.entries(TICKET_PERMS).map(([k, p]) => `\`${k}\` (${p.label.toLowerCase()})`).join(', ');

export async function handlePerms({ message, guildId, prefix, rest }) {
  const P = prefix ?? 'b!';
  const reply = e => message.reply({ embeds: [e.toJSON()] }).catch(() => {});
  const config = getTicketConfig(guildId);
  const current = openerPermKeys(config);
  const key = ticketPermKey(rest[0]);
  const val = rest[1]?.toLowerCase();

  if (!rest.length) {
    return reply(Embed.info([
      'Everyone who opens a ticket can see it, send messages and read the history. On top of that:',
      '',
      ...Object.entries(TICKET_PERMS).map(([k, p]) => `${current.includes(k) ? '✅' : '❌'} **${p.label}** \`${k}\``),
      '',
      `Change the default for new tickets: \`${P}ticket perms <${Object.keys(TICKET_PERMS).join('|')}> <on|off>\``,
      `Change it for one ticket, from inside it: \`${P}ticket allow attach\` or \`${P}ticket deny attach\``,
    ].join('\n'), '🎫 What ticket openers can do'));
  }
  if (!key || !['on', 'off'].includes(val)) {
    return reply(Embed.warning(`Usage: \`${P}ticket perms <permission> <on|off>\`\nPermissions: ${list()}`));
  }
  const next = new Set(current);
  if (val === 'on') next.add(key); else next.delete(key);
  setTicketField(guildId, 'opener_perms', Object.keys(TICKET_PERMS).filter(k => next.has(k)).join(','));
  return reply(Embed.success(`${TICKET_PERMS[key].label} is now **${val}** for people opening new tickets. Tickets that are already open keep what they had; change one with \`${P}ticket ${val === 'on' ? 'allow' : 'deny'} ${key}\` inside it.`));
}

export async function handleAllowDeny({ message, client, guildId, prefix, subCmd, rest }) {
  const P = prefix ?? 'b!';
  const reply = e => message.reply({ embeds: [e.toJSON()] }).catch(() => {});
  const ticket = getTicketByChannel(message.channelId);
  if (!ticket || ticket.guild_id !== guildId || ticket.status !== 'open') {
    return reply(Embed.warning('Run this inside an open ticket. It changes what that ticket\'s opener can do.'));
  }
  // Staff only, and not the opener granting themselves extras.
  const userId = message.author.id;
  let staff = false;
  if (userId !== ticket.user_id) {
    const roles = ticketSupportRoles(guildId, ticket);
    if (roles.length) {
      const member = await client.rest.get(`/guilds/${guildId}/members/${userId}`).catch(() => null);
      staff = Array.isArray(member?.roles) && roles.some(r => member.roles.includes(r));
    }
    if (!staff) staff = await resolveAccess(client, guildId, userId, 'close', Permissions.KICK_MEMBERS);
  }
  if (!staff) return reply(Embed.denied('Only support staff can change what a ticket\'s opener can do.'));

  const key = ticketPermKey(rest[0]);
  if (!key) return reply(Embed.warning(`Usage: \`${P}ticket ${subCmd} <permission>\`\nPermissions: ${list()}`));
  const on = subCmd === 'allow';
  try {
    await setOpenerPerm(client, message.channelId, ticket.user_id, key, on);
  } catch (err) {
    return reply(Embed.warning(`Couldn't change the channel's permissions: ${err.message}. Bloo needs Manage Channels (or Manage Roles) here.`));
  }
  return reply(Embed.success(`<@${ticket.user_id}> can ${on ? 'now' : 'no longer'} ${TICKET_PERMS[key].label.toLowerCase()} in this ticket.`));
}
