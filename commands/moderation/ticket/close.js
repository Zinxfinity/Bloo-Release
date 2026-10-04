// ─── !ticket close [reason] ─────────────────────────────────────────────────────
// Public, ticket owner or Mod+ only (checked internally). Staff can also close
// by case ID when the channel no longer exists: !ticket close <caseId> [reason]

import { Embed } from '../../../config/embeds.js';
import { resolveAccess } from '../../../handlers/commandPermissions.js';
import { Permissions } from '../../../config/guildPermissions.js';
import {
  getTicketByChannel, getTicketByCase, closeTicketWithNotice, canCloseTicket, closeRequirementText,
} from '../../../handlers/ticketSystem/index.js';

export async function handleClose({ message, client, prefix, guildId, rest }) {
  const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';
  const channelId = message.channelId;
  // Same check and per-guild `close` override as the standalone !close.
  const isMod = await resolveAccess(client, guildId, message.author.id, 'close', Permissions.KICK_MEMBERS);
  let ticket = getTicketByChannel(channelId);

  if (!ticket && rest[0] && isMod) {
    const lookedUp = getTicketByCase(guildId, rest[0]);
    if (lookedUp) {
      ticket = lookedUp;
      rest   = rest.slice(1);
    }
  }

  if (!ticket) {
    await message.reply({ embeds: [Embed.info('Not a Ticket')
      .setDescription(
        'This is not a ticket channel.\n\n' +
        `-# If the channel was deleted, staff can run \`${PREFIX}ticket close <caseId> [reason]\` to close by case ID.`
      ).toJSON()] }).catch(() => {});
    return;
  }
  if (ticket.status === 'closed') {
    await message.reply({ embeds: [Embed.info('Already Closed').setDescription('This ticket is already closed.').toJSON()] }).catch(() => {});
    return;
  }

  if (!isMod && !await canCloseTicket(client, guildId, ticket, message.author.id)) {
    await message.reply({
      embeds: [Embed.denied("Can't close this ticket")
        .setDescription(closeRequirementText(guildId, ticket))
        .toJSON()],
      allowedMentions: { parse: [] },
    });
    return;
  }

  const reason = rest.join(' ') || 'No reason provided';
  await closeTicketWithNotice(client, guildId, ticket, message.author, reason);
}
