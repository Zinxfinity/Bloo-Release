// ============================================================
//  commands/utility/botchannels.js
//  Category : Utility  |  Access 0  |  Rank 6 (Server Owner, HARD LOCK)
//
//  Configure which channels bot commands can be used in.
//
//  Behaviour:
//    • No channels configured  → commands work everywhere (default)
//    • Channels configured     → commands only work in those channels
//    • Staff (Mod+ rank ≥ 2) bypass the restriction entirely
//    • This command is always exempt, the Server Owner can run it
//      from any channel, even one that is restricted
//
//  Subcommands:
//    !botchannels                       , status overview
//    !botchannels enable  <#channel>    , add a channel to the whitelist
//    !botchannels disable <#channel>    , remove a channel from the whitelist
//    !botchannels clear                 , open commands to all channels
//    !botchannels check   [#channel]    , test whether a channel is allowed
//
//  Permission:
//    Hard-locked to Server Owner (rank 6). Cannot be changed via
//    !permissions, this prevents staff from ever locking the Server
//    Owner out of their own configuration tool.
// ============================================================

import { EmbedBuilder }                from '@fluxerjs/core';
import { COLORS, Embed }               from '../../config/embeds.js';
import { isRealOwner, isBotOwner } from '../../handlers/staffSystem.js';
import {
  listChannels as getBotChannels,
  addChannel   as addBotChannel,
  removeChannel as removeBotChannel,
  clearChannels as clearBotChannels,
  isChannelAllowed,
} from '../../handlers/channelRestrictions.js';

