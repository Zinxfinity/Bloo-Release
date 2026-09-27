// ============================================================
//  commands/moderation/modlog.js
//  Category : Moderation  |  Access 0  |  Requires Ban Members (default)
//
//  Configure the message logger, log channel, event toggles,
//  and per-channel ignore rules (staff chat, bot spam, etc.)
//
//  Subcommands:
//    channel <#ch|off>          , set or clear the message log channel
//    cases   <#ch|off>          , set or clear the moderation case channel
//    enable  <type>             , enable a log type
//    disable <type>             , disable a log type
//    ignore  <#ch>              , add a channel to the ignore list
//    unignore <#ch>             , remove a channel from the ignore list
//    ignored                    , list all ignored channels
//    status                     , show full configuration (default)
//
//  Log types:  sent | edited | deleted | bot
//
//  Gate 1 : accessLevel 0
//  Gate 2 : requiredPermission BAN_MEMBERS, configurable
// ============================================================

import { Embed }                              from '../../config/embeds.js';
import {
  getMsgLogConfig,
  setMsgLogChannel,
  setMsgLogToggle,
  addIgnoredChannel,
  removeIgnoredChannel,
  getIgnoredChannels,
} from '../../handlers/messageLogger.js';
import { getModlogConfig, setModlogFlag } from '../../handlers/modLog.js';
import { getModlogChannel, setModlogChannel } from '../../handlers/guildSettings.js';
import { Permissions } from '../../config/guildPermissions.js';
import { isChannelInGuild } from '../../utils/channelGuard.js';

// ─── Helpers ─────────────────────────────────────────────────

// Message logger types, backed by messageLogger.js
const MSG_TYPES     = ['sent', 'edited', 'deleted', 'bot'];
const MSG_TYPE_SET  = new Set(MSG_TYPES);

// Modlog event types, backed by modlog_config in modLog.js
const MOD_TYPE_MAP = {
  joins:  'log_joins',
  leaves: 'log_leaves',
  roles:  'log_role_changes',
  nicks:  'log_nick_changes',
};
const MOD_TYPE_SET = new Set(Object.keys(MOD_TYPE_MAP));

const LOG_TYPES    = [...MSG_TYPES, ...Object.keys(MOD_TYPE_MAP)];
const LOG_TYPE_SET = new Set(LOG_TYPES);

