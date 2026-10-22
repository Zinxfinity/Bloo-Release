// ─── b!ticket reopen <case id> ───────────────────────────────────────────────
// Reopens a closed ticket in a fresh channel, back under the category and
// roles it was opened with (handlers/ticketSystem/lifecycle.js reopenTicket).
// Staff only: the same access as the rest of the ticket settings.
import { Embed } from '../../../config/embeds.js';
import { reopenTicket } from '../../../handlers/ticketSystem/index.js';

const REASONS = {
  'not-found':             'No ticket with that case ID. `ticket case <id>` looks one up.',
  'already-open':          'That ticket is already open.',
  'channel-create-failed': 'I couldn\'t create a channel for it. Check I have Manage Channels in the ticket category.',
};

export async function handleReopen({ message, client, prefix, guildId, rest }) {
  const caseId = rest[0]?.trim();
  if (!caseId) {
    await message.reply({ embeds: [Embed.warning(`Usage: \`${prefix}ticket reopen <case id>\``).toJSON()] }).catch(() => {});
    return;
  }
  const result = await reopenTicket(client, guildId, caseId, message.author.id);
  if (!result.ok) {
    await message.reply({ embeds: [Embed.warning(REASONS[result.reason] ?? 'That ticket couldn\'t be reopened.').toJSON()] }).catch(() => {});
    return;
  }
  // Let the opener know where their ticket went.
  await client.rest.post(`/channels/${result.channelId}/messages`, {
    body: { content: `<@${result.ticket.user_id}> your ticket **${result.ticket.case_id}** was reopened by <@${message.author.id}>.`, allowed_mentions: { users: [result.ticket.user_id] } },
  }).catch(() => {});
  await message.reply({ embeds: [Embed.success(`Ticket **${result.ticket.case_id}** reopened in <#${result.channelId}>.`).toJSON()] }).catch(() => {});
}
