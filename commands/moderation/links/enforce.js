// ─── b!links enforce ──────────────────────────────────────────────────────────
// Link Enforcement (handlers/linkEnforcement.js), the same settings as the
// dashboard's Link Enforcement card. Every value goes through
// checkLinkEnforcementValue, the check the dashboard uses too.
//
//   b!links enforce                                status
//   b!links enforce on|off
//   b!links enforce mode <standard|shadow|strike|severity|age_gate|approval>
//   b!links enforce alert #channel|off             staff alert channel
//   b!links enforce alertrole @role|off            role pinged on alerts
//   b!links enforce approval #channel|off          where approval requests go
//   b!links enforce dm <text|off>                  DM sent to the poster
//   b!links enforce strike window <hours>          strike mode
//   b!links enforce strike <2|3> <action> [minutes]
//   b!links enforce tier <1|2|3> <action> [minutes] severity mode
//   b!links enforce domain <domain> <1|2|3|remove> a domain's severity tier
//   b!links enforce age <days>                     age_gate mode
//   b!links enforce age <young|old> <action> [minutes]
//   actions: delete, timeout, kick, ban
import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../../config/embeds.js';
import {
  getLinkEnforcementConfig, setLinkEnforcementField, checkLinkEnforcementValue,
  setDomainTier, removeDomainTier, listDomainTiers, ENFORCE_MODES,
} from '../../../handlers/linkEnforcement.js';

const MODE_HELP = {
  standard: 'delete the link',
  shadow:   'delete the link with no notice',
  strike:   'delete first, then escalate on repeats within the window',
  severity: 'act by each domain\'s tier (1, 2 or 3)',
  age_gate: 'act differently for new and older accounts',
  approval: 'hold the link for staff approval',
};

