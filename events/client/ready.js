import { Events } from '@fluxerjs/core';
import db from '../../db.js';
import logger from '../../utils/logger.js';
import { bumpGatewayEvent } from '../../handlers/gatewayActivity.js';
import { economyEnabled as isEconomySubsystemEnabled } from '../../config/features.js';
import { siteHost } from '../../config/site.js';

// ─── Boot guard, prevents double-fire on reconnect ──────────────────────────
let _booted = false;

// Exported so events/guild/guildCreate.js can tell a genuine new-guild join
// apart from routine startup hydration. client.isReady() doesn't work for
// this: index.js sets waitForGuilds: true, which per @fluxerjs/core's own
// docs queues every startup GUILD_CREATE and only flushes them to handlers
// AFTER Ready has already fired, so by the time guildCreate.js's handler
// ever runs, isReady() is unconditionally true for every one of them, not
// just genuine post-boot joins. _booted itself is set synchronously as the
// very first line of this handler below, before any await, so it's
// guaranteed true before the SDK's queued-dispatch flush can reach any
// guildCreate.js invocation.
export function hasBooted() {
  return _booted;
}

// ─── Cycling custom status ──────────────────────────────────────────────────
// Rotates through these on a loose 30-60s timer (randomised per tick, not a
// fixed interval, so it doesn't look mechanically exact). Add/remove/reorder
// freely, {guilds} is replaced with the live guild count at each tick. Mostly
// practical hints, with a few in-character lines mixed in so Bloo reads like
// he's actually there, not just a command dispatcher.
const STATUS_MESSAGES = [
  // Helpful
  'Try b!help',
  'Watching over {guilds} servers',
  '{site}',
  'b!ticket for support',
  'b!prefix to change my prefix',
  'b!invite to bring me to another server',
  'b!warnings to check your record',
  'configurable from the dashboard, mostly by me not breaking it',
  // Bloo being Bloo
  'holding {guilds} servers together, mostly on purpose',
  'definitely didn\'t break anything today',
  'chasing a bug that may not even exist',
  'retreating into the vents for a sec',
  'still slime, still standing',
  'thanks for putting up with my bugs 💚',
  'rolled off the shelf again, i\'m fine',
  '99% stable, 1% chaos, as intended',
  'watching for raids like a nervous little blob',
  'no promises about tomorrow',
];

function startStatusCycle(client) {
  let i = 0;
  const tick = () => {
    const text = STATUS_MESSAGES[i % STATUS_MESSAGES.length]
      .replace('{guilds}', client.guilds?.cache?.size ?? client.guilds?.size ?? '?')
      .replace('{site}', siteHost());
    i++;
    try {
      client.user.setPresence({
        status: 'online',
        activities: [{ name: siteHost(), type: 3 }],
        customStatus: { text },
      });
    } catch (err) {
      logger.warn('[READY] Status cycle setPresence failed:', err.message);
    }
    const nextDelay = 30_000 + Math.random() * 30_000; // 30-60s, jittered
    setTimeout(tick, nextDelay);
  };
  tick();
}