function parseChannelId(arg) {
  if (!arg) return null;
  const m = arg.match(/^<#(\d+)>$/) ?? arg.match(/^\d{17,20}$/);
  return m?.[1] ?? (m?.[0] ?? null);
}

function tog(val) {
  return val ? '🟢 **On**' : '⚫ **Off**';
}

function buildStatusEmbed(msgCfg, modCfg, ignoredIds, prefix, caseChannelId) {
  msgCfg = msgCfg ?? {};
  modCfg = modCfg ?? {};

  const channel = msgCfg.channel_id ? `<#${msgCfg.channel_id}>` : '⚫ Not set';
  const caseChannel = caseChannelId ? `<#${caseChannelId}>` : `⚫ Not set (\`${prefix}modlog cases #channel\`)`;

  const ignoredList = ignoredIds.length
    ? ignoredIds.map(id => `<#${id}>`).join('\n')
    : '*None, all channels are logged*';

  return Embed.info('📋  Modlog: Configuration')
    .addFields(
      { name: '📣  Message Log Channel', value: channel,         inline: true  },
      { name: '⚖️  Case Log Channel',    value: caseChannel,     inline: true  },
      { name: '📥  Joins',         value: tog(modCfg.log_joins),        inline: true  },
      { name: '📤  Leaves',        value: tog(modCfg.log_leaves),       inline: true  },
      { name: '🎭  Role Changes',  value: tog(modCfg.log_role_changes), inline: true  },
      { name: '✏️  Nick Changes',  value: tog(modCfg.log_nick_changes), inline: true  },
      { name: '📨  Sent',          value: tog(msgCfg.log_sent),         inline: true  },
      { name: '✏️  Edited',        value: tog(msgCfg.log_edits),        inline: true  },
      { name: '🗑️  Deleted',       value: tog(msgCfg.log_deletes),      inline: true  },
      { name: '🤖  Bot Messages',  value: tog(msgCfg.log_bot),          inline: true  },
      { name: `🚫  Ignored Channels (${ignoredIds.length})`, value: ignoredList, inline: false },
    )
    .setFooter({ text: `${prefix}modlog enable|disable <type>  ·  ${prefix}modlog channel <#ch>` });
}

// ─── Command ──────────────────────────────────────────────────

export default {
  name: 'modlog',
  aliases: ['msglog', 'messagelog', 'mlog'],
  description: 'Configure the message log and moderation case channels, choose what gets logged, and exclude channels such as staff chat from logging.',
  usage: '{prefix}modlog <channel | cases | enable | disable | status | ignore | unignore>',
  example:
    '{prefix}modlog channel #mod-logs\n' +
    '{prefix}modlog cases #mod-cases\n' +
    '{prefix}modlog ignore #staff-chat\n' +
    '{prefix}modlog enable deleted\n' +
    '{prefix}modlog status',
  category: 'moderation',

  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;

    if (!guildId) {
      await message.reply({ embeds: [Embed.danger('Server Only').setDescription('This command can only be used inside a server.').toJSON()] });
      return;
    }

    const [sub, ...rest] = args;

    // ── No args / status ──────────────────────────────────
    if (!sub || sub.toLowerCase() === 'status') {
      const msgCfg     = getMsgLogConfig(guildId) ?? {};
      const modCfg     = getModlogConfig(guildId) ?? {};
      const ignoredIds = getIgnoredChannels(guildId);
      await message.reply({ embeds: [buildStatusEmbed(msgCfg, modCfg, ignoredIds, PREFIX, getModlogChannel(guildId)).toJSON()] });
      return;
    }

    switch (sub.toLowerCase()) {

      // ── cases <#ch | off> ─────────────────────────────────
      // Where moderation case embeds (bans, kicks, warns...) are posted. Only
      // the dashboard could set this before, so bot-only servers never got
      // case posts even though this command's description promised them.
      case 'cases': {
        const arg = rest[0]?.toLowerCase();
        if (arg === 'off' || arg === 'none' || arg === 'disable') {
          setModlogChannel(guildId, null);
          await message.reply({ embeds: [Embed.warning('Case Log Disabled').setDescription('Moderation cases are still recorded, just not posted to a channel.').toJSON()] });
          return;
        }
        const channelId = parseChannelId(rest[0]);
        if (!channelId || !await isChannelInGuild(client, guildId, channelId)) {
          await message.reply({ embeds: [Embed.warning('Invalid Channel').setDescription(`Usage: \`${PREFIX}modlog cases <#channel|off>\` (a channel in this server)`).toJSON()] });
          return;
        }
        setModlogChannel(guildId, channelId);
        await message.reply({ embeds: [Embed.success('Case Log Set').setDescription(`Moderation cases will be posted in <#${channelId}>.`).toJSON()] });
        return;
      }

      // ── channel <#ch | off> ───────────────────────────────
      case 'channel': {
        const arg = rest[0]?.toLowerCase();

        if (!arg) {
          await message.reply({
            embeds: [
              Embed.warning('Missing Argument')
                .setDescription(
                  `Provide a channel or \`off\` to disable.\n\n` +
                  `**Set:**   \`${PREFIX}modlog channel <#channel>\`\n` +
                  `**Clear:** \`${PREFIX}modlog channel off\``
                )
                .toJSON(),
            ],
          });
          return;
        }

        if (arg === 'off' || arg === 'none' || arg === 'disable') {
          setMsgLogChannel(guildId, null);
          await message.reply({
            embeds: [
              Embed.warning('Logging Disabled')
                .setDescription(
                  'Message logging has been **disabled**. No events will be recorded.\n\n' +
                  `-# Your toggle settings are preserved. Re-enable with \`${PREFIX}modlog channel <#channel>\`.`
                )
                .toJSON(),
            ],
          });
          return;
        }

        const channelId = parseChannelId(rest[0]);
        if (!channelId) {
          await message.reply({
            embeds: [
              Embed.warning('Invalid Channel')
                .setDescription(`Mention a channel or provide its ID.\n\nUsage: \`${PREFIX}modlog channel <#channel>\``)
                .toJSON(),
            ],
          });
          return;
        }

        // Must be a channel of this server: the logger copies every message
        // into it, so pointing it at another server would leak this one's chat.
        if (!await isChannelInGuild(client, guildId, channelId)) {
          await message.reply({
            embeds: [Embed.danger('Channel Not Found').setDescription(`Could not find <#${channelId}> in this server. Make sure I have access to it.`).toJSON()],
          });
          return;
        }

        setMsgLogChannel(guildId, channelId);

        const cfg    = getMsgLogConfig(guildId);
        const modCfg = getModlogConfig(guildId) ?? {};
        const active = [
          cfg.log_sent    && '`sent`',
          cfg.log_edits   && '`edited`',
          cfg.log_deletes && '`deleted`',
          cfg.log_bot     && '`bot`',
          modCfg.log_joins   && '`joins`',
          modCfg.log_leaves  && '`leaves`',
        ].filter(Boolean);

        await message.reply({
          embeds: [
            Embed.success('Log Channel Set')
              .setDescription(`All events will be posted to <#${channelId}>.`)
              .addFields({
                name:  '📋  Active Log Types',
                value: active.length
                  ? active.join('  ·  ')
                  : `Nothing enabled yet. Use \`${PREFIX}modlog enable <type>\` to add some.`,
                inline: false,
              })
              .toJSON(),
          ],
        });
        return;
      }

      // ── enable <type> ─────────────────────────────────────
      case 'enable':
      case 'on': {
        const type = rest[0]?.toLowerCase();
        if (!type || !LOG_TYPE_SET.has(type)) {
          await message.reply({
            embeds: [
              Embed.warning('Invalid Type')
                .setDescription(
                  `\`${type ?? '(none)'}\` is not a valid log type.\n\n` +
                  `Usage: \`${PREFIX}modlog enable <type>\`\n` +
                  `Types: ${LOG_TYPES.map(t => `\`${t}\``).join('  ')}`
                )
                .toJSON(),
            ],
          });
          return;
        }

        if (MOD_TYPE_SET.has(type)) {
          setModlogFlag(guildId, MOD_TYPE_MAP[type], true);
        } else {
          setMsgLogToggle(guildId, type, true);
        }
        const label = type.charAt(0).toUpperCase() + type.slice(1);
        await message.reply({
          embeds: [Embed.success(`${label} Logging Enabled`).setDescription(`**${type}** events will now be recorded.\n-# Run \`${PREFIX}modlog status\` to review the full configuration.`).toJSON()],
        });
        return;
      }

      // ── disable <type> ────────────────────────────────────
      case 'disable':
      case 'off': {
        const type = rest[0]?.toLowerCase();
        if (!type || !LOG_TYPE_SET.has(type)) {
          await message.reply({
            embeds: [
              Embed.warning('Invalid Type')
                .setDescription(
                  `\`${type ?? '(none)'}\` is not a valid log type.\n\n` +
                  `Usage: \`${PREFIX}modlog disable <type>\`\n` +
                  `Types: ${LOG_TYPES.map(t => `\`${t}\``).join('  ')}`
                )
                .toJSON(),
            ],
          });
          return;
        }

        if (MOD_TYPE_SET.has(type)) {
          setModlogFlag(guildId, MOD_TYPE_MAP[type], false);
        } else {
          setMsgLogToggle(guildId, type, false);
        }
        const label = type.charAt(0).toUpperCase() + type.slice(1);
        await message.reply({
          embeds: [Embed.success(`${label} Logging Disabled`).setDescription(`**${type}** events will no longer be recorded.\n-# Run \`${PREFIX}modlog status\` to review the full configuration.`).toJSON()],
        });
        return;
      }

      // ── ignore <#ch> ──────────────────────────────────────
      case 'ignore': {
        const channelId = parseChannelId(rest[0]);
        if (!channelId) {
          await message.reply({
            embeds: [
              Embed.warning('Missing Channel')
                .setDescription(
                  `Mention the channel to exclude from logging.\n\n` +
                  `Usage: \`${PREFIX}modlog ignore <#channel>\`\n` +
                  `-# Useful for staff chat, bot command channels, etc.`
                )
                .toJSON(),
            ],
          });
          return;
        }

        addIgnoredChannel(guildId, channelId);
        const ignoredIds = getIgnoredChannels(guildId);

        await message.reply({
          embeds: [
            Embed.success('Channel Ignored')
              .setDescription(`<#${channelId}> will no longer be logged.`)
              .addFields({
                name:  `🚫  All Ignored Channels (${ignoredIds.length})`,
                value: ignoredIds.map(id => `<#${id}>`).join('\n') || '*None*',
                inline: false,
              })
              .toJSON(),
          ],
        });
        return;
      }

      // ── unignore <#ch> ────────────────────────────────────
      case 'unignore': {
        const channelId = parseChannelId(rest[0]);
        if (!channelId) {
          await message.reply({
            embeds: [
              Embed.warning('Missing Channel')
                .setDescription(
                  `Mention the channel to re-enable logging for.\n\n` +
                  `Usage: \`${PREFIX}modlog unignore <#channel>\`\n` +
                  `-# Run \`${PREFIX}modlog ignored\` to see the current ignore list.`
                )
                .toJSON(),
            ],
          });
          return;
        }

        removeIgnoredChannel(guildId, channelId);
        const ignoredIds = getIgnoredChannels(guildId);

        await message.reply({
          embeds: [
            Embed.success('Channel Un-ignored')
              .setDescription(`<#${channelId}> will now be logged again.`)
              .addFields({
                name:  `🚫  Remaining Ignored Channels (${ignoredIds.length})`,
                value: ignoredIds.length
                  ? ignoredIds.map(id => `<#${id}>`).join('\n')
                  : '*None, all channels are now logged*',
                inline: false,
              })
              .toJSON(),
          ],
        });
        return;
      }

      // ── ignored ───────────────────────────────────────────
      case 'ignored': {
        const ignoredIds = getIgnoredChannels(guildId);
        await message.reply({
          embeds: [
            Embed.info(`🚫  Ignored Channels (${ignoredIds.length})`)
              .setDescription(
                ignoredIds.length
                  ? ignoredIds.map(id => `<#${id}>`).join('\n')
                  : `*No channels are currently ignored. All messages are logged.*\n\n` +
                    `-# Use \`${PREFIX}modlog ignore <#channel>\` to exclude a channel.`
              )
              .toJSON(),
          ],
        });
        return;
      }

      // ── fallback / help ───────────────────────────────────
      default:
        await message.reply({
          embeds: [
            Embed.info('📋  Message Logger: Reference')
              .setDescription('Configure which events are recorded, where they go, and which channels to skip.')
              .addFields(
                { name: `\`${PREFIX}modlog channel <#channel>\``, value: 'Set the channel where log events are posted',       inline: false },
                { name: `\`${PREFIX}modlog channel off\``,         value: 'Disable logging (settings preserved)',              inline: false },
                { name: `\`${PREFIX}modlog enable <type>\``,       value: 'Enable a log type',                                inline: false },
                { name: `\`${PREFIX}modlog disable <type>\``,      value: 'Disable a log type',                               inline: false },
                { name: `\`${PREFIX}modlog ignore <#channel>\``,   value: 'Exclude a channel from logging (staff chat, etc)', inline: false },
                { name: `\`${PREFIX}modlog unignore <#channel>\``, value: 'Re-enable logging for an ignored channel',         inline: false },
                { name: `\`${PREFIX}modlog ignored\``,             value: 'List all currently ignored channels',              inline: false },
                { name: `\`${PREFIX}modlog status\``,              value: 'Show full configuration (default)',                inline: false },
                {
                  name:  'Message Log Types',
                  value: '`sent`: new messages\n`edited`: message edits (before/after)\n`deleted`: deleted messages\n`bot`: include bot messages',
                  inline: false,
                },
                {
                  name:  'Member Event Types',
                  value: '`joins`: member join events\n`leaves`: member leave events\n`roles`: role changes\n`nicks`: display name changes',
                  inline: false,
                },
              )
              .toJSON(),
          ],
        });
    }
  },
};