export async function handleEnforce({ message, rest, prefix, guildId }) {
  const reply = e => message.reply({ embeds: [e.toJSON()] });
  const P = prefix;
  const [a, b, c, d] = rest.map(x => x);
  const sub = a?.toLowerCase();
  const id = s => s?.match(/^<[#@]&?(\d+)>$/)?.[1] ?? (/^\d{15,25}$/.test(s ?? '') ? s : undefined);

  // Validate every change first, then save, so nothing is half-applied.
  const save = (pairs, done) => {
    for (const [f, v] of pairs) { const bad = checkLinkEnforcementValue(f, v); if (bad) return reply(Embed.warning(bad)); }
    for (const [f, v] of pairs) setLinkEnforcementField(guildId, f, v);
    return reply(Embed.success(done));
  };
  const actionPair = (prefixField, action, minutes, hasDur = true) => {
    const pairs = [[`${prefixField}_action`, action?.toLowerCase()]];
    if (hasDur && minutes !== undefined) pairs.push([`${prefixField}_dur_min`, Number(minutes)]);
    return pairs;
  };

  if (sub === 'on' || sub === 'off') return save([['enabled', sub === 'on' ? 1 : 0]], `Link enforcement is ${sub}.`);
  if (sub === 'mode') return save([['mode', b?.toLowerCase()]], `Mode set to **${b}**: ${MODE_HELP[b?.toLowerCase()] ?? ''}.`);
  if (sub === 'alert' || sub === 'approval' || sub === 'alertrole') {
    const field = { alert: 'alert_channel_id', approval: 'approval_channel_id', alertrole: 'alert_role_id' }[sub];
    const v = b?.toLowerCase() === 'off' ? null : id(b);
    if (v === undefined) return reply(Embed.warning(`Usage: \`${P}links enforce ${sub} ${sub === 'alertrole' ? '@role' : '#channel'}|off\``));
    return save([[field, v]], v ? `${sub === 'alertrole' ? 'Alert role' : sub === 'alert' ? 'Alert channel' : 'Approval channel'} set.` : `${sub} turned off.`);
  }
  if (sub === 'dm') {
    const text = rest.slice(1).join(' ').trim();
    if (!text) return reply(Embed.warning(`Usage: \`${P}links enforce dm <text>\` or \`off\``));
    return save([['dm_template', text.toLowerCase() === 'off' ? null : text]], text.toLowerCase() === 'off' ? 'No DM is sent.' : 'DM text saved.');
  }
  if (sub === 'strike') {
    if (b?.toLowerCase() === 'window') return save([['strike_window_h', Number(c)]], `Strikes count within **${c} hours**.`);
    if (b === '2' || b === '3') return save(actionPair(`strike_${b}`, c, d), `Strike ${b}: **${c}**${d ? ` for ${d} minutes` : ''}.`);
    return reply(Embed.warning(`Usage: \`${P}links enforce strike window <hours>\` or \`${P}links enforce strike <2|3> <action> [minutes]\``));
  }
  if (sub === 'tier') {
    if (!['1', '2', '3'].includes(b)) return reply(Embed.warning(`Usage: \`${P}links enforce tier <1|2|3> <action> [minutes]\` (minutes only for tier 2)`));
    return save(actionPair(`sev_tier${b}`, c, d, b === '2'), `Tier ${b} domains: **${c}**${b === '2' && d ? ` for ${d} minutes` : ''}.`);
  }
  if (sub === 'domain') {
    const domain = b?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain || !c) return reply(Embed.warning(`Usage: \`${P}links enforce domain <domain> <1|2|3|remove>\``));
    if (c.toLowerCase() === 'remove') { removeDomainTier(guildId, domain); return reply(Embed.success(`${domain} has no tier now (treated as tier 1).`)); }
    if (!['1', '2', '3'].includes(c)) return reply(Embed.warning('The tier must be 1, 2 or 3.'));
    setDomainTier(guildId, domain, Number(c));
    return reply(Embed.success(`${domain} is tier **${c}**.`));
  }
  if (sub === 'age') {
    if (b === 'young' || b === 'old') return save(actionPair(`age_${b}`, c, d), `${b === 'young' ? 'New' : 'Older'} accounts: **${c}**${d ? ` for ${d} minutes` : ''}.`);
    return save([['age_min_days', Number(b)]], `Accounts under **${b} days** old count as new.`);
  }

  // Status
  const cfg = getLinkEnforcementConfig(guildId) ?? {};
  const tiers = listDomainTiers(guildId);
  const act = (x, m) => `${x}${m ? ` ${m}m` : ''}`;
  return reply(new EmbedBuilder().setColor(COLORS.INFO).setTitle('🔗 Link enforcement')
    .setDescription(`${cfg.enabled ? '🟢 **On**' : '⚫ **Off**'} · mode **${cfg.mode ?? 'standard'}**: ${MODE_HELP[cfg.mode ?? 'standard']}`)
    .addFields(
      { name: 'Alerts', value: `${cfg.alert_channel_id ? `<#${cfg.alert_channel_id}>` : 'No channel'}${cfg.alert_role_id ? ` · <@&${cfg.alert_role_id}>` : ''}`, inline: true },
      { name: 'Approval channel', value: cfg.approval_channel_id ? `<#${cfg.approval_channel_id}>` : 'Not set', inline: true },
      { name: 'DM', value: cfg.dm_template ? cfg.dm_template.slice(0, 100) : 'None', inline: false },
      { name: 'Strike', value: `within ${cfg.strike_window_h}h: 2nd ${act(cfg.strike_2_action, cfg.strike_2_dur_min)}, 3rd ${act(cfg.strike_3_action, cfg.strike_3_dur_min)}`, inline: false },
      { name: 'Severity', value: `tier 1 ${cfg.sev_tier1_action}, tier 2 ${act(cfg.sev_tier2_action, cfg.sev_tier2_dur_min)}, tier 3 ${cfg.sev_tier3_action}${tiers.length ? `\n${tiers.slice(0, 15).map(t => `${t.domain}: ${t.tier}`).join(', ')}` : ''}`, inline: false },
      { name: 'Age gate', value: `under ${cfg.age_min_days} days: ${act(cfg.age_young_action, cfg.age_young_dur_min)}, older: ${act(cfg.age_old_action, cfg.age_old_dur_min)}`, inline: false },
    )
    .setFooter({ text: `${P}links enforce on|off|mode|alert|alertrole|approval|dm|strike|tier|domain|age. Modes: ${ENFORCE_MODES.join(', ')}` }));
}
