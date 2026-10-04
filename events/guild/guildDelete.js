import { Events } from '@fluxerjs/core';
import { pruneGuildFeeds } from '../../handlers/webhookPoller.js';
import { recordLeave } from '../../handlers/serverInsights.js';
import logger from '../../utils/logger.js';

// Fires when the bot leaves (or is removed from) a guild. The one reliable
// signal for "the bot actually left", as opposed to a guild merely being
// absent from client.guilds.cache (which also happens transiently right
// after a restart, before hydration finishes, or under the guild cache size
// limit) — see pruneGuildFeeds's own comment for why that distinction
// matters, a cache-presence check here previously caused real data loss.
export default {
  name: Events.GuildDelete,
  once: false,

  async execute(client, guild) {
    const guildId = guild?.id ?? guild;
    if (!guildId) return;
    // An outage marks a server unavailable; Bloo hasn't actually left it.
    if (guild?.unavailable === true) return;
    // First, while the server's settings are still there to look at.
    try {
      recordLeave(guildId, guild?.name);
    } catch (err) {
      logger.warn(`[GUILD] Leave record failed for ${guildId}: ${err.message}`);
    }
    try {
      pruneGuildFeeds(guildId);
      logger.info(`[GUILD] Left guild ${guildId}, RSS/webhook feeds purged.`);
    } catch (err) {
      logger.warn(`[GUILD] Feed cleanup failed for ${guildId}: ${err.message}`);
    }
  },
};
