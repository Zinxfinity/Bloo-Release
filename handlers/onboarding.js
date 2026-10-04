// ============================================================
//  handlers/onboarding.js
//
//  One short welcome DM to a server's owner when Bloo is added. Meant to be
//  helpful without being a chore: nothing is required, three optional places
//  to start, and where to get help.
//    - Sent once per server, ever. A server that removes and re-adds Bloo
//      doesn't get it again.
//    - DM only, never posted in the server, so members aren't bothered.
//    - Closed DMs: nothing is sent and nothing is retried.
// ============================================================

import db from '../db.js';
import logger from '../utils/logger.js';
import { COLORS } from '../config/embeds.js';
import { siteUrl } from '../config/site.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_onboarding (
    guild_id  TEXT PRIMARY KEY,
    owner_id  TEXT,
    sent_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    delivered INTEGER NOT NULL DEFAULT 0
  )
`);

const q = {
  seen:   db.prepare(`SELECT 1 FROM guild_onboarding WHERE guild_id = ?`),
  record: db.prepare(`INSERT OR IGNORE INTO guild_onboarding (guild_id, owner_id, delivered) VALUES (?, ?, ?)`),
};

// The welcome, as an embed. Exported so it can be previewed or tested.
export function onboardingMessage(guildName, prefix = process.env.PREFIX || 'b!') {
  const site = siteUrl();
  const support = process.env.REPORT_CONTACT_INVITE;
  const help = [
    `\`${prefix}help\` lists everything`,
    `the [setup guide](${site}/docs/moderation-setup/) walks through it step by step`,
    support ? `the [support server](${support}) is always open` : null,
  ].filter(Boolean);
  return {
    color: COLORS.SUCCESS,
    title: 'Thanks for adding Bloo 💚',
    description: [
      `Hi! I'm ready in **${guildName || 'your server'}**. There's nothing you need to do right now, and everything starts with sensible defaults.`,
      '',
      'When you have a minute, these are good places to start:',
      `**1.** \`${prefix}modlog channel #channel\` keeps a record of every moderation action.`,
      `**2.** \`${prefix}antiraid\` sets up verification, so new members show they're human before they can chat.`,
      `**3.** The [dashboard](${site}/dashboard) lets you set things up with clicks instead of commands.`,
      '',
      'Levels are already on, so members earn XP as they chat.',
      '',
      `If something doesn't make sense, \`${prefix}feedback\` tells me privately. It all gets read.`,
      '',
      `Need a hand? ${help.length > 2 ? `${help.slice(0, -1).join(', ')}, and ${help.at(-1)}` : help.join(' and ')}.`,
    ].join('\n'),
    footer: { text: 'This is the only setup message I\'ll send.' },
  };
}

// Called from events/guild/guildCreate.js for a genuine new join.
export async function sendOnboarding(client, guildId, guildName, ownerId) {
  if (!guildId || !ownerId || q.seen.get(guildId)) return false;
  // Record first, so a quick leave-and-rejoin can't send it twice.
  q.record.run(guildId, ownerId, 0);
  await new Promise(r => setTimeout(r, 5000)); // let the invite screen finish
  try {
    const dm = await client.rest.post('/users/@me/channels', { body: { recipient_id: ownerId } });
    if (!dm?.id) return false;
    await client.rest.post(`/channels/${dm.id}/messages`, { body: { embeds: [onboardingMessage(guildName)], allowed_mentions: { parse: [] } } });
    db.prepare(`UPDATE guild_onboarding SET delivered = 1 WHERE guild_id = ?`).run(guildId);
    logger.info(`[ONBOARD] Welcome sent to the owner of ${guildName ?? guildId}`);
    return true;
  } catch (err) {
    logger.debug(`[ONBOARD] Couldn't DM the owner of ${guildId}: ${err.message}`);
    return false;
  }
}