export default {
  name: Events.Ready,
  once: false, // client.on(), fires on every reconnect; boot guard handles once-only logic

  async execute(client) {
    if (_booted) {
      logger.info('[READY] Reconnected.');
      return;
    }
    _booted = true;

    logger.info(`[READY] Logged in as ${client.user?.username} (${client.user?.id})`);

    // Bump the watchdog's gateway-activity clock on every raw gateway
    // dispatch (any named event: presence updates, typing, voice state,
    // messages, etc.), not just MessageCreate. A quiet guild can go minutes
    // without a message but still be getting a steady stream of other
    // dispatches, tying "is the socket alive" to message activity alone was
    // producing false-positive WS-silence restarts (see systemd/watchdog-
    // check.mjs's Failsafe 2b) during genuinely quiet stretches.
    client.ws.on('dispatch', bumpGatewayEvent);
    // Dispatches still stop when nothing happens in any server (a quiet night
    // on a small bot), so also count the gateway's heartbeat ACKs, which
    // arrive every ~40s on any live connection. The manager doesn't forward
    // them, so listen on each shard. A dead socket sends neither.
    for (const shard of client.ws.getShards?.().values?.() ?? []) shard.on?.('ping', bumpGatewayEvent);

    // Presence as a live gateway opcode 3 update (client.user.setPresence),
    // not just the Client constructor's `presence` option (index.js), which
    // only ever gets embedded once in the IDENTIFY payload at login. These
    // are two different wire paths, custom_status set only via IDENTIFY
    // wasn't showing up on the bot's profile, this is the other path.
    // Also kicks off the rotating status cycle (STATUS_MESSAGES above).
    startStatusCycle(client);

    // ── 0. Heartbeat, started first and deliberately not awaited in sequence
    // with the rest of boot ──────────────────────────────────────────────────
    // watchdog-check.mjs (Failsafe 2) restarts the process if this file goes
    // stale, treating that as a frozen event loop. seedGuilds() below does a
    // sequential, awaited REST call per guild missing a cached owner ID, and
    // with enough guilds that alone can run past the watchdog's timeout even
    // though the event loop is fine, just busy with legitimate async I/O.
    // Starting the ticker here means it's writing fresh heartbeats within
    // milliseconds of Ready, independent of how long the rest of boot takes,
    // instead of only after every other poller below has already finished.
    await startPoller(client, '../../handlers/heartbeat.js',         'startHeartbeat', process.uptime());

    // ── 1. Seed guild owners and guild_settings ───────────────────────────────
    await seedGuilds(client);

    // ── 2. Start background pollers ───────────────────────────────────────────
    // Each poller is imported dynamically so missing files don't crash boot.
    await startPoller(client, '../../handlers/warnSystem.js',  'startUnbanChecker');
    await startPoller(client, '../../handlers/webhookPoller.js',     'startWebhookPoller');
    await startPoller(client, '../../handlers/giveawaySystem.js',    'startGiveawayPoller');
    await startPoller(client, '../../handlers/advPoll.js',           'startAdvPollPoller');
    await startPoller(client, '../../handlers/xpSystem.js',          'startXpDecay');
    await startPoller(client, '../../handlers/analyticsSystem.js',   'startAnalyticsJob');
    await startPoller(client, '../../handlers/memberCountSync.js',   'syncMemberCountsOnReady', client);
    await startPoller(client, '../../handlers/memberCountSync.js',   'startMemberCountTTL');
    await startPoller(client, '../../handlers/reminderPoller.js',    'startReminderPoller');
    await startPoller(client, '../../handlers/ticketSystem/deletionPoller.js', 'startTicketDeletionPoller', client);
    await startPoller(client, '../../handlers/scheduleSystem.js',    'initSchedule');
    await startPoller(client, '../../handlers/digestJob.js',         'startDigestJob');
    await startPoller(client, '../../handlers/fluxerStatusMonitor.js', 'startFluxerStatusMonitor');
    await startPoller(client, '../../handlers/statusPoller.js',        'startStatusPoller');
    await startPoller(client, '../../handlers/fluxerListReporter.js', 'startFluxerListReporter', client);
    await startPoller(client, '../../handlers/votes.js',              'startVotePoller');
    await startPoller(client, '../../handlers/retiredFeatures.js',    'cleanupRetiredFeatures');
    await startPoller(client, '../../handlers/serverInsights.js',     'startInsights');
    await startPoller(client, '../../handlers/antiRaid/index.js',    'restoreVerifyPanels', client);
    await startPoller(client, '../../handlers/antiRaid/index.js',    'startPanelRepostPoller', client);
    // ECONOMY_ENABLED=false: skip every economy background timer too, not
    // just command loading (handlers/commandLoader.js), so a disabled
    // deployment runs zero economy-related work at all.
    if (isEconomySubsystemEnabled()) {
      await startPoller(client, '../../handlers/economy/stockPoller.js', 'startStockPoller');
      await startPoller(client, '../../handlers/economy/shopPoller.js', 'startShopPoller');
      await startPoller(client, '../../handlers/economy/worldEventPoller.js', 'startWorldEventPoller', client);
      await startPoller(client, '../../handlers/economy/orgs/warPoller.js', 'startWarPoller');
      await startPoller(client, '../../handlers/economy/reputation/decayJob.js', 'startRepDecayJob');
      await startPoller(client, '../../handlers/economy/reputation/decayJob.js', 'startOrgRepJob');
      await startPoller(client, '../../handlers/economy/expedition/poller.js', 'startExpeditionPoller');
    }

    // ── 3. Startup alert ──────────────────────────────────────────────────────
    await startPoller(client, '../../handlers/startupAlert.js', 'postStartupAlert', client);

    logger.info('[READY] Boot complete.');
  },
};

