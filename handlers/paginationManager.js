// ─── Reaction-based pagination manager ───────────────────────────────────────
// Sessions are keyed by messageId. Each holds the page embeds, current index,
// the author who can control it, and a rolling 60s inactivity timer.

const PREV       = '◀';
const NEXT       = '▶';
const TIMEOUT_MS = 60_000;

// Map<messageId, { client, channelId, authorId, pages, page, timer }>
const sessions = new Map();

// ─── Internals ────────────────────────────────────────────────────────────────
async function putReaction(client, channelId, messageId, emoji) {
  await client.rest.put(
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
  ).catch(() => {});
}

async function deleteReaction(client, channelId, messageId, emoji, userId) {
  await client.rest.delete(
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/${userId}`
  ).catch(() => {});
}

async function clearAllReactions(client, channelId, messageId) {
  await client.rest.delete(
    `/channels/${channelId}/messages/${messageId}/reactions`
  ).catch(() => {});
}

async function editEmbed(client, channelId, messageId, embedJson) {
  await client.rest.patch(
    `/channels/${channelId}/messages/${messageId}`,
    { body: { embeds: [embedJson] } }
  ).catch(() => {});
}

function resetTimer(messageId) {
  const s = sessions.get(messageId);
  if (!s) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(async () => {
    const session = sessions.get(messageId);
    if (!session) return;
    sessions.delete(messageId);

    // Stamp the current page embed with a timeout notice in the footer
    const current = session.pages[session.page];
    const updated = { ...current, footer: { text: 'Session timed out. Run the command again to browse.' } };
    await editEmbed(session.client, session.channelId, messageId, updated);
    await clearAllReactions(session.client, session.channelId, messageId);
  }, TIMEOUT_MS);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a paginated message. Adds ◀ / ▶ reactions and starts the 60s timer.
 * pages is an array of embed JSON objects (toJSON() output).
 */
export async function registerPagination(client, channelId, messageId, authorId, pages) {
  if (pages.length <= 1) return;

  sessions.set(messageId, { client, channelId, authorId, pages, page: 0, timer: null });

  await putReaction(client, channelId, messageId, PREV);
  await putReaction(client, channelId, messageId, NEXT);
  resetTimer(messageId);
}

/**
 * Call from the reaction add event. Returns true if the reaction was consumed
 * by pagination (caller should stop processing it further).
 */
export async function handlePaginationReaction(reaction, userId) {
  const messageId = reaction.message_id ?? reaction.messageId;
  const session   = sessions.get(messageId);
  if (!session) return false;

  // Only the original requester controls the pages
  if (userId !== session.authorId) return false;

  const raw   = reaction.emoji?.name ?? reaction.emoji ?? '';
  const emoji = raw.replace(/️/g, ''); // strip variation selector
  if (emoji !== PREV && emoji !== NEXT) return false;

  const channelId = reaction.channel_id ?? reaction.channelId;

  // Remove the user's reaction so they can click again
  await deleteReaction(session.client, channelId, messageId, emoji, userId);

  const newPage = emoji === PREV
    ? Math.max(0, session.page - 1)
    : Math.min(session.pages.length - 1, session.page + 1);

  if (newPage !== session.page) {
    session.page = newPage;
    await editEmbed(session.client, channelId, messageId, session.pages[newPage]);
  }

  resetTimer(messageId);
  return true;
}
