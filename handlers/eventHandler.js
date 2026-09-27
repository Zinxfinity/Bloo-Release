import { readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Events } from '@fluxerjs/core';
import logger from '../utils/logger.js';
import * as resilience from './resilience.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const eventsDir = join(__dirname, '..', 'events');

// Every registered event name must be a real @fluxerjs/core gateway event.
// No synthetic/app-level event names are allowed past this point.
const VALID_EVENT_NAMES = new Set(Object.values(Events));

// ─── Load all events ──────────────────────────────────────────────────────────
export async function loadEvents(client) {
  // Remove any previously registered listeners (for hot-reload)
  if (Array.isArray(client._eventListeners)) {
    for (const { eventName, listener, once } of client._eventListeners) {
      const method = once ? 'removeListener' : 'off';
      try { client[method]?.(eventName, listener); } catch { /* ignore */ }
    }
  }
  client._eventListeners = [];

  let loaded  = 0;
  let skipped = 0;

  const subdirs = readdirSync(eventsDir).filter(f =>
    statSync(join(eventsDir, f)).isDirectory()
  );

  for (const subdir of subdirs) {
    const result = await loadCategory(client, subdir);
    loaded  += result.loaded;
    skipped += result.skipped;
  }

  logger.info(`[EVT] Loaded ${loaded} events (${skipped} skipped)`);
  return { loaded, skipped };
}

// ─── Load a single category ───────────────────────────────────────────────────
export async function loadCategory(client, category) {
  const categoryDir = join(eventsDir, category);
  let loaded  = 0;
  let skipped = 0;

  let files;
  try {
    files = readdirSync(categoryDir).filter(f => f.endsWith('.js'));
  } catch {
    logger.warn(`[EVT] Category directory not found: ${category}`);
    return { loaded, skipped };
  }

  for (const file of files) {
    const filePath = join(categoryDir, file);
    const result   = await loadEventFile(client, filePath, category);
    if (result) loaded++;
    else skipped++;
  }

  return { loaded, skipped };
}

// ─── Load a single event file ─────────────────────────────────────────────────
export async function loadEventFile(client, filePath, category = 'unknown') {
  // Cache-bust for hot-reload
  const url = `${pathToFileURL(filePath).href}?t=${Date.now()}`;

  try {
    const mod   = await import(url);
    const event = mod.default;

    if (!event?.name || typeof event.execute !== 'function') {
      logger.warn(`[EVT] Skipping ${filePath}, missing name or execute`);
      return false;
    }

    if (!VALID_EVENT_NAMES.has(event.name)) {
      logger.error(
        `[EVT] ${filePath} declares name "${event.name}", which is not a real ` +
        `@fluxerjs/core Events.* value. Refusing to register.`
      );
      return false;
    }

    // Outer safety net: a synchronous throw or rejected promise from an event
    // file's execute() can never escape here and take down the gateway
    // connection. Individual orchestrator files still use runCritical/runLight
    // internally for finer-grained, per-concern quarantine.
    const listener = (...args) => {
      resilience.runLight(`event.${event.name}`, () => event.execute(client, ...args));
    };
    const method   = event.once ? 'once' : 'on';

    client[method](event.name, listener);
    client._eventListeners ??= [];
    client._eventListeners.push({
      eventName: event.name,
      listener,
      once:      !!event.once,
      category,
      file:      filePath,
    });

    return true;
  } catch (err) {
    logger.error(`[EVT] Failed to load ${filePath}:`, err);
    return false;
  }
}

// ─── Reload all events (hot-reload) ──────────────────────────────────────────
export async function reloadEvents(client, category) {
  if (category) {
    // Remove listeners for this category only
    client._eventListeners = (client._eventListeners ?? []).filter(entry => {
      if (entry.category === category) {
        try { client.off?.(entry.eventName, entry.listener); } catch { /* ignore */ }
        return false;
      }
      return true;
    });

    const result = await loadCategory(client, category);
    logger.info(`[EVT] Reloaded category "${category}": ${result.loaded} loaded, ${result.skipped} skipped`);
    return result;
  }

  return loadEvents(client);
}