// ─── Seed guild_settings and staff_guild_owners for all cached guilds ─────────
async function seedGuilds(client) {
  const guilds = client.guilds?.cache ?? client.guilds ?? new Map();
  let seeded = 0;

  // prefix supplied explicitly, guild_settings' SQL-level DEFAULT 'b!'
  // (db.js) is static and can never reflect a changed PREFIX env var.
  const insertSettings = db.prepare(`
    INSERT OR IGNORE INTO guild_settings (guild_id, prefix, updated_at)
    VALUES (?, ?, unixepoch())
  `);

  const insertOwner = db.prepare(`
    INSERT OR REPLACE INTO staff_guild_owners (guild_id, user_id)
    VALUES (?, ?)
  `);

  // staff_guild_owners may not exist yet if staffSystem hasn't been imported.
  // Create it here as a safety net, staffSystem.js will use IF NOT EXISTS too.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS staff_guild_owners (
        guild_id TEXT PRIMARY KEY,
        user_id  TEXT NOT NULL
      )
    `);
  } catch { /* already exists */ }

  const needsOwnerFetch = [];
  for (const [guildId, guild] of guilds) {
    insertSettings.run(guildId, process.env.PREFIX ?? 'b!');

    // Resolve owner ID, may be null in cache
    const ownerId = guild?.ownerId ?? guild?.owner_id ?? null;
    if (ownerId) {
      insertOwner.run(guildId, ownerId);
      seeded++;
    } else {
      needsOwnerFetch.push(guildId);
    }
  }

  // Guilds missing a cached owner (in practice, apparently all of them,
  // see guildCreate.js's comment on the same missing-field pattern) get
  // resolved via a live REST call, in small concurrent batches rather than
  // one fully sequential round-trip at a time, previously a single guild's
  // fetch blocked the next guild's fetch behind it, one at a time, for
  // however many hundred guilds needed it.
  const CONCURRENCY = 8;
  for (let i = 0; i < needsOwnerFetch.length; i += CONCURRENCY) {
    const batch = needsOwnerFetch.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async (guildId) => {
      try {
        const fetched = await client.rest.get(`/guilds/${guildId}`);
        const ownerId = fetched?.owner_id ?? fetched?.ownerId ?? null;
        if (ownerId) {
          insertOwner.run(guildId, ownerId);
          seeded++;
        }
      } catch (err) {
        // Real error message logged now, previously swallowed entirely,
        // no way to tell a 429 from a 404 from anything else.
        logger.warn(`[READY] Could not fetch owner for guild ${guildId}: ${err.message}`);
      }
    }));
  }

  logger.info(`[READY] Seeded ${guilds.size} guild(s), resolved ${seeded} owner(s).`);
}

// ─── Safe dynamic poller starter ─────────────────────────────────────────────
// If the handler file doesn't exist yet, silently skips, allows incremental build.
async function startPoller(client, modulePath, exportName, ...args) {
  try {
    const mod = await import(modulePath);
    const fn  = mod[exportName];
    if (typeof fn !== 'function') return;
    await fn(client, ...args);
    logger.debug(`[READY] Started ${exportName}`);
  } catch (err) {
    // MODULE_NOT_FOUND is expected during incremental build, skip silently
    if (err.code === 'ERR_MODULE_NOT_FOUND') return;
    logger.warn(`[READY] ${exportName} failed to start:`, err.message);
  }
}
