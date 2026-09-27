// ============================================================
//  commands/moderation/automod.js
//  Category : Moderation  |  Requires Ban Members
//
//  !automod                               , show status
//  !automod on|off                        , global toggle
//  !automod spam <threshold> [window_s]
//  !automod caps <percent> [min_length]
//  !automod mentions <threshold>
//  !automod emoji <threshold>
//  !automod invites <action>
//  !automod action <check> <action>
//    checks:  spam|caps|mentions|emoji|invites
//    actions: delete|warn|mute|kick|ban
// ============================================================

import { EmbedBuilder }                    from '@fluxerjs/core';
import { Embed, COLORS }                   from '../../config/embeds.js';
import { getAutomodConfig, updateAutomodConfig } from '../../handlers/automod.js';
import { Permissions } from '../../config/guildPermissions.js';

const VALID_ACTIONS = ['delete', 'warn', 'mute', 'kick', 'ban']; // same set as the dashboard and handlers/automod.js
const CHECKS        = ['spam', 'caps', 'mentions', 'emoji', 'invites'];

function tog(v) { return v ? '🟢 On' : '🔴 Off'; }
function act(v) { return `\`${v ?? 'delete'}\``; }

function statusEmbed(cfg, prefix) {
  return new EmbedBuilder()
    .setColor(cfg.enabled ? COLORS.SUCCESS : COLORS.WARNING)
    .setTitle(`🛡️  Automod: ${cfg.enabled ? '🟢 Enabled' : '🔴 Disabled'}`)
    .addFields(
      { name: '💬 Spam',     value: `**${cfg.spam_threshold}** msgs / **${cfg.spam_window_s}s** → ${act(cfg.spam_action)}`,       inline: false },
      { name: '🔠 Caps',     value: `**${cfg.caps_threshold}%** over **${cfg.caps_min_length}** chars → ${act(cfg.caps_action)}`,  inline: false },
      { name: '📢 Mentions', value: `**${cfg.mention_threshold}** unique → ${act(cfg.mention_action)}`,                            inline: false },
      { name: '😂 Emoji',    value: `**${cfg.emoji_threshold}** emoji → ${act(cfg.emoji_action)}`,                                 inline: false },
      { name: '🔗 Invites',  value: `action: ${act(cfg.invite_action)}`,                                                            inline: false },
    )
    .setFooter({ text: `${prefix}automod on|off  ·  ${prefix}automod action <check> <action>` });
}

