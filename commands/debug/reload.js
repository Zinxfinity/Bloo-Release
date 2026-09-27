import { readdirSync }        from 'fs';
import { join, dirname }      from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Embed }              from '../../config/embeds.js';
import logger                 from '../../utils/logger.js';
import { reloadCommands }     from '../../handlers/commandLoader.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const handlersDir  = join(__dirname, '..', '..', 'handlers');

// ─── Handlers hot-reload (cache-busted re-import, best effort) ───────────────
async function reloadHandlers(name) {
  let files;
  try {
    files = readdirSync(handlersDir).filter(f => f.endsWith('.js'));
  } catch {
    return { loaded: 0, skipped: 0, error: 'Handlers directory not found.' };
  }

  if (name) {
    const match = files.find(f => f.replace('.js', '').toLowerCase() === name.toLowerCase());
    if (!match) return { loaded: 0, skipped: 0, error: `Handler "${name}" not found.` };
    files = [match];
  }

  let loaded = 0, skipped = 0;
  for (const file of files) {
    const url = `${pathToFileURL(join(handlersDir, file)).href}?t=${Date.now()}`;
    try {
      await import(url);
      loaded++;
    } catch (err) {
      logger.error(`[RELOAD] Failed to reload handler ${file}:`, err);
      skipped++;
    }
  }

  return { loaded, skipped };
}

// ─── Command export ───────────────────────────────────────────────────────────
export default {
  name: 'reload',
  description: 'Hot-reload commands, events, handlers, or all three.',
  usage: '{prefix}reload <commands|events|handlers|all> [category|name]',
  category: 'debug',
  requiredPermission: 'BOT_OWNER',

  cooldown: 0,

  async execute({ message, args, client }) {
    const target = args[0]?.toLowerCase();
    const filter = args[1]?.toLowerCase();

    if (!target || !['commands', 'events', 'handlers', 'all'].includes(target)) {
      return message.reply({
        embeds: [Embed.warning(
          'Usage: `reload <commands|events|handlers|all> [category|name]`\n\n' +
          '**commands**: reload command files (optional: category name)\n' +
          '**events**: reload event listeners (optional: category name)\n' +
          '**handlers**: re-import handler modules (optional: handler name)\n' +
          '**all**: reload everything'
        ).toJSON()],
      });
    }

    const results = {};

    if (target === 'commands' || target === 'all') {
      results.commands = await reloadCommands(client, filter ?? null);
    }

    if (target === 'events' || target === 'all') {
      const { reloadEvents } = await import('../../handlers/eventHandler.js');
      results.events = await reloadEvents(client, filter ?? null);
    }

    if (target === 'handlers' || target === 'all') {
      results.handlers = await reloadHandlers(filter ?? null);
    }

    // Check for any errors
    const errors = Object.entries(results)
      .filter(([, r]) => r.error)
      .map(([k, r]) => `**${k}:** ${r.error}`);

    if (errors.length) {
      return message.reply({ embeds: [Embed.danger(errors.join('\n'), 'Reload Error').toJSON()] });
    }

    const lines = Object.entries(results).map(([k, r]) =>
      `**${k}:** ${r.loaded} loaded, ${r.skipped} skipped`
    );

    if (results.handlers) {
      lines.push('-# Handlers with active timers (webhookPoller, heartbeat) require `systemctl restart bloo` to fully reset.');
    }

    return message.reply({
      embeds: [Embed.success(lines.join('\n'), `Reload: ${target}${filter ? ` (${filter})` : ''}`).toJSON()],
    });
  },
};
