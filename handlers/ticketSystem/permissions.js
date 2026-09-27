// ─── Ticket channel permission overwrites ──────────────────────────────────────
// Shared by openTicket and reopenTicket in lifecycle.js, both need the same
// "hide from @everyone, allow the opener, allow the support role" overwrite set.

// `option`, when it carries its own support_role_id (per-category routing,
// e.g. "Partners" tickets going to a Partners-specific role instead of the
// general support role), takes priority over the guild-wide
// config.support_role_id rather than adding alongside it, so a category's
// role override actually narrows visibility instead of just widening it.
export function buildTicketOverwrites(guildId, userId, config, option) {
  const overwrites = [
    // Hide from @everyone
    { id: guildId, type: 0, deny: String(1024) },
    // Allow the ticket opener
    { id: userId,  type: 1, allow: String(1024 | 2048 | 65536) },
  ];

  const roleId = option?.support_role_id ?? config?.support_role_id;
  if (roleId) {
    overwrites.push({ id: roleId, type: 0, allow: String(1024 | 2048 | 65536) });
  }

  return overwrites;
}

// ─── lockTicketChannel ────────────────────────────────────────────────────────
// Called on close, before the "closed" notice, denies the ticket opener
// SEND_MESSAGES (2048) while keeping VIEW_CHANNEL + READ_MESSAGE_HISTORY
// (1024 | 65536) so they can still read the closing notice, just not post
// further. Staff keep their own separate role overwrite, so this only
// affects the opener. Best-effort: a failure here shouldn't block closing.
export async function lockTicketChannel(client, channelId, userId) {
  try {
    await client.rest.put(`/channels/${channelId}/permissions/${userId}`, {
      body: { id: userId, type: 1, allow: String(1024 | 65536), deny: String(2048) },
    });
  } catch { /* best effort, channel may already be gone */ }
}
