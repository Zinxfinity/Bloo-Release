// Command names + aliases for processes that don't load the commands
// themselves (the dashboard). Importing every command module there would run
// their schema setup and pull in bot-only code, so this reads the `name` and
// `aliases` fields straight from the source of each command's default export.
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'commands');

let cache = null;

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

// Returns a Set of every command name and alias, lowercased.
export function getAllCommandNames() {
  if (cache) return cache;
  const names = new Set();
  for (const file of walk(COMMANDS_DIR, [])) {
    const src = readFileSync(file, 'utf8');
    const def = src.indexOf('export default {');
    if (def === -1) continue;
    const body = src.slice(def);
    const name = body.match(/\n\s+name:\s*['"]([^'"]+)['"]/)?.[1];
    if (!name) continue;
    names.add(name.toLowerCase());
    const aliases = body.match(/\n\s+aliases:\s*\[([^\]]*)\]/)?.[1];
    for (const m of aliases?.matchAll(/['"]([^'"]+)['"]/g) ?? []) names.add(m[1].toLowerCase());
  }
  cache = names;
  return names;
}
