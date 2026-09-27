// ─── Command loader ───────────────────────────────────────────────────────────
// Scans commands/<category>/*.js, registers each default export by name and
// alias on client.commands. Mirrors eventHandler.js's shape (loadX/loadCategory/
// loadFile/reloadX) so both loaders read the same way.
//
// A command can also be a directory containing an index.js (e.g.
// commands/moderation/ticket/index.js), used to split large commands into
// one file per subcommand group while keeping a single command registration.

import { readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import logger from '../utils/logger.js';
import { economyEnabled as isEconomySubsystemEnabled } from '../config/features.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(__dirname, '..', 'commands');

// ─── Load all commands ────────────────────────────────────────────────────────
export async function loadCommands(client) {
  let loaded  = 0;
  let skipped = 0;

  const categories = readdirSync(commandsDir).filter(f =>
    statSync(join(commandsDir, f)).isDirectory()
  );

  for (const category of categories) {
    // ECONOMY_ENABLED=false means the economy game doesn't exist on this
    // bot at all: skip registering its commands entirely rather than
    // loading them and soft-denying at execution time (see enabled.js).
    if (category === 'economy' && !isEconomySubsystemEnabled()) {
      logger.info('[CMD] Economy subsystem disabled (ECONOMY_ENABLED=false), skipping category');
      continue;
    }
    const result = await loadCategory(client, category);
    loaded  += result.loaded;
    skipped += result.skipped;
  }

  logger.info(`[CMD] Loaded ${loaded} commands (${skipped} skipped)`);
  return { loaded, skipped };
}

// ─── Load a single category ───────────────────────────────────────────────────
export async function loadCategory(client, category) {
  // Also enforced here (not just in loadCommands' loop above) so a manual
  // `!reload economy` can't re-register economy commands behind the
  // master toggle's back.
  if (category === 'economy' && !isEconomySubsystemEnabled()) {
    return { loaded: 0, skipped: 0 };
  }

  const categoryDir = join(commandsDir, category);
  let loaded  = 0;
  let skipped = 0;

  let entries;
  try {
    entries = readdirSync(categoryDir);
  } catch {
    return { loaded, skipped, error: `Category "${category}" not found.` };
  }

  for (const entry of entries) {
    const entryPath = join(categoryDir, entry);
    const isDir     = statSync(entryPath).isDirectory();

    let filePath;
    if (isDir) {
      const indexPath = join(entryPath, 'index.js');
      if (!statSync(indexPath, { throwIfNoEntry: false })) continue; // not a command directory
      filePath = indexPath;
    } else if (entry.endsWith('.js')) {
      filePath = entryPath;
    } else {
      continue;
    }

    const result = await loadCommandFile(client, filePath, category);
    if (result) loaded++;
    else skipped++;
  }

  return { loaded, skipped };
}

// ─── Load a single command file ───────────────────────────────────────────────
export async function loadCommandFile(client, filePath, category = 'unknown') {
  // Cache-bust so hot-reload (commands/debug/reload.js) actually re-evaluates the module.
  const url = `${pathToFileURL(filePath).href}?t=${Date.now()}`;

  try {
    const mod     = await import(url);
    const command = mod.default;

    if (!command?.name || typeof command.execute !== 'function') {
      logger.warn(`[CMD] Skipping ${filePath}, missing name or execute`);
      return false;
    }

    command.category    = category;
    command.quarantined ??= false;

    // Remove any prior registration of this command (by name or alias) before re-registering.
    for (const [key, cmd] of client.commands) {
      if (cmd.name === command.name) client.commands.delete(key);
    }

    client.commands.set(command.name, command);
    if (Array.isArray(command.aliases)) {
      for (const alias of command.aliases) {
        client.commands.set(alias, command);
      }
    }

    return true;
  } catch (err) {
    logger.error(`[CMD] Failed to load ${filePath}:`, err);
    return false;
  }
}

// ─── Reload commands (hot-reload) ────────────────────────────────────────────
export async function reloadCommands(client, category) {
  if (category) {
    return loadCategory(client, category);
  }
  return loadCommands(client);
}
