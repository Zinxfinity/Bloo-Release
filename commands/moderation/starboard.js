// ============================================================
//  commands/moderation/starboard.js
//  Category : Moderation  |  Requires Ban Members
//
//  Configure the starboard, messages that hit the star
//  threshold get reposted to a designated channel.
//
//  !starboard                         , show current config
//  !starboard channel <#channel|off>  , set starboard channel
//  !starboard threshold <number>      , set star count needed
//  !starboard emoji <emoji>           , set the reaction emoji
//  !starboard selfstar <on|off>       , allow self-starring
//  !starboard bots <on|off>           , include bot messages
//  !starboard category <categoryId> <#channel|exclude|off>
//                                      , per-category redirect or exclusion
//  !starboard category list           , list current category overrides
// ============================================================

import { EmbedBuilder }  from '@fluxerjs/core';
import { COLORS, Embed } from '../../config/embeds.js';
import {
  getStarboardConfig, updateStarboardConfig, resolveConfigEmoji, displayEmoji,
  listStarboardCategoryOverrides, setStarboardCategoryOverride, removeStarboardCategoryOverride,
} from '../../handlers/starboard.js';
import { Permissions } from '../../config/guildPermissions.js';

function parseId(arg) {
  return arg?.match(/^<[#@&!]+(\d+)>$/)?.[1] ?? (arg?.match(/^\d{17,20}$/) ? arg : null);
}

function onOff(val) { return val ? '✅ On' : '❌ Off'; }

function buildStatusEmbed(cfg, prefix) {
  return new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle('⭐  Starboard Configuration')
    .addFields(
      { name: 'Status',      value: onOff(cfg.enabled),                                                             inline: true },
      { name: 'Channel',     value: cfg.channel_id ? `<#${cfg.channel_id}>` : 'Not set',                           inline: true },
      { name: 'Threshold',   value: `${cfg.threshold} ${displayEmoji(cfg.emoji)}`,                                  inline: true },
      { name: 'Emoji',       value: displayEmoji(cfg.emoji),                                                          inline: true },
      { name: 'Self-Star',   value: onOff(cfg.self_star),                                                           inline: true },
      { name: 'Ignore Bots', value: onOff(cfg.ignore_bots),                                                         inline: true },
    )
    .setFooter({ text: `Run ${prefix}starboard channel <#ch> to enable` });
}

export default {
  name: 'starboard',
  aliases: ['star', 'sb'],
  description: 'Configure the starboard channel where highly-reacted messages get pinned.',
  usage: '{prefix}starboard <channel | threshold | emoji | on | off | selfstar | bots | category | status>',
  category: 'moderation',

  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 3,

  async execute({ message, args, prefix, client }) {
    const guildId = message.guildId;
    const cfg     = getStarboardConfig(guildId);
    const sub     = args[0]?.toLowerCase();

    if (!sub || sub === 'status') {
      return message.reply({ embeds: [buildStatusEmbed(cfg, prefix).toJSON()] });
    }

    // ── !starboard on / off ───────────────────────────────
    if (sub === 'on' || sub === 'off') {
      if (sub === 'on' && !cfg.channel_id) {
        return message.reply(`Set a channel first: \`${prefix}starboard channel #channel\``);
      }
      updateStarboardConfig(guildId, { enabled: sub === 'on' ? 1 : 0 });
      return message.reply({ embeds: [Embed.success(`Starboard ${sub === 'on' ? 'Enabled ✅' : 'Disabled ❌'}`).toJSON()] });
    }

    // ── !starboard channel <#ch|off> ─────────────────────
    if (sub === 'channel') {
      const arg = args[1];
      if (!arg) return message.reply(`Usage: \`${prefix}starboard channel <#channel|off>\``);
      if (arg.toLowerCase() === 'off') {
        updateStarboardConfig(guildId, { enabled: 0, channel_id: null });
        return message.reply({ embeds: [Embed.success('Starboard Disabled').toJSON()] });
      }
      const chId = parseId(arg);
      if (!chId) return message.reply('Please mention a channel or provide a channel ID.');
      updateStarboardConfig(guildId, { enabled: 1, channel_id: chId });
      return message.reply({ embeds: [Embed.success('Starboard Channel Set').setDescription(`Starred messages will be posted to <#${chId}>.`).toJSON()] });
    }

    // ── !starboard threshold <n> ─────────────────────────
    if (sub === 'threshold') {
      const n = parseInt(args[1], 10);
      if (isNaN(n) || n < 1 || n > 100) return message.reply(`Usage: \`${prefix}starboard threshold <1-100>\``);
      updateStarboardConfig(guildId, { threshold: n });
      const fresh = getStarboardConfig(guildId);
      return message.reply({ embeds: [Embed.success('Threshold Updated').setDescription(`Messages now need **${n}** ${fresh.emoji} to reach the starboard.`).toJSON()] });
    }

    // ── !starboard emoji <emoji> ─────────────────────────
    if (sub === 'emoji') {
      const raw = args[1];
      if (!raw) return message.reply(`Usage: \`${prefix}starboard emoji <emoji>\``);

      // A pasted/picked custom emoji arrives as a real <a?:name:id> tag,
      // convert to the bare "name:id" ("a_name:id" if animated) form
      // handleStarReaction actually compares against.
      const customTag = raw.match(/^<(a)?:(\w+):(\d+)>$/);
      let emoji;
      if (customTag) {
        emoji = `${customTag[1] ? 'a_' : ''}${customTag[2]}:${customTag[3]}`;
      } else {
        const bareShortcode = raw.match(/^:([^:]+):$/);
        const resolved = resolveConfigEmoji(raw);
        if (bareShortcode && resolved === bareShortcode[1]) {
          // resolveConfigEmoji didn't recognize this as one of the small
          // set of known built-in unicode shortcodes, so this is very
          // likely a custom server emoji typed as plain ":name:" text
          // without the client expanding it into a real tag first, e.g.
          // typed on a device that doesn't have it cached yet. Storing
          // that bare text verbatim isn't a usable reaction identifier at
          // all, exactly why it "failed to load", so look it up by name
          // in this server's own emoji list instead of silently keeping
          // dead text.
          const guildEmojis = await client.rest.get(`/guilds/${guildId}/emojis`).catch(() => null);
          const match = Array.isArray(guildEmojis) ? guildEmojis.find(e => e.name === bareShortcode[1]) : null;
          if (!match) {
            return message.reply({ embeds: [Embed.warning(
              `Couldn't find a custom emoji named \`${bareShortcode[1]}\` in this server.\nIf it is a custom emoji, paste the emoji itself (so it expands into a real tag) instead of typing its name.`
            ).toJSON()] });
          }
          emoji = `${match.animated ? 'a_' : ''}${match.name}:${match.id}`;
        } else {
          emoji = resolved;
        }
      }

      updateStarboardConfig(guildId, { emoji });
      return message.reply({ embeds: [Embed.success('Emoji Updated').setDescription(`Starboard emoji set to ${displayEmoji(emoji)}.`).toJSON()] });
    }

    // ── !starboard selfstar <on|off> ─────────────────────
    if (sub === 'selfstar') {
      const toggle = args[1]?.toLowerCase();
      if (!['on','off'].includes(toggle)) return message.reply(`Usage: \`${prefix}starboard selfstar <on|off>\``);
      updateStarboardConfig(guildId, { self_star: toggle === 'on' ? 1 : 0 });
      return message.reply({ embeds: [Embed.success('Self-Star Updated').setDescription(`Authors can ${toggle === 'on' ? 'now' : 'no longer'} star their own messages.`).toJSON()] });
    }

    // ── !starboard bots <on|off> ─────────────────────────
    if (sub === 'bots') {
      const toggle = args[1]?.toLowerCase();
      if (!['on','off'].includes(toggle)) return message.reply(`Usage: \`${prefix}starboard bots <on|off>\``);
      updateStarboardConfig(guildId, { ignore_bots: toggle === 'off' ? 1 : 0 });
      return message.reply({ embeds: [Embed.success('Bot Messages Updated').setDescription(`Bot messages are ${toggle === 'on' ? 'now included on' : 'excluded from'} the starboard.`).toJSON()] });
    }

    // ── !starboard category <categoryId> <#channel|exclude|off> ──
    // <#channel>: reacts anywhere in that category post there instead of
    // the default starboard channel above.
    // exclude: reacts in that category never post anywhere, useful for
    // categories locked to a role, so people without that role can't see
    // its content leak into the regular starboard.
    // off: remove the override, category goes back to using the default.
    if (sub === 'category') {
      const listSub = args[1]?.toLowerCase();
      if (!args[1] || listSub === 'list') {
        const overrides = listStarboardCategoryOverrides(guildId);
        if (!overrides.length) {
          return message.reply({ embeds: [Embed.info(`No per-category overrides set.\nUsage: \`${prefix}starboard category <categoryId> <#channel|exclude|off>\``).toJSON()] });
        }
        const lines = overrides.map(o => `\`${o.category_id}\` → ${o.channel_id ? `<#${o.channel_id}>` : '🚫 excluded from starboard'}`);
        return message.reply({ embeds: [Embed.info(lines.join('\n'), '⭐ Starboard Category Overrides').toJSON()] });
      }

      const categoryId = parseId(args[1]);
      if (!categoryId) return message.reply(`Usage: \`${prefix}starboard category <categoryId> <#channel|exclude|off>\``);

      const action = args[2]?.toLowerCase();
      if (!action) return message.reply(`Usage: \`${prefix}starboard category ${categoryId} <#channel|exclude|off>\``);

      if (action === 'off') {
        removeStarboardCategoryOverride(guildId, categoryId);
        return message.reply({ embeds: [Embed.success(`Category \`${categoryId}\` now uses the default starboard channel again.`).toJSON()] });
      }
      if (action === 'exclude') {
        setStarboardCategoryOverride(guildId, categoryId, null);
        return message.reply({ embeds: [Embed.success(`Category \`${categoryId}\` is now excluded from the starboard entirely, nothing in it will ever be posted.`).toJSON()] });
      }
      const chId = parseId(args[2]);
      if (!chId) return message.reply(`Usage: \`${prefix}starboard category ${categoryId} <#channel|exclude|off>\``);
      setStarboardCategoryOverride(guildId, categoryId, chId);
      return message.reply({ embeds: [Embed.success(`Reacts in category \`${categoryId}\` will now be posted to <#${chId}> instead of the default starboard.`).toJSON()] });
    }

    return message.reply({ embeds: [buildStatusEmbed(cfg, prefix).toJSON()] });
  },
};