// ============================================================
//  commands/utility/analytics.js
//  Category : Utility  |  Server Owner
//
//  Server analytics and the daily moderation digest, the same settings as
//  the dashboard's Analytics page. Both are the Server Owner's call, as on
//  the dashboard: analytics records member activity.
//
//  b!analytics                         status
//  b!analytics on | off                record joins, leaves and activity
//  b!analytics retention <1-90>        days of data to keep
//  b!analytics digest on | off         the daily moderation digest
//  b!analytics digest channel #channel where it's posted
//  b!analytics digest hour <0-23>      when, in UTC
// ============================================================

import { Embed } from '../../config/embeds.js';
import { isAnalyticsEnabled, setAnalyticsEnabled, getRetentionDays, setRetentionDays } from '../../handlers/analyticsSystem.js';
import { getConfig as getDigest, setConfig as setDigest } from '../../handlers/digestSystem.js';

export default {
  name: 'analytics',
  aliases: ['digest'],
  description: 'Turn server analytics and the daily moderation digest on or off, and choose how long data is kept.',
  usage: '{prefix}analytics [on|off | retention <days> | digest <on|off|channel|hour>]',
  requiredPermission: 'SERVER_OWNER',
  cooldown: 5,

  async execute({ message, args, prefix, client }) {
    const guildId = message.guildId;
    const P = prefix;
    const reply = e => message.reply({ embeds: [e.toJSON()] });
    // b!digest ... is the same as b!analytics digest ...
    const usedDigest = /^\S*digest\b/i.test((message.content ?? '').slice(P.length));
    const a = usedDigest ? ['digest', ...args] : args;
    const sub = a[0]?.toLowerCase();

    if (sub === 'on' || sub === 'off') {
      await setAnalyticsEnabled(client, guildId, sub === 'on', message.author.id);
      return reply(Embed.success(sub === 'on'
        ? `Analytics is on. Bloo now records joins, leaves and daily message counts (never message content), and keeps them for ${getRetentionDays(guildId)} days.`
        : 'Analytics is off. Nothing new is recorded, and existing data is deleted after 30 days without new records.'));
    }

    if (sub === 'retention') {
      // Same range as the dashboard; the handler would quietly clamp instead.
      const n = Number(a[1]);
      if (!Number.isInteger(n) || n < 1 || n > 90) return reply(Embed.warning(`Usage: \`${P}analytics retention <1-90>\` (days).`));
      const days = setRetentionDays(guildId, n);
      return reply(Embed.success(`Analytics data is now kept for **${days} days**. Anything older is deleted each day.`));
    }

    if (sub === 'digest') {
      const what = a[1]?.toLowerCase();
      if (what === 'on' || what === 'off') {
        if (what === 'on' && !getDigest(guildId)?.channel_id) {
          return reply(Embed.warning(`Pick a channel first: \`${P}analytics digest channel #channel\`.`));
        }
        setDigest(guildId, { enabled: what === 'on' ? 1 : 0 });
        return reply(Embed.success(what === 'on' ? 'The daily digest is on.' : 'The daily digest is off.'));
      }
      if (what === 'channel') {
        const ch = a[2]?.match(/^<#(\d+)>$/)?.[1] ?? (/^\d{15,25}$/.test(a[2] ?? '') ? a[2] : null);
        if (!ch) return reply(Embed.warning(`Usage: \`${P}analytics digest channel #channel\``));
        setDigest(guildId, { channel_id: ch });
        return reply(Embed.success(`The daily digest will be posted in <#${ch}>.`));
      }
      if (what === 'hour') {
        const h = Number(a[2]);
        if (!Number.isInteger(h) || h < 0 || h > 23) return reply(Embed.warning(`Usage: \`${P}analytics digest hour <0-23>\` (UTC, so 9 is 09:00 UTC).`));
        setDigest(guildId, { hour_utc: h });
        return reply(Embed.success(`The daily digest is posted at **${String(h).padStart(2, '0')}:00 UTC** (<t:${nextUtcHour(h)}:t> your time).`));
      }
    }

    // Status
    const d = getDigest(guildId);
    const on = isAnalyticsEnabled(guildId);
    return reply(Embed.info(
      `**Analytics:** ${on ? `🟢 On, keeping ${getRetentionDays(guildId)} days` : '⚫ Off'}\n` +
      `**Daily digest:** ${d?.enabled ? '🟢 On' : '⚫ Off'}${d?.channel_id ? ` in <#${d.channel_id}>` : ''}, at ${String(d?.hour_utc ?? 9).padStart(2, '0')}:00 UTC\n` +
      (on ? '' : '-# The digest\'s member and activity numbers need analytics on.\n') +
      `\n\`${P}analytics on|off\` · \`${P}analytics retention <1-90>\` · \`${P}analytics digest on|off|channel|hour\``,
      '📊 Analytics'));
  },
};

// Unix seconds of the next time the clock reads hour:00 UTC, for a <t:> tag.
function nextUtcHour(h) {
  const d = new Date(); d.setUTCMinutes(0, 0, 0); d.setUTCHours(h);
  if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
  return Math.floor(d.getTime() / 1000);
}
