// ============================================================
//  commands/moderation/echo.js
//  Category : Moderation
//
//  Cross-server announcement relay (handlers/echoSystem.js). One server's
//  publisher channel gets echoed, via webhook, into another server's
//  subscriber channel, but only once BOTH servers have the feature
//  enabled and the publisher has approved that specific subscriber.
//
//  !echo enable | disable                                  , Administrator (or server owner)
//  !echo channel <#channel> <publisher|subscriber>          , register a channel (max 2 per server)
//  !echo unchannel <#channel>                                , unregister a channel
//  !echo subscribe <publisherChannelId> <#myChannel>         , request to follow a publisher channel
//  !echo approve <subscriptionId>                            , approve a pending request (publisher side)
//  !echo deny <subscriptionId>                               , deny a pending request (publisher side)
//  !echo revoke <subscriptionId>                              , end an active subscription (either side)
//  !echo list                                                , this server's channels + subscriptions
//
//  Gate: `enable`/`disable` require Administrator (server owners always pass
//  regardless, via checkCommandAccess's built-in owner bypass). Everything
//  else requires Ban Members or higher, same tier as servergroup.js, and
//  additionally requires the feature already be enabled for that guild.
// ============================================================

import { Embed } from '../../config/embeds.js';
import { resolveAccess } from '../../handlers/commandPermissions.js';
import { Permissions } from '../../config/guildPermissions.js';
import { isChannelInGuild } from '../../utils/channelGuard.js';
import {
  MAX_CHANNELS_PER_GUILD, MAX_APPROVED_PER_PUBLISHER,
  isEnabled, setEnabled,
  getChannels, addChannel, removeChannel,
  requestSubscription, getSubscription, approveSubscription, denySubscription, revokeSubscription,
  listSubscriptionsForGuild,
} from '../../handlers/echoSystem.js';

