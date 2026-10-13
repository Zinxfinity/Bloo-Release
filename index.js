import 'dotenv/config';
import './config/envClean.js';
import { Client } from '@fluxerjs/core';
import logger from './utils/logger.js';
import { loadCommands } from './handlers/commandLoader.js';
import { loadEvents } from './handlers/eventHandler.js';
import { postShutdownAlert } from './handlers/startupAlert.js';
import { reportError } from './handlers/errorReporter.js';
import { siteHost } from './config/site.js';

// ─── Validate critical env vars ───────────────────────────────────────────────
if (!process.env.FLUXER_BOT_TOKEN) {
  logger.error('FLUXER_BOT_TOKEN is not set. Exiting.');
  process.exit(1);
}

// ─── Create client ────────────────────────────────────────────────────────────
export const client = new Client({
  intents: 0,
  suppressIntentWarning: true,
  // Delays Ready until every guild from the READY payload has actually
  // streamed in via its own GUILD_CREATE (queuing other dispatches until
  // then), instead of firing Ready immediately and letting GUILD_CREATE for
  // already-known guilds arrive afterward. Without this, client.isReady()
  // is already true by the time those fire, so events/guild/guildCreate.js's
  // "is this a genuine new join" check can't tell hydration apart from a
  // real join at all, the exact bug behind the "Joined guild: undefined"
  // startup log spam.
  waitForGuilds: true,
  presence: {
    status: 'online',
    activities: [{ name: siteHost(), type: 3 }],
    custom_status: { text: 'Try b!help' },
  },
  // guilds and channels are unbounded on purpose. The library drops events
  // (member joins, member updates) for any server it has pushed out of the
  // guild cache, so a 200 cap silently broke the captcha, welcome messages
  // and auto-role in every server past the 200th.
  cache: {
    guilds:   Infinity,
    users:    10_000,
    channels: Infinity,
    messages: 50,
  },
  gatewayDebug:        false,
  gatewayDeferHandlers: true,
});

// ─── Command registry ─────────────────────────────────────────────────────────
client.commands = new Map();

// ─── Reconnect loop with exponential backoff ──────────────────────────────────
const MAX_ATTEMPTS   = parseInt(process.env.WS_MAX_ATTEMPTS  ?? '3', 10);
const BASE_DELAY_MS  = parseInt(process.env.WS_BASE_DELAY_MS ?? '2000', 10);
const LOGIN_TIMEOUT  = parseInt(process.env.WS_LOGIN_TIMEOUT ?? '10000', 10);
const MAX_DELAY_MS   = 30_000;

async function connect() {
  let attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    logger.info(`[WS] Connection attempt ${attempt}/${MAX_ATTEMPTS}`);

    try {
      await Promise.race([
        client.login(process.env.FLUXER_BOT_TOKEN),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Login timeout')), LOGIN_TIMEOUT)
        ),
      ]);

      logger.info('[WS] Connected successfully');
      return; // success, exit loop
    } catch (err) {
      const msg  = err.message ?? '';
      const code = err.code ?? err.statusCode ?? 0;

      // Auth errors, no point retrying
      const isAuthError = code === 401
        || code === 4004
        || code === 4014
        || msg.includes('401')
        || msg.toLowerCase().includes('invalid token');

      if (isAuthError) {
        logger.error('[WS] Authentication failed, check FLUXER_BOT_TOKEN. Exiting.');
        process.exit(1);
      }

      logger.warn(`[WS] Attempt ${attempt} failed: ${msg}`);

      if (attempt >= MAX_ATTEMPTS) {
        logger.error('[WS] All connection attempts exhausted. Exiting (systemctl will restart).');
        process.exit(1);
      }

      // Promise.race doesn't cancel the loser: on a timeout, client.login()
      // from this attempt is still running in the background, so the client
      // is left in a "logging in" state. Without resetting it here, the next
      // attempt's client.login() fails immediately with "Client is already
      // logged in. Call destroy() first.", not a real retry of the network
      // condition at all, guaranteeing every attempt after a timeout burns
      // itself on stale state instead of getting a genuine second chance.
      try {
        await client.destroy();
      } catch (destroyErr) {
        logger.warn(`[WS] destroy() before retry failed: ${destroyErr.message}`);
      }

      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
      logger.info(`[WS] Retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─── Unhandled rejection safety net ──────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('[PROCESS] Unhandled rejection:', reason);
  reportError('Process', { title: 'Unhandled rejection', error: reason instanceof Error ? reason : new Error(String(reason)) });
});

process.on('uncaughtException', (err) => {
  logger.error('[PROCESS] Uncaught exception:', err);
  reportError('Process', { title: 'Uncaught exception', error: err });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Covers `systemctl stop bloo` and `systemctl restart bloo` (both send SIGTERM
// first), plus Ctrl+C during a manual run. Not reached on a hard crash, those
// exit before a handler ever runs, and the next boot's restart detection in
// startupAlert.js covers that case instead.
let _shuttingDown = false;
async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  logger.info(`[PROCESS] Received ${signal}, shutting down.`);
  try {
    await postShutdownAlert(client);
  } catch (err) {
    logger.warn('[PROCESS] Shutdown alert failed:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  // Import db to ensure WAL + schema runs before any handler needs it
  await import('./db.js');

  await loadCommands(client);
  await loadEvents(client);
  await connect();
})();
