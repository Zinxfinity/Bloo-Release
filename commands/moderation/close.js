import { Embed }        from '../../config/embeds.js';
import { getTicketByChannel, closeTicketWithNotice } from '../../handlers/ticketSystem/index.js';
import { Permissions }          from '../../config/guildPermissions.js';
import { resolveAccess }        from '../../handlers/commandPermissions.js';

export default {
  name: 'close',
  aliases: ['closeticket'],
  description: 'Close the current ticket channel.',
  usage: '{prefix}close [reason]',

  requiredPermission: null,
  internalAccess: true, // subcommands gate themselves via resolveAccess

  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX     = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId    = message.guildId;
    const channelId  = message.channelId;

    const ticket = getTicketByChannel(channelId);

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

    const isOwner = ticket.user_id === message.author.id;
    const isMod   = isOwner ? true : await resolveAccess(client, guildId, message.author.id, 'close', Permissions.KICK_MEMBERS);

    if (!isOwner && !isMod) {
      await message.reply({ embeds: [Embed.denied('Ticket Owner or Mod+')
        .setDescription('Only the person who opened this ticket, or a **Mod+**, can close it.')
        .toJSON()] });
      return;
    }

    const reason = args.join(' ') || 'No reason provided';
    // No delay override: closeTicketWithNotice uses the guild's close_delay_seconds,
    // same as !ticket close and the close reaction (this used to force 10s).
    await closeTicketWithNotice(client, guildId, ticket, message.author, reason);
  },
};
