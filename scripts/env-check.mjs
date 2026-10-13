// ─── npm run env:check ────────────────────────────────────────────────────────
// Compares a settings file with .env.example, so you can see what a new
// version of Bloo added before you deploy it. Never prints any values.
//   npm run env:check                        checks .env
//   npm run env:check -- .env.production     checks another file
//
// Reports: settings in .env.example the file is missing (with the example's
// own description), settings the file has that Bloo no longer uses, inline
// comments (systemd keeps those as part of the value), and the two settings
// Bloo can't start without.
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(ROOT, process.argv[2] ?? '.env');
const example = join(ROOT, '.env.example');
if (!existsSync(target)) { console.error(`No file at ${target}`); process.exit(1); }

// key -> { value, line, comment } (comment: the lines just above it in the example)
function parse(file) {
  const out = new Map();
  let notes = [];
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) { notes = []; return; }
    if (line.startsWith('#')) { if (!/^#\s*[-=>]{3}|^#\s*<<</.test(line)) notes.push(line.replace(/^#\s?/, '')); return; }
    const m = /^([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (m) out.set(m[1], { value: m[2], line: i + 1, comment: notes.slice(-2).join(' ') });
    notes = [];
  });
  return out;
}

const want = parse(example), have = parse(target);
const name = target.replace(ROOT, '').replace(/^[\\/]/, '');
const missing = [...want.keys()].filter(k => !have.has(k));
const extra = [...have.keys()].filter(k => !want.has(k));
const inline = [...have].filter(([, v]) => /\s#/.test(v.value)).map(([k, v]) => `${k} (line ${v.line})`);
const blankRequired = ['FLUXER_BOT_TOKEN', 'BOT_OWNERS'].filter(k => !(have.get(k)?.value ?? '').replace(/\s+#.*$/, '').trim());

console.log(`Checking ${name} against .env.example\n`);
if (missing.length) {
  console.log(`Missing (${missing.length}). Add these, even if blank:`);
  for (const k of missing) console.log(`  ${k}=${want.get(k).comment ? `   # ${want.get(k).comment}` : ''}`);
  console.log('');
}
if (extra.length) console.log(`Not used any more (${extra.length}), safe to remove: ${extra.join(', ')}\n`);
if (inline.length) console.log(`Comment on the same line as a value (${inline.length}). Move it to its own line, or systemd reads it as part of the value: ${inline.join(', ')}\n`);
if (blankRequired.length) console.log(`Bloo can't start without: ${blankRequired.join(', ')}\n`);
if (!missing.length && !extra.length && !inline.length && !blankRequired.length) console.log('All good: it has every setting .env.example lists.');
process.exitCode = missing.length || inline.length || blankRequired.length ? 1 : 0;
