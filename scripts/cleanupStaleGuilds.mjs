#!/usr/bin/env node
// ============================================================
//  scripts/cleanupStaleGuilds.mjs
//
//  Removes rows for guilds Bloo is no longer in, across every
//  table that has a guild_id column, to reclaim disk space from
//  guilds that left long before per-feature cleanup (like
//  handlers/webhookPoller.js's pruneGuildFeeds, wired to
//  GuildDelete) existed, or from features that don't have a
//  GuildDelete hook at all yet.
//
//  "Currently in" is checked against a live Fluxer API fetch
//  (GET /users/@me/guilds with the bot token), never against
//  the guild cache or any DB table, both can be stale or
//  incomplete. A prior cache-based check like this caused real,
//  irreversible data loss earlier (see events/guild/guildDelete.js
//  and handlers/webhookPoller.js's pruneGuildFeeds comments), so
//  this only trusts a fresh authoritative answer, and refuses to
//  run at all if that fetch fails or looks incomplete rather than
//  guessing.
//
//  Usage:
//    node scripts/cleanupStaleGuilds.mjs             (dry run, reports only)
//    node scripts/cleanupStaleGuilds.mjs --execute   (actually deletes)
// ============================================================

import 'dotenv/config';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = process.env.DB_PATH ?? join(__dirname, '..', 'data', 'bot.db');
const FLUXER_API = 'https://api.fluxer.app';

const EXECUTE = process.argv.includes('--execute');

// Tables that are keyed by guild_id but are expected to also carry rows for
// guilds Bloo has never been in yet, or aren't safe to blanket-delete from,
// get skipped even though they have a guild_id column.
const SKIP_TABLES = new Set([]);

async function fetchLiveGuildIds() {
  const token = process.env.FLUXER_BOT_TOKEN;
  if (!token) throw new Error('FLUXER_BOT_TOKEN not set, refusing to guess which guilds are live.');

  const res = await fetch(`${FLUXER_API}/users/@me/guilds`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error(`Fluxer API returned HTTP ${res.status} fetching current guilds.`);

  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Fluxer API did not return an array of guilds.');

  // This endpoint isn't paginated anywhere else in this codebase (dashboard/
  // routes/core.js makes the same assumption), but a suspiciously round
  // count is exactly what a truncated first page would look like, and
  // treating a partial list as complete here would delete real, live guilds'
  // data. Refuse rather than risk it.
  if (data.length > 0 && data.length % 100 === 0) {
    throw new Error(
      `Got exactly ${data.length} guilds back, that's a suspicious round number for a ` +
      `possibly-paginated response. Refusing to proceed without confirming this is the ` +
      `full list (check for an 'after'/pagination param on this endpoint before rerunning).`
    );
  }

  return new Set(data.map(g => g.id));
}

function findGuildScopedTables(db) {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all().map(r => r.name);

  return tables.filter(name => {
    if (SKIP_TABLES.has(name)) return false;
    const cols = db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
    return cols.includes('guild_id');
  });
}

function main() {
  return fetchLiveGuildIds().then(liveGuildIds => {
    console.log(`[cleanup] ${liveGuildIds.size} guild(s) currently live per Fluxer API.`);

    const db     = new Database(DB_PATH);
    const tables = findGuildScopedTables(db);
    console.log(`[cleanup] Found ${tables.length} guild-scoped table(s): ${tables.join(', ')}`);

    const report = [];
    let totalStaleGuilds = new Set();
    let totalRows = 0;

    const applyAll = db.transaction(() => {
      for (const table of tables) {
        const staleIds = db.prepare(`SELECT DISTINCT guild_id FROM ${table}`).all()
          .map(r => r.guild_id)
          .filter(id => id != null && !liveGuildIds.has(id));

        if (!staleIds.length) {
          report.push({ table, staleGuilds: 0, rows: 0 });
          continue;
        }

        const countStmt  = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE guild_id = ?`);
        const deleteStmt = db.prepare(`DELETE FROM ${table} WHERE guild_id = ?`);

        let rows = 0;
        for (const id of staleIds) {
          rows += countStmt.get(id).n;
          totalStaleGuilds.add(id);
          if (EXECUTE) deleteStmt.run(id);
        }

        report.push({ table, staleGuilds: staleIds.length, rows });
        totalRows += rows;
      }
    });

    applyAll();
    db.close();

    console.log('');
    console.log(`${EXECUTE ? 'Deleted' : 'Would delete'} rows by table:`);
    for (const r of report) {
      if (!r.rows) continue;
      console.log(`  ${r.table.padEnd(28)} ${String(r.staleGuilds).padStart(4)} stale guild(s), ${r.rows} row(s)`);
    }
    console.log('');
    console.log(`Total: ${totalStaleGuilds.size} stale guild(s), ${totalRows} row(s) ${EXECUTE ? 'deleted' : 'would be deleted'}.`);

    if (!EXECUTE && totalRows > 0) {
      console.log('');
      console.log('Dry run only, nothing was changed. Re-run with --execute to actually delete.');
    }
  });
}

main().catch(err => {
  console.error('[cleanup] Aborted:', err.message);
  process.exit(1);
});
