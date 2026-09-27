import { Events } from '@fluxerjs/core';
import db from '../../db.js';
import { setGuildOwner } from '../../handlers/staffSystem.js';
import logger from '../../utils/logger.js';
import { hasBooted } from '../client/ready.js';

// prefix supplied explicitly, guild_settings' SQL-level DEFAULT 'b!'
// (db.js) is static and can never reflect a changed PREFIX env var.
const ensureGuild = db.prepare(`
  INSERT OR IGNORE INTO guild_settings (guild_id, prefix, updated_at) VALUES (?, ?, unixepoch())
`);

export default {
  name: Events.GuildCreate,
  once: false,

  async execute(client, guild) {
    const guildId = guild.id;

    // GUILD_CREATE fires once per guild during startup hydration too (the
    // client holds READY until every existing guild has streamed in, see
    // Client's waitForGuilds/_pendingGuildIds), so on every restart this
    // fired once per guild the bot was ALREADY in, logged as a fresh "join"
    // with guild.name still undefined (not hydrated yet at this point).
    // client.isReady() can NOT distinguish this: waitForGuilds: true
    // (index.js) means the SDK queues every startup GUILD_CREATE and only
    // flushes them to this handler after Ready has already fired, so
    // isReady() is already true for every one of them, this check was a
    // permanent no-op. hasBooted() (events/client/ready.js) is set
    // synchronously before any of that queued flush can reach here, so it
    // actually distinguishes routine hydration from a genuine later join.
    if (!hasBooted()) {
      ensureGuild.run(guildId, process.env.PREFIX ?? 'b!');
      return;
    }

    // GUILD_CREATE only requires an id, name and owner_id can legitimately
    // be missing from the raw payload (e.g. an availability stub after a
    // brief outage), fall back to a REST fetch for whichever is still
    // missing rather than logging "undefined".
    let guildName = guild.name;
    let ownerId   = guild.ownerId ?? guild.owner_id ?? null;
    if (!guildName || !ownerId) {
      try {
        const fetched = await client.rest.get(`/guilds/${guildId}`);
        guildName = guildName || fetched?.name || guildName;
        ownerId   = ownerId   ?? fetched?.owner_id ?? fetched?.ownerId ?? null;
      } catch { /* best effort */ }
    }

    logger.info(`[GUILD] Joined guild: ${guildName ?? 'Unknown'} (${guildId})`);

    ensureGuild.run(guildId, process.env.PREFIX ?? 'b!');

    if (ownerId) setGuildOwner(guildId, ownerId);
  },
};
