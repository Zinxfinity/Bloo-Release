// ─── !ticket type <keyword> ─────────────────────────────────────────────────
// Manually recategorize the current (open) ticket to a different, already-
// configured option, e.g. a Support ticket that's actually a Partner
// inquiry. Must be run inside the ticket's own channel. Staff-only (same
// access rule as !ticket close/handleCloseReaction), the target category
// must already exist, this never creates one on the fly.

import { Embed } from '../../../config/embeds.js';
import { resolveAccess } from '../../../handlers/commandPermissions.js';
import { Permissions } from '../../../config/guildPermissions.js';
import {
  getTicketByChannel, getTicketOptions, normalizeKeyword, recategorizeTicket,
} from '../../../handlers/ticketSystem/index.js';

function categorySlugFromCaseId(caseId) {
  const match = String(caseId ?? '').match(/^Ticket-([A-Za-z0-9]+)-\d+$/);
  return match ? match[1].toLowerCase() : null;
}

export async function handleType({ message, client, guildId, prefix, rest }) {
  const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';
  const channelId = message.channelId;

  const ticket = getTicketByChannel(channelId);
  if (!ticket || ticket.guild_id !== guildId || ticket.status !== 'open') {
    await message.reply({ embeds: [Embed.warning('This only works inside an open ticket channel.').toJSON()] }).catch(() => {});
    return;
  }

  const allowed = await resolveAccess(client, guildId, message.author.id, 'ticket.type', Permissions.KICK_MEMBERS);
  if (!allowed) {
    await message.reply({ embeds: [Embed.denied('Staff only.').toJSON()] }).catch(() => {});
    return;
  }

  const options = getTicketOptions(guildId);
  const input = rest.join(' ').trim().toLowerCase();

  if (!input) {
    await message.reply({ embeds: [Embed.info(
      options.length
        ? options.map(o => `${o.emoji} **${o.label}** \`${normalizeKeyword(o.keyword, o.label)}\``).join('\n')
        : 'No categories configured yet.',
      `Usage: ${PREFIX}ticket type <keyword>`
    ).toJSON()] }).catch(() => {});
    return;
  }

  const matchedOption = options.find(o =>
    normalizeKeyword(o.keyword, o.label) === input ||
    o.label.toLowerCase() === input ||
    o.emoji === input
  );
  if (!matchedOption) {
    await message.reply({ embeds: [Embed.warning(
      `No ticket category matches \`${input}\`.\nExisting categories: ${options.map(o => normalizeKeyword(o.keyword, o.label)).join(', ') || 'none configured'}`
    ).toJSON()] }).catch(() => {});
    return;
  }

  const currentSlug = categorySlugFromCaseId(ticket.case_id);
  if (normalizeKeyword(matchedOption.keyword, matchedOption.label) === currentSlug) {
    await message.reply({ embeds: [Embed.info(`This ticket is already categorized as **${matchedOption.label}**.`).toJSON()] }).catch(() => {});
    return;
  }

  const result = await recategorizeTicket(client, guildId, ticket, matchedOption);
  if (!result.ok) {
    await message.reply({ embeds: [Embed.danger('Could not recategorize this ticket.').toJSON()] }).catch(() => {});
    return;
  }

  await message.reply({ embeds: [Embed.success(
    `Case \`${result.newCaseId}\` (was \`${result.oldCaseId}\`).`,
    `🔀 Recategorized to ${matchedOption.label}`
  ).toJSON()] }).catch(() => {});
}
