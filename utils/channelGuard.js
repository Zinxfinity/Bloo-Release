// A raw channel ID from a command argument can point at any channel the bot
// can see, in any server. Commands that act on a channel by ID have to confirm
// it belongs to the server the command was run in, otherwise staff in one
// server could post to, lock, or purge another server's channels.

// Returns the channel object when it belongs to guildId, otherwise null.
export async function getGuildChannel(client, guildId, channelId) {
  if (!channelId) return null;
  const ch = await client.rest.get(`/channels/${channelId}`).catch(() => null);
  if (!ch || ch.guild_id !== guildId) return null;
  return ch;
}

export async function isChannelInGuild(client, guildId, channelId) {
  return !!(await getGuildChannel(client, guildId, channelId));
}

// ─── Command-wide guard ───────────────────────────────────────────────────────
// Run by handlers/commandHandler.js before every guild command. Returns the
// first argument that names a channel belonging to a DIFFERENT server, or
// null. Covers every command that takes a channel (log channels, starboard,
// welcome, !quote, ...) in one place instead of each remembering to check.
// Every <#channel> mention is checked; bare IDs only when there are 3 or
// fewer of them, since long ID lists are user lists (mass role, mass ban) and
// an ID that isn't a channel at all simply passes.
const CHANNEL_MENTION = /^<#(\d{15,22})>$/;
const BARE_ID = /^\d{15,22}$/;
const channelGuildCache = new Map(); // channelId -> { guildId | null, at }
const CACHE_MS = 10 * 60 * 1000;

async function channelGuildOf(client, channelId) {
  const hit = channelGuildCache.get(channelId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.guildId;
  const ch = await client.rest.get(`/channels/${channelId}`).catch(() => null);
  const guildId = ch?.guild_id ?? null; // null: not a channel we can see (or not a channel)
  channelGuildCache.set(channelId, { guildId, at: Date.now() });
  if (channelGuildCache.size > 5000) channelGuildCache.delete(channelGuildCache.keys().next().value);
  return guildId;
}

export async function findForeignChannelArg(client, guildId, args) {
  const mentions = [], bare = [];
  for (const a of args ?? []) {
    const m = String(a).match(CHANNEL_MENTION);
    if (m) mentions.push(m[1]);
    else if (BARE_ID.test(a)) bare.push(a);
  }
  const candidates = [...mentions, ...(bare.length <= 3 ? bare : [])];
  for (const id of candidates) {
    const owner = await channelGuildOf(client, id);
    if (owner && owner !== guildId) return id;
  }
  return null;
}
