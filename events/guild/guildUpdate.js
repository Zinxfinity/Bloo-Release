import { Events } from '@fluxerjs/core';
import { setGuildOwner } from '../../handlers/staffSystem.js';
import logger from '../../utils/logger.js';

export default {
  name: Events.GuildUpdate,
  once: false,

  async execute(client, oldGuild, newGuild) {
    const guildId    = newGuild.id;
    const oldOwnerId = oldGuild.ownerId ?? oldGuild.owner_id;
    const newOwnerId = newGuild.ownerId ?? newGuild.owner_id;

    if (!newOwnerId || oldOwnerId === newOwnerId) return;

    logger.info(`[GUILD] Ownership transferred in ${guildId}: ${oldOwnerId} → ${newOwnerId}`);
    setGuildOwner(guildId, newOwnerId);
  },
};