export default {
  name: 'echo',
  aliases: ['relay'],
  description: 'Manage cross-server announcement relaying.',
  usage: '{prefix}echo <enable | disable | channel | unchannel | subscribe | approve | deny | revoke | list> [args]',
  category: 'moderation',

  requiredPermission: null, // custom gate below, per subcommand
  internalAccess: true, // subcommands gate themselves via resolveAccess
  // `subscribe` takes another server's publisher channel by design; this
  // server's own channels are checked when they're registered.
  allowForeignChannels: true,

  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    const userId  = message.author.id;

    if (!guildId) {
      await message.reply({ embeds: [Embed.danger('This command can only be used inside a server.', 'Server Only').toJSON()] }).catch(() => {});
      return;
    }

    const [sub, ...rest] = args;
    const subLower = sub?.toLowerCase();

    // ── !echo list, viewable by anyone, no gate ──────────────────────────────
    if (subLower === 'list') {
      const channels = getChannels(guildId);
      const subs     = listSubscriptionsForGuild(guildId);
      const embed = Embed.info(`📡  Echo Setup for this Server`)
        .setDescription(`Enabled: ${isEnabled(guildId) ? '✅' : '❌'}`);

      embed.addFields({
        name:  `Channels (${channels.length}/${MAX_CHANNELS_PER_GUILD})`,
        value: channels.length
          ? channels.map(c => `<#${c.channel_id}>, ${c.role}`).join('\n')
          : 'None registered.',
        inline: false,
      });

      if (subs.length) {
        embed.addFields({
          name:  `Subscriptions (${subs.length})`,
          value: subs.map(s => {
            const asPublisher = s.publisher_guild_id === guildId;
            const dir = asPublisher ? `→ subscriber in another server` : `← from another server's publisher`;
            return `\`#${s.id}\` ${dir}, **${s.status}**`;
          }).join('\n'),
          inline: false,
        });
      }

      await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
      return;
    }

    // ── !echo enable / disable, Administrator (server owner always passes) ──
    if (subLower === 'enable' || subLower === 'disable') {
      if (!(await resolveAccess(client, guildId, userId, 'echo', Permissions.ADMINISTRATOR))) {
        await message.reply({ embeds: [Embed.denied('Administrator (or server owner) required.').toJSON()] }).catch(() => {});
        return;
      }
      setEnabled(guildId, subLower === 'enable');
      await message.reply(subLower === 'enable'
        ? `> ✅ Echo enabled for this server. Register a channel with \`${PREFIX}echo channel #channel <publisher|subscriber>\`.`
        : `> ✅ Echo disabled for this server. Existing channel/subscription setup is kept, just inactive.`);
      return;
    }

    // ── Gate: Ban Members or higher, and feature must be enabled ────────────
    if (!(await resolveAccess(client, guildId, userId, 'echo', Permissions.BAN_MEMBERS))) {
      await message.reply({ embeds: [Embed.denied('Ban Members or higher required.').toJSON()] }).catch(() => {});
      return;
    }
    if (!isEnabled(guildId) && subLower !== 'revoke') {
      await message.reply(`> ❌ Echo isn't enabled for this server yet. An Administrator must run \`${PREFIX}echo enable\` first.`);
      return;
    }

    // ── !echo channel <#channel> <publisher|subscriber> ──────────────────────
    if (subLower === 'channel') {
      const channelId = rest[0]?.replace(/[<#>]/g, '');
      const role       = rest[1]?.toLowerCase();
      if (!channelId || (role !== 'publisher' && role !== 'subscriber')) {
        await message.reply(`> ❌ Usage: \`${PREFIX}echo channel #channel <publisher|subscriber>\``);
        return;
      }
      // Registering is the local half of the two-sided opt-in; it must be a
      // channel of this server, or it'd skip the other server's consent.
      if (!await isChannelInGuild(client, guildId, channelId)) {
        await message.reply('> ❌ That channel is not in this server.');
        return;
      }
      const result = addChannel(guildId, channelId, role, userId);
      await message.reply(result.ok
        ? `> ✅ <#${channelId}> registered as a **${role}** channel.`
        : `> ❌ ${result.reason}`);
      return;
    }

    // ── !echo unchannel <#channel> ────────────────────────────────────────────
    if (subLower === 'unchannel') {
      const channelId = rest[0]?.replace(/[<#>]/g, '');
      if (!channelId) { await message.reply(`> ❌ Usage: \`${PREFIX}echo unchannel #channel\``); return; }
      const removed = removeChannel(guildId, channelId);
      await message.reply(removed
        ? `> ✅ <#${channelId}> unregistered. Any subscriptions using it were removed too.`
        : `> ❌ That channel isn't registered.`);
      return;
    }

    // ── !echo subscribe <publisherChannelId> <#myChannel> ────────────────────
    if (subLower === 'subscribe') {
      const publisherChannelId  = rest[0]?.replace(/[<#>]/g, '');
      const subscriberChannelId = rest[1]?.replace(/[<#>]/g, '');
      if (!publisherChannelId || !subscriberChannelId) {
        await message.reply(`> ❌ Usage: \`${PREFIX}echo subscribe <publisherChannelId> #myChannel\`\n> Register #myChannel as a subscriber channel first with \`${PREFIX}echo channel\`.`);
        return;
      }
      const result = requestSubscription(publisherChannelId, guildId, subscriberChannelId, userId);
      await message.reply(result.ok
        ? `> ✅ Subscription request sent. It needs approval from the publisher server's staff before echoes start.`
        : `> ❌ ${result.reason}`);
      return;
    }

    // ── !echo approve/deny <subscriptionId> ───────────────────────────────────
    if (subLower === 'approve' || subLower === 'deny') {
      const id = parseInt(rest[0], 10);
      if (!Number.isInteger(id)) { await message.reply(`> ❌ Usage: \`${PREFIX}echo ${subLower} <subscriptionId>\`, see \`${PREFIX}echo list\` for IDs.`); return; }
      const result = subLower === 'approve'
        ? approveSubscription(id, guildId, userId)
        : denySubscription(id, guildId, userId);
      if (!result.ok) { await message.reply(`> ❌ ${result.reason}`); return; }
      await message.reply(subLower === 'approve'
        ? `> ✅ Subscription \`#${id}\` approved, echoes will start relaying to that server.`
        : `> ✅ Subscription \`#${id}\` denied.`);
      return;
    }

    // ── !echo revoke <subscriptionId> ─────────────────────────────────────────
    if (subLower === 'revoke') {
      const id = parseInt(rest[0], 10);
      if (!Number.isInteger(id)) { await message.reply(`> ❌ Usage: \`${PREFIX}echo revoke <subscriptionId>\`, see \`${PREFIX}echo list\` for IDs.`); return; }
      const result = revokeSubscription(id, guildId);
      await message.reply(result.ok ? `> ✅ Subscription \`#${id}\` revoked.` : `> ❌ ${result.reason}`);
      return;
    }

    // ── Help fallback ──────────────────────────────────────────
    await message.reply({ embeds: [Embed.info('📡  Echo Commands')
      .setDescription('Cross-server announcement relaying.')
      .addFields(
        { name: `\`${PREFIX}echo enable\` / \`disable\``, value: 'Turn the feature on/off for this server (Administrator)', inline: false },
        { name: `\`${PREFIX}echo channel #channel <publisher|subscriber>\``, value: `Register a channel (max ${MAX_CHANNELS_PER_GUILD} per server)`, inline: false },
        { name: `\`${PREFIX}echo unchannel #channel\``, value: 'Unregister a channel', inline: false },
        { name: `\`${PREFIX}echo subscribe <publisherChannelId> #myChannel\``, value: 'Request to follow a publisher channel', inline: false },
        { name: `\`${PREFIX}echo approve\` / \`deny <subscriptionId>\``, value: `Decide a pending request (publisher side, max ${MAX_APPROVED_PER_PUBLISHER} approved)`, inline: false },
        { name: `\`${PREFIX}echo revoke <subscriptionId>\``, value: 'End an active subscription (either side)', inline: false },
        { name: `\`${PREFIX}echo list\``, value: "This server's channels and subscriptions", inline: false },
      )
      .toJSON()] });
  },
};
