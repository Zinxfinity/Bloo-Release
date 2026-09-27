import { Events } from '@fluxerjs/core';
import logger from '../../utils/logger.js';
import { reportError } from '../../handlers/errorReporter.js';

export default {
  name: Events.Error,
  once: false,

  async execute(client, error) {
    logger.error('[CLIENT ERROR]', error);
    await reportError('Gateway', { title: 'Client error', error });
  },
};