function parseChannelId(arg) {
  if (!arg) return null;
  return arg.match(/^<#(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

// ── Shared status embed ────────────────────────────────────────
function buildStatusEmbed(guildId, prefix) {
  const channels     = getBotChannels(guildId);
  const isRestricted = channels.length > 0;

  const embed = new EmbedBuilder()
    .setTitle('🔧  Bot Command Channels')
    .setColor(isRestricted ? COLORS.WARNING : COLORS.SUCCESS);

  if (!isRestricted) {
    embed.setDescription(
      '**Status: Unrestricted.** Bot commands work in every channel.\n\n' +
      `Use \`${prefix}botchannels enable <#channel>\` to restrict commands to specific channels.\n` +
      '-# Staff (Mod+) are always exempt regardless of this setting.'
    );
  } else {
    embed
      .setDescription(
        `**Status: Restricted.** Commands only work in the ${channels.length} channel${channels.length === 1 ? '' : 's'} below.\n\n` +
        channels.map(id => `<#${id}>`).join('\n')
      )
      .addFields({
        name:  '👮  Staff Exemption',
        value: 'Mod+ can use commands in **any** channel regardless of this list.',
        inline: false,
      });
  }

  embed.addFields(
    { name: `\`${prefix}botchannels enable <#channel>\``,  value: 'Allow commands in a channel',   inline: false },
    { name: `\`${prefix}botchannels disable <#channel>\``, value: 'Block commands in a channel',   inline: false },
    { name: `\`${prefix}botchannels clear\``,              value: 'Allow commands everywhere',      inline: false },
    { name: `\`${prefix}botchannels check [#channel]\``,   value: 'Test whether a channel is open', inline: false },
  );

  embed.setFooter({ text: 'This command is always exempt. Run it from any channel.' });
  return embed;
}

export default {
  name: 'botchannels',
  aliases: ['botchannel', 'commandchannels', 'cmdchannels'],
  description: 'Restrict which channels bot commands can be used in.',
  usage: '{prefix}botchannels <enable | disable | clear | check | status> [#channel]',
  category: 'utility',

  requiredPermission: 'SERVER_OWNER', // hard-locked, intentionally not routed through !permissions
  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;

    if (!guildId) {
      await message.reply({
        embeds: [Embed.danger('Server Only').setDescription('This command can only be used inside a server.').toJSON()],
      });
      return;
    }

    // ── Hard gate: Server Owner only ──────────
    // Enforced directly so !permissions set botchannels <lower> cannot
    // override it and lock the owner out of their own config.
    const isOwner = isBotOwner(message.author.id) || await isRealOwner(guildId, message.author.id);
    if (!isOwner) {
      await message.reply({
        embeds: [
          Embed.denied('Server Owner Only')
            .setDescription(
              'Only the **Server Owner** can configure bot command channels.\n\n' +
              'This is intentional. If it were adjustable, a staff member could ' +
              'accidentally restrict the Server Owner from managing the bot.'
            )
            .toJSON(),
        ],
      });
      return;
    }

    const [sub, channelArg] = args;

    // ── No args → show status ─────────────────────────────
    if (!sub || sub === 'list' || sub === 'status') {
      await message.reply({ embeds: [buildStatusEmbed(guildId, PREFIX).toJSON()] }).catch(() => {});
      return;
    }

    // ── enable <#channel> ─────────────────────────────────
    if (sub === 'enable' || sub === 'add') {
      const channelId = parseChannelId(channelArg);
      if (!channelId) {
        await message.reply({
          embeds: [
            Embed.warning('Missing Channel')
              .setDescription(`Mention the channel to enable.\n\nUsage: \`${PREFIX}botchannels enable <#channel>\``)
              .toJSON(),
          ],
        });
        return;
      }

      const current = getBotChannels(guildId);
      if (current.includes(channelId)) {
        await message.reply({
          embeds: [
            Embed.info('Already Enabled')
              .setDescription(`<#${channelId}> is already on the bot channels list.`)
              .toJSON(),
          ],
        });
        return;
      }

      addBotChannel(guildId, channelId, message.author.id);
      const updated = getBotChannels(guildId);

      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅  Channel Enabled')
            .setColor(COLORS.SUCCESS)
            .setDescription(
              `<#${channelId}> added to the bot channels list.\n\n` +
              `Commands now work in **${updated.length}** channel${updated.length === 1 ? '' : 's'}:\n` +
              updated.map(id => `<#${id}>`).join('\n')
            )
            .addFields({
              name:  '👮  Reminder',
              value: 'Staff (Mod+) bypass this list and can use commands anywhere.',
              inline: false,
            })
            .setFooter({ text: `Enabled by ${message.author.username}` })
            .setTimestamp()
            .toJSON(),
        ],
      });
      return;
    }

    // ── disable <#channel> ────────────────────────────────
    if (sub === 'disable' || sub === 'remove') {
      const channelId = parseChannelId(channelArg);
      if (!channelId) {
        await message.reply({
          embeds: [
            Embed.warning('Missing Channel')
              .setDescription(`Mention the channel to disable.\n\nUsage: \`${PREFIX}botchannels disable <#channel>\``)
              .toJSON(),
          ],
        });
        return;
      }

      const current = getBotChannels(guildId);
      if (!current.includes(channelId)) {
        await message.reply({
          embeds: [
            Embed.info('Not in List')
              .setDescription(
                `<#${channelId}> is not on the bot channels list, so there's nothing to remove.\n\n` +
                (current.length
                  ? `Current list: ${current.map(id => `<#${id}>`).join(', ')}`
                  : 'No restrictions are active. Commands work everywhere.')
              )
              .toJSON(),
          ],
        });
        return;
      }

      removeBotChannel(guildId, channelId);
      const remaining = getBotChannels(guildId);

      const embed = new EmbedBuilder()
        .setTitle('🔒  Channel Disabled')
        .setColor(COLORS.WARNING)
        .setFooter({ text: `Disabled by ${message.author.username}` })
        .setTimestamp();

      if (remaining.length) {
        embed
          .setDescription(
            `<#${channelId}> removed from the bot channels list.\n\n` +
            `Commands still work in **${remaining.length}** channel${remaining.length === 1 ? '' : 's'}:\n` +
            remaining.map(id => `<#${id}>`).join('\n')
          );
      } else {
        embed
          .setColor(COLORS.SUCCESS)
          .setDescription(
            `<#${channelId}> removed. No channels remain on the list.\n\n` +
            '**Bot commands now work in every channel again.**'
          );
      }

      await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
      return;
    }

    // ── clear ─────────────────────────────────────────────
    if (sub === 'clear' || sub === 'reset') {
      const current = getBotChannels(guildId);
      if (!current.length) {
        await message.reply({
          embeds: [
            Embed.info('Nothing to Clear')
              .setDescription('No channel restrictions are active. Commands already work everywhere.')
              .toJSON(),
          ],
        });
        return;
      }

      clearBotChannels(guildId);

      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅  All Restrictions Cleared')
            .setColor(COLORS.SUCCESS)
            .setDescription(
              `Removed all **${current.length}** channel restriction${current.length === 1 ? '' : 's'}.\n\n` +
              'Bot commands now work in **every channel** in this server.'
            )
            .setFooter({ text: `Cleared by ${message.author.username}` })
            .setTimestamp()
            .toJSON(),
        ],
      });
      return;
    }

    // ── check [#channel] ──────────────────────────────────
    if (sub === 'check') {
      // Default to the channel the command was run in if no arg given
      const channelId = parseChannelId(channelArg) ?? message.channelId;
      const allowed   = isChannelAllowed(guildId, channelId);
      const list      = getBotChannels(guildId);

      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🔍  Channel Check')
            .setColor(allowed ? COLORS.SUCCESS : COLORS.DANGER)
            .setDescription(
              allowed
                ? `✅ Commands **work** in <#${channelId}>.`
                : `❌ Commands are **blocked** in <#${channelId}>.\n\nUse \`${PREFIX}botchannels enable <#${channelId}>\` to allow it.`
            )
            .addFields({
              name:  list.length ? '📋  Active Channels' : '📋  Status',
              value: list.length
                ? list.map(id => `${id === channelId ? '→ ' : ''}<#${id}>${id === channelId ? ' ← checked' : ''}`).join('\n')
                : 'No restrictions. Commands work everywhere.',
              inline: false,
            })
            .addFields({
              name:  '👮  Staff Note',
              value: 'Staff (Mod+) bypass all channel restrictions regardless of this list.',
              inline: false,
            })
            .toJSON(),
        ],
      });
      return;
    }

    // ── Unknown subcommand → show status/help ─────────────
    await message.reply({ embeds: [buildStatusEmbed(guildId, PREFIX).toJSON()] }).catch(() => {});
  },
};
