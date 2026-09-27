import { Events } from '@fluxerjs/core';
import { purgeGuild } from '../../handlers/echoSystem.js';
import { pruneGuildFeeds } from '../../handlers/webhookPoller.js';
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
    try {
      purgeGuild(guildId);
      logger.info(`[GUILD] Left guild ${guildId}, echo channels/subscriptions purged.`);
    } catch (err) {
      logger.warn(`[GUILD] Echo cleanup failed for ${guildId}: ${err.message}`);
    }
    try {
      pruneGuildFeeds(guildId);
      logger.info(`[GUILD] Left guild ${guildId}, RSS/webhook feeds purged.`);
    } catch (err) {
      logger.warn(`[GUILD] Feed cleanup failed for ${guildId}: ${err.message}`);
    }
  },
};
