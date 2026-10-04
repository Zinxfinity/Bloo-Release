import db from '../db.js';
import logger from '../utils/logger.js';

// One-time cleanup for features that have been removed. Runs on every start
// and does nothing once a feature's leftovers are gone.

const API = () => (process.env.FLUXER_API || 'https://api.fluxer.app').replace(/\/+$/, '');

const tableExists = name =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

// Echo (cross-server announcement relay) was retired 2026-10-04 in favour of
// Fluxer's own Announcements. Subscriber channels kept a "Bloo Echo" webhook;
// delete those, then drop the tables. If a webhook can't be reached for any
// reason other than "already gone", keep the tables and try again next start.
async function retireEcho() {
  if (!tableExists('echo_channels') && !tableExists('echo_settings') && !tableExists('echo_subscriptions')) return;

  let pending = 0;
  if (tableExists('echo_channels')) {
    const hooks = db.prepare('SELECT webhook_id, webhook_token FROM echo_channels WHERE webhook_id IS NOT NULL AND webhook_token IS NOT NULL').all();
    for (const h of hooks) {
      try {
        const res = await fetch(`${API()}/webhooks/${h.webhook_id}/${h.webhook_token}`, { method: 'DELETE' });
        if (res.ok || res.status === 404 || res.status === 401) {
          db.prepare('UPDATE echo_channels SET webhook_id = NULL, webhook_token = NULL WHERE webhook_id = ?').run(h.webhook_id);
        } else {
          pending++;
        }
      } catch {
        pending++;
      }
    }
  }
  if (pending) {
    logger.warn(`[RETIRED] Echo: ${pending} relay webhook(s) couldn't be deleted yet, will retry next start.`);
    return;
  }
  db.exec(`
    DROP TABLE IF EXISTS echo_subscriptions;
    DROP TABLE IF EXISTS echo_channels;
    DROP TABLE IF EXISTS echo_settings;
  `);
  logger.info('[RETIRED] Echo: relay webhooks deleted and tables dropped.');
}

export async function cleanupRetiredFeatures() {
  await retireEcho().catch(err => logger.warn(`[RETIRED] Echo cleanup failed: ${err.message}`));
}
