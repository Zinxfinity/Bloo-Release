// ─── check-events ─────────────────────────────────────────────────────────────
// Standalone validator: every events/<category>/*.js file must default-export
// an object whose `name` is a real @fluxerjs/core Events.* value. Runs without
// booting the client, so it's usable in CI or as a fast pre-PR check.
//
// Usage: pnpm run check:events

import { readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Events } from '@fluxerjs/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const eventsDir = join(__dirname, '..', 'events');
const VALID_EVENT_NAMES = new Set(Object.values(Events));

let checked = 0;
let failed  = 0;

const categories = readdirSync(eventsDir).filter(f =>
  statSync(join(eventsDir, f)).isDirectory()
);

for (const category of categories) {
  const categoryDir = join(eventsDir, category);
  const files = readdirSync(categoryDir).filter(f => f.endsWith('.js'));

  for (const file of files) {
    const filePath = join(categoryDir, file);
    checked++;

    try {
      const mod   = await import(pathToFileURL(filePath).href);
      const event = mod.default;

      if (!event?.name || typeof event.execute !== 'function') {
        console.error(`FAIL  ${category}/${file}, missing name or execute`);
        failed++;
        continue;
      }

      if (!VALID_EVENT_NAMES.has(event.name)) {
        console.error(`FAIL  ${category}/${file}, "${event.name}" is not a real Events.* value`);
        failed++;
        continue;
      }

      console.log(`OK    ${category}/${file}, ${event.name}`);
    } catch (err) {
      console.error(`FAIL  ${category}/${file}, failed to import: ${err.message}`);
      failed++;
    }
  }
}

console.log(`\n${checked} event file(s) checked, ${failed} failure(s).`);
process.exit(failed > 0 ? 1 : 0);