export default {
  name: 'automod',
  aliases: ['am', 'amod'],
  description: 'Configure per-guild automated moderation.',
  usage: '{prefix}automod [on|off|spam|caps|mentions|emoji|invites|action] [args]',
  category: 'moderation',

  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    if (!guildId) return;

    const cfg = getAutomodConfig(guildId);
    const [sub, ...rest] = args;
    const s = sub?.toLowerCase();

    if (!s || s === 'status') {
      return message.reply({ embeds: [statusEmbed(cfg, PREFIX).toJSON()] });
    }

    // ── on / off ──────────────────────────────────────────────
    if (s === 'on' || s === 'off') {
      updateAutomodConfig(guildId, { enabled: s === 'on' ? 1 : 0 });
      return message.reply({ embeds: [Embed.success(`Automod ${s === 'on' ? 'enabled' : 'disabled'}.`).toJSON()] }).catch(() => {});
    }

    // ── spam <threshold> [window_s] ───────────────────────────
    if (s === 'spam') {
      const threshold = parseInt(rest[0], 10);
      const windowS   = parseInt(rest[1], 10);
      if (isNaN(threshold) || threshold < 2 || threshold > 50) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}automod spam <2–50> [window_sec]\`\nCurrent: ${cfg.spam_threshold} msgs / ${cfg.spam_window_s}s`).toJSON()] }).catch(() => {});
      }
      const patch = { spam_threshold: threshold };
      if (!isNaN(windowS) && windowS >= 1 && windowS <= 60) patch.spam_window_s = windowS;
      updateAutomodConfig(guildId, patch);
      return message.reply({ embeds: [Embed.success(`Spam threshold: **${threshold}** msgs / **${patch.spam_window_s ?? cfg.spam_window_s}s**.`).toJSON()] }).catch(() => {});
    }

    // ── caps <percent> [min_length] ───────────────────────────
    if (s === 'caps') {
      const percent = parseInt(rest[0], 10);
      const minLen  = parseInt(rest[1], 10);
      if (isNaN(percent) || percent < 10 || percent > 100) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}automod caps <10–100> [min_length]\`\nCurrent: ${cfg.caps_threshold}% over ${cfg.caps_min_length} chars`).toJSON()] }).catch(() => {});
      }
      const patch = { caps_threshold: percent };
      if (!isNaN(minLen) && minLen >= 1) patch.caps_min_length = minLen;
      updateAutomodConfig(guildId, patch);
      return message.reply({ embeds: [Embed.success(`Caps filter: **${percent}%** over **${patch.caps_min_length ?? cfg.caps_min_length}** chars.`).toJSON()] }).catch(() => {});
    }

    // ── mentions <threshold> ──────────────────────────────────
    if (s === 'mentions' || s === 'mention') {
      const threshold = parseInt(rest[0], 10);
      if (isNaN(threshold) || threshold < 1 || threshold > 50) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}automod mentions <1–50>\`\nCurrent: ${cfg.mention_threshold}`).toJSON()] }).catch(() => {});
      }
      updateAutomodConfig(guildId, { mention_threshold: threshold });
      return message.reply({ embeds: [Embed.success(`Mention spam threshold: **${threshold}** unique mentions.`).toJSON()] }).catch(() => {});
    }

    // ── emoji <threshold> ─────────────────────────────────────
    if (s === 'emoji') {
      const threshold = parseInt(rest[0], 10);
      if (isNaN(threshold) || threshold < 1 || threshold > 100) {
        return message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}automod emoji <1–100>\`\nCurrent: ${cfg.emoji_threshold}`).toJSON()] }).catch(() => {});
      }
      updateAutomodConfig(guildId, { emoji_threshold: threshold });
      return message.reply({ embeds: [Embed.success(`Emoji spam threshold: **${threshold}** emoji.`).toJSON()] }).catch(() => {});
    }

    // ── invites <action> ──────────────────────────────────────
    if (s === 'invites' || s === 'invite') {
      const action = rest[0]?.toLowerCase();
      if (!action || !VALID_ACTIONS.includes(action)) {
        return message.reply({ embeds: [Embed.warning(`Valid actions: ${VALID_ACTIONS.map(a => `\`${a}\``).join(', ')}`).toJSON()] }).catch(() => {});
      }
      updateAutomodConfig(guildId, { invite_action: action });
      return message.reply({ embeds: [Embed.success(`Invite link action: \`${action}\`.`).toJSON()] }).catch(() => {});
    }

    // ── action <check> <action> ───────────────────────────────
    if (s === 'action') {
      const check  = rest[0]?.toLowerCase();
      const action = rest[1]?.toLowerCase();
      const fieldMap = {
        spam: 'spam_action', caps: 'caps_action',
        mentions: 'mention_action', mention: 'mention_action',
        emoji: 'emoji_action', invites: 'invite_action', invite: 'invite_action',
      };
      const field = fieldMap[check];
      if (!field || !action || !VALID_ACTIONS.includes(action)) {
        return message.reply({
          embeds: [Embed.warning(
            `Usage: \`${PREFIX}automod action <check> <action>\`\n` +
            `Checks: ${CHECKS.map(c => `\`${c}\``).join(', ')}\n` +
            `Actions: ${VALID_ACTIONS.map(a => `\`${a}\``).join(', ')}`
          ).toJSON()],
        }).catch(() => {});
      }
      updateAutomodConfig(guildId, { [field]: action });
      return message.reply({ embeds: [Embed.success(`\`${check}\` action → \`${action}\`.`).toJSON()] }).catch(() => {});
    }

    // ── help fallback ─────────────────────────────────────────
    return message.reply({ embeds: [statusEmbed(cfg, PREFIX).toJSON()] });
  },
};
