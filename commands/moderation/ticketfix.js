// ============================================================
//  commands/moderation/ticketfix.js
//  Category : Moderation  |  Requires Ban Members (default, configurable)
//
//  Repairs ticket state left broken by a mid-flow WS disconnect.
//
//  Four broken states this command handles:
//
//    GHOST   , DB has an open record but the channel no longer
//               exists. Blocks the user from opening a new ticket.
//               Fix: mark the DB record closed.
//
//    ORPHAN  , A channel exists in the ticket category with no
//               matching DB record (channel created but openTicket()
//               never ran). The user is stuck in limbo.
//               Fix: register the channel in DB, apply permissions,
//               send opening embed.
//
//    NOPERMS , DB record + channel exist but user/support role
//               can't see the channel (permissions never applied).
//               Fix: re-apply all permission overwrites.
//
//    NOSEND  , Everything is correct but no opening embed was sent
//               (channel has no bot messages). Fix: send it now.
//
//  Subcommands:
//    !ticketfix scan            , scan guild for all broken states
//    !ticketfix ghost <@user|id>, resolve ghost record for a user
//    !ticketfix orphan <#ch|id> , register/repair an orphan channel
//    !ticketfix perms <#ch|id>  , reapply permission overwrites
//    !ticketfix resend <#ch|id> , resend the opening embed
//    !ticketfix clear <@user|id>, force-clear all open records (last resort)
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS, Embed }                     from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';
import {
  getTicketConfig as getConfig, getTicketOptions as getOptions,
  registerExistingTicket, closeTicket, failTicket,
  getTicketByChannel, getOpenTicketByUser, getCreatingTicketByUser,
} from '../../handlers/ticketSystem/index.js';

// Permission bits, must match ticketReaction.js exactly
const STAFF_ALLOW = String(1024 | 2048 | 65536 | 32768 | 64 | 2097152);
const USER_ALLOW  = String(1024 | 2048 | 65536 | 32768);

function parseId(arg) {
  if (!arg) return null;
  return arg.match(/^<[@#][!&]?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

// Apply the standard ticket permission overwrites to a channel via REST.
// channelId and guildId are passed explicitly since `channel` is a raw REST
// object and does not expose .guildId or .editPermission().
async function applyPerms(rest, channelId, guildId, cfg, userId, botId) {
  const overwrites = [
    [guildId,             0, '0',         '1024',      '@everyone'],
    [cfg.support_role_id, 0, STAFF_ALLOW, '0',         'support role'],
    [userId,              1, USER_ALLOW,  '0',         'user'],
    [botId,               1, STAFF_ALLOW, '0',         'bot'],
  ];

  const results = [];
  for (const [id, type, allow, deny, label] of overwrites) {
    if (!id) { results.push({ label, ok: false, err: 'id is null/undefined' }); continue; }
    try {
      await rest.put(`/channels/${channelId}/permissions/${id}`, {
        body: { type, allow, deny },
      });
      results.push({ label, ok: true });
    } catch (err) {
      results.push({ label, ok: false, err: err.message });
    }
  }
  return results;
}

// Build the standard ticket opening embed
function buildOpeningEmbed(cfg, ticket, option) {
  const embed = new EmbedBuilder()
    .setTitle(`${option?.emoji ?? '🎫'} ${option?.label ?? 'Support'}: Ticket Opened`)
    .setDescription(
      `Hello <@${ticket.user_id}>, your ticket has been opened.\n` +
      `A member of <@&${cfg.support_role_id}> will be with you shortly.\n\n` +
      `Please describe your issue in as much detail as possible.`
    )
    .setColor(cfg.color ?? 0x5865F2)
    .addFields(
      { name: 'Ticket',   value: `\`${ticket.case_id}\``,                        inline: true },
      { name: 'Category', value: option?.label ?? 'Support',                     inline: true },
      { name: 'Opened',   value: `<t:${ticket.opened_at}:R>`, inline: true },
    )
    .setFooter({ text: '⚠️ This opening message was re-sent after a connection issue.' });


  // Inject thumbnail on the raw JSON, setThumbnail() maps to the


  // large image field in FluxerJS; raw JSON thumbnail gives the small corner image.


  const _embedRaw = embed.toJSON();
  if (cfg.icon_url)   _embedRaw.thumbnail = { url: cfg.icon_url };
  if (cfg.banner_url) _embedRaw.image     = { url: cfg.banner_url };
  return _embedRaw;
}

export default {
  name: 'ticketfix',
  aliases: ['tfix', 'fixticket', 'repairticket'],
  description: 'Repair a broken ticket if the bot disconnected mid-creation.',
  usage: '{prefix}ticketfix <scan | ghost | orphan | perms | resend | clear> [args]',
  category: 'moderation',

  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 5,

  async execute({ message, args, client, prefix }) {
    const PREFIX     = prefix ?? process.env.PREFIX ?? 'b!';
    // @fluxerjs/core message objects expose raw API field names (snake_case)
    const guildId    = message.guildId;
    const authorId   = message.author.id;

    if (!guildId) return;

    const cfg = getConfig(guildId);
    if (!cfg) {
      await message.reply({
        embeds: [Embed.warning('Not Configured')
          .setDescription('The ticket system has not been configured in this server.')
          .toJSON()],
      });
      return;
    }

    const [sub, arg1, ...rest] = args;
    const subCmd = sub?.toLowerCase();

    // ── !ticketfix (no args) / !ticketfix scan ─────────────
    if (!subCmd || subCmd === 'scan') {
      const sent = await message.reply({
        embeds: [Embed.info('🔍  Scanning…').setDescription('Checking for broken ticket state…').toJSON()],
      });

      const issues = [];

      // ── Fetch channels ─────────────────────────────────────
      // Orphans are looked for in every ticket category (the default one
      // plus any per-option category). Ghosts are checked against ALL of the
      // server's channels: comparing against the default category alone
      // reported every per-option ticket, and every ticket in a server with
      // no default category, as a ghost.
      let categoryChannels = [];
      let allChannelIds    = null;
      const ticketCategories = new Set([cfg.category_id, ...getOptions(guildId).map(o => o.category_id)].filter(Boolean));
      try {
        const allChannels = (await client.rest.get(`/guilds/${guildId}/channels`)) ?? [];
        allChannelIds    = new Set(allChannels.map(c => c.id));
        categoryChannels = allChannels.filter(c => ticketCategories.has(c.parent_id) && c.type === 0);
      } catch { /* guild fetch failed, skip ghost/orphan checks rather than guess */ }

      // Check each category channel for a DB record
      for (const ch of categoryChannels) {
        const ticket = getTicketByChannel(ch.id);
        if (!ticket) {
          issues.push({
            type:    'ORPHAN',
            label:   '🔌 Orphan channel',
            detail:  `<#${ch.id}> (\`${ch.name}\`): exists in Fluxer but has no DB record`,
            fix:     `\`${PREFIX}ticketfix orphan ${ch.id}\``,
          });
        }
      }

      // ── Check all users with open DB records ──────────────
      const channelIds = allChannelIds ?? new Set();

      // Import db directly for a targeted query
      const { default: db } = await import('../../db.js').catch(() => ({ default: null }));
      if (db) {
        const openRecords = db.prepare(
          "SELECT * FROM ticket_cases WHERE guild_id = ? AND status = 'open' ORDER BY opened_at DESC"
        ).all(guildId);

        for (const ticket of openRecords) {
          // Ghost: DB says open but channel doesn't exist
          if (allChannelIds && ticket.channel_id && !channelIds.has(ticket.channel_id)) {
            issues.push({
              type:   'GHOST',
              label:  '👻 Ghost record',
              detail: `\`${ticket.case_id}\`, open in DB but <#${ticket.channel_id}> no longer exists`,
              fix:    `\`${PREFIX}ticketfix ghost ${ticket.user_id}\``,
            });
          }
        }

        // Stale 'creating' rows, crashed mid-creation, user may be blocked from opening a new ticket
        const staleCreating = db.prepare(
          "SELECT * FROM ticket_cases WHERE guild_id = ? AND status = 'creating' ORDER BY opened_at DESC"
        ).all(guildId);
        const STALE_S = 5 * 60; // rows older than 5 min are stale (opened_at is unix seconds)
        const _now = Math.floor(Date.now() / 1000);
        for (const ticket of staleCreating) {
          if (_now - ticket.opened_at > STALE_S) {
            const chExists = ticket.channel_id && channelIds.has(ticket.channel_id);
            issues.push({
              type:   'STALE',
              label:  '⚙️ Stale creation',
              detail: `\`${ticket.case_id}\`, stuck in 'creating' for <@${ticket.user_id}>${chExists ? `, channel <#${ticket.channel_id}> exists` : ', no channel found'}`,
              fix:    chExists
                ? `\`${PREFIX}ticketfix orphan ${ticket.channel_id} ${ticket.user_id}\``
                : `\`${PREFIX}ticketfix clear ${ticket.user_id}\``,
            });
          }
        }
      }

      if (!issues.length) {
        await sent.edit({
          embeds: [Embed.success('✅  All Clear')
            .setDescription('No broken ticket state detected.')
            .setFooter({ text: `Scanned ${categoryChannels.length} channel(s) in the ticket category` })
            .toJSON()],
        });
        return;
      }

      const lines = issues.map(i => `**${i.label}**\n${i.detail}\n-# Fix: ${i.fix}`);
      const embed = new EmbedBuilder()
        .setColor(COLORS.WARNING)
        .setTitle(`⚠️  Ticket Scan: ${issues.length} issue(s) found`)
        .setDescription(lines.join('\n\n').slice(0, 3900))
        .setFooter({ text: `Run the fix commands above to repair each issue • ${PREFIX}ticketfix <subcommand> --help for details` })
        .setTimestamp();

      await sent.edit({ embeds: [embed.toJSON()] });
      return;
    }

    // ── !ticketfix ghost <@user|id> ────────────────────────
    // DB says open but the channel is gone, mark record closed
    if (subCmd === 'ghost') {
      const targetId = parseId(arg1);
      if (!targetId) {
        await message.reply(`Usage: \`${PREFIX}ticketfix ghost <@user|id>\``).catch(() => {});
        return;
      }

      const ticket = getOpenTicketByUser(guildId, targetId);
      if (!ticket) {
        await message.reply({
          embeds: [Embed.info('No Open Record')
            .setDescription(`<@${targetId}> has no open ticket record in the database.`)
            .toJSON()],
        });
        return;
      }

      // Check if channel actually still exists
      let channelExists = false;
      try {
        if (ticket.channel_id) {
          const ch = await client.rest.get(`/channels/${ticket.channel_id}`).catch(() => null);
          channelExists = !!ch;
        }
      } catch { /* treat as gone */ }

      if (channelExists) {
        await message.reply({
          embeds: [Embed.warning('Channel Still Exists')
            .setDescription(
              `The ticket channel <#${ticket.channel_id}> still exists in Fluxer.\n\n` +
              `If permissions are broken, use \`${PREFIX}ticketfix perms ${ticket.channel_id}\` instead.\n` +
              `To force-close the record anyway, use \`${PREFIX}ticketfix clear ${targetId}\`.`
            )
            .toJSON()],
        });
        return;
      }

      await closeTicket(client, guildId, ticket.case_id, authorId, 'Auto-closed: channel missing after WS disconnect');

      await message.reply({
        embeds: [Embed.success('Ghost Record Cleared')
          .setDescription(
            `Closed the orphaned DB record for <@${targetId}>.\n` +
            `They can now open a new ticket.`
          )
          .addFields(
            { name: 'Case ID',    value: `\`${ticket.case_id}\``,  inline: true },
            { name: 'Channel',    value: `\`${ticket.channel_id}\` (deleted)`, inline: true },
            { name: 'Closed By',  value: `<@${authorId}>`,          inline: true },
          )
          .toJSON()],
      });
      return;
    }

    // ── !ticketfix orphan <#channel|id> ────────────────────
    // Channel exists but has no DB record, register it and repair
    if (subCmd === 'orphan') {
      const channelId = parseId(arg1);
      if (!channelId) {
        await message.reply(`Usage: \`${PREFIX}ticketfix orphan <#channel|id>\``).catch(() => {});
        return;
      }

      // Check it's not already registered
      const existing = getTicketByChannel(channelId);
      if (existing) {
        await message.reply({
          embeds: [Embed.info('Already Registered')
            .setDescription(
              `<#${channelId}> already has a ticket record: \`${existing.case_id}\` (${existing.status}).\n\n` +
              `If permissions are broken use \`${PREFIX}ticketfix perms ${channelId}\`.`
            )
            .toJSON()],
        });
        return;
      }

      // Fetch the channel
      const channel = await client.rest.get(`/channels/${channelId}`).catch(() => null);
      if (!channel) {
        await message.reply({
          embeds: [Embed.danger('Channel Not Found')
            .setDescription(`Could not fetch channel \`${channelId}\`. It may have already been deleted.`)
            .toJSON()],
        });
        return;
      }

      // Try to identify the user from the channel topic or name
      // Channel name format: support-XXXX
      // Channel topic format: "Ticket for username, Label"
      let userId   = null;
      let username = 'unknown';

      // FIX: if a userId was passed as a second arg, use it directly
      const manualUserId = parseId(rest[0]);
      if (manualUserId) {
        userId = manualUserId;
      }

      const topicMatch = channel.topic?.match(/Ticket for (.+?) —/);
      if (topicMatch) username = topicMatch[1];

      // Look for the oldest non-bot message to find the original user via REST
      if (!userId) {
        try {
          const msgs = await client.rest.get(`${`/channels/${channelId}/messages`}?limit=20`);
          const userMsg = (msgs ?? [])
            .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)))
            .find(m => !m.author?.bot);
          if (userMsg) {
            userId   = userMsg.author.id;
            username = userMsg.author.username;
          }
        } catch { /* channel may be empty */ }
      }

      if (!userId) {
        await message.reply({
          embeds: [Embed.warning('Cannot Identify User')
            .setDescription(
              `Could not determine which user this channel belongs to.\n\n` +
              `The channel has no non-bot messages to identify the user from. ` +
              `Provide the user ID manually:\n` +
              `\`${PREFIX}ticketfix orphan ${channelId} <userId>\``
            )
            .toJSON()],
        });
        return;
      }

      // Find a matching option by channel topic label
      const options      = getOptions(guildId);
      const labelMatch   = channel.topic?.match(/— (.+)$/);
      const optionLabel  = labelMatch?.[1] ?? null;
      const matchedOption = options.find(o => o.label === optionLabel) ?? options[0] ?? null;

      // Register in DB
      const { caseId } = registerExistingTicket({
        guildId,
        channelId,
        userId,
        username,
        optionEmoji: matchedOption?.emoji ?? null,
        optionLabel: matchedOption?.label ?? optionLabel ?? 'Support',
      });

      // Re-apply permissions
      if (cfg.support_role_id) {
        const permResults = await applyPerms(client.rest, channelId, guildId, cfg, userId, client.user.id);
        const failed      = permResults.filter(r => !r.ok);
        if (failed.length) {
          console.warn(`[TFIX] Orphan perm failures for ${channelId}:`, failed.map(r => r.label).join(', '));
        }
      }

      await message.reply({
        embeds: [Embed.success('Orphan Channel Registered')
          .setDescription(
            `<#${channelId}> has been registered as \`${caseId}\` and permissions have been re-applied.`
          )
          .addFields(
            { name: 'Case ID',   value: `\`${caseId}\``,            inline: true },
            { name: 'User',      value: `<@${userId}>`,              inline: true },
            { name: 'Category',  value: matchedOption?.label ?? '—', inline: true },
          )
          .addFields({ name: 'Next step', value: `Use \`${PREFIX}ticketfix resend ${channelId}\` to send the opening embed if it's missing.`, inline: false })
          .toJSON()],
      });
      return;
    }

    // ── !ticketfix perms <#channel|id> ─────────────────────
    // Re-apply the standard permission overwrites to a ticket channel
    if (subCmd === 'perms') {
      const channelId = parseId(arg1);
      if (!channelId) {
        await message.reply(`Usage: \`${PREFIX}ticketfix perms <#channel|id>\``).catch(() => {});
        return;
      }

      const ticket = getTicketByChannel(channelId);
      if (!ticket) {
        await message.reply({
          embeds: [Embed.warning('No Record Found')
            .setDescription(
              `<#${channelId}> has no ticket record in the DB.\n` +
              `If it's an orphan channel, register it first with \`${PREFIX}ticketfix orphan ${channelId}\`.`
            )
            .toJSON()],
        });
        return;
      }
      if (ticket.status === 'closed') {
        await message.reply({
          embeds: [Embed.info('Already Closed')
            .setDescription(`\`${ticket.case_id}\` is already closed. Permissions no longer need repair.`)
            .toJSON()],
        });
        return;
      }

      const channel = await client.rest.get(`/channels/${channelId}`).catch(() => null);
      if (!channel) {
        await message.reply({
          embeds: [Embed.danger('Channel Not Found')
            .setDescription(`Could not fetch <#${channelId}>. Use \`${PREFIX}ticketfix ghost ${ticket.user_id}\` if the channel was deleted.`)
            .toJSON()],
        });
        return;
      }

      if (!cfg.support_role_id) {
        await message.reply({
          embeds: [Embed.warning('No Support Role')
            .setDescription(`No support role is configured. Set one with \`${PREFIX}ticket role <@role>\` first.`)
            .toJSON()],
        });
        return;
      }

      const permResults = await applyPerms(client.rest, channelId, guildId, cfg, ticket.user_id, client.user.id);
      const failed      = permResults.filter(r => !r.ok);
      const succeeded   = permResults.filter(r => r.ok);

      const embed = (failed.length ? Embed.warning('Permissions Partially Applied') : Embed.success('Permissions Re-applied'))
        .setDescription(
          failed.length
            ? `Applied ${succeeded.length}/${permResults.length} overwrite(s). ${failed.length} failed:`
            : `All ${succeeded.length} permission overwrite(s) successfully re-applied to <#${channelId}>.`
        );

      if (failed.length) {
        embed.addFields({ name: 'Failed', value: failed.map(r => `${r.label}: ${r.err}`).join('\n'), inline: false });
      }

      embed.addFields(
        { name: 'Channel', value: `<#${channelId}>`,         inline: true },
        { name: 'Case',    value: `\`${ticket.case_id}\``,   inline: true },
        { name: 'User',    value: `<@${ticket.user_id}>`,    inline: true },
      );

      await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
      return;
    }

    // ── !ticketfix resend <#channel|id> ────────────────────
    // Re-send the opening embed to a ticket channel
    if (subCmd === 'resend') {
      const channelId = parseId(arg1);
      if (!channelId) {
        await message.reply(`Usage: \`${PREFIX}ticketfix resend <#channel|id>\``).catch(() => {});
        return;
      }

      const ticket = getTicketByChannel(channelId);
      if (!ticket) {
        await message.reply({
          embeds: [Embed.warning('No Record Found')
            .setDescription(
              `<#${channelId}> has no DB record. Register it first with \`${PREFIX}ticketfix orphan ${channelId}\`.`
            )
            .toJSON()],
        });
        return;
      }
      if (ticket.status === 'closed') {
        await message.reply({
          embeds: [Embed.info('Already Closed').setDescription(`\`${ticket.case_id}\` is already closed.`).toJSON()],
        });
        return;
      }

      const channelObj = await client.rest.get(`/channels/${channelId}`).catch(() => null);
      if (!channelObj) {
        await message.reply({
          embeds: [Embed.danger('Channel Not Found')
            .setDescription(`Could not fetch <#${channelId}>. The channel may have been deleted.`)
            .toJSON()],
        });
        return;
      }

      const options       = getOptions(guildId);
      const matchedOption = options.find(o => o.label === ticket.option_label) ?? null;
      // buildOpeningEmbed returns a raw embed object (not EmbedBuilder), use directly
      const embed         = buildOpeningEmbed(cfg, ticket, matchedOption);

      try {
        await client.rest.post(`/channels/${channelId}/messages`, {
          body: {
            content: `<@${ticket.user_id}>${cfg.support_role_id ? ` <@&${cfg.support_role_id}>` : ''}`,
            embeds:  [embed],
          },
        });
      } catch (err) {
        await message.reply({
          embeds: [Embed.danger('Send Failed')
            .setDescription(`Could not send to <#${channelId}>:\n\`${err.message}\`\n\nThe bot may not have permission to post there. Try \`${PREFIX}ticketfix perms ${channelId}\` first.`)
            .toJSON()],
        });
        return;
      }

      await message.reply({
        embeds: [Embed.success('Opening Embed Re-sent')
          .setDescription(`The ticket opening message has been re-sent to <#${channelId}>.`)
          .addFields(
            { name: 'Case', value: `\`${ticket.case_id}\``, inline: true },
            { name: 'User', value: `<@${ticket.user_id}>`,  inline: true },
          )
          .toJSON()],
      });
      return;
    }

    // ── !ticketfix clear <@user|id> ────────────────────────
    // Force-close all open DB records for a user, last resort
    if (subCmd === 'clear') {
      const targetId = parseId(arg1);
      if (!targetId) {
        await message.reply(`Usage: \`${PREFIX}ticketfix clear <@user|id>\``).catch(() => {});
        return;
      }

      // Check both 'open' and 'creating' statuses, a stale 'creating' row
      // also blocks the user from opening a new ticket
      const ticket = getOpenTicketByUser(guildId, targetId)
                  ?? getCreatingTicketByUser(guildId, targetId);
      if (!ticket) {
        await message.reply({
          embeds: [Embed.info('No Blocking Record')
            .setDescription(`<@${targetId}> has no open or in-progress ticket records.`)
            .toJSON()],
        });
        return;
      }

      const isCreating = ticket.status === 'creating';
      if (isCreating) {
        failTicket(ticket.case_id, `Force-cleared by <@${authorId}> via ticketfix`);
      } else {
        await closeTicket(client, guildId, ticket.case_id, authorId, `Force-cleared by <@${authorId}> via ticketfix`);
      }

      await message.reply({
        embeds: [Embed.success('Record Force-Cleared')
          .setDescription(
            `${isCreating ? 'Failed' : 'Closed'} \`${ticket.case_id}\` (was **${ticket.status}**) for <@${targetId}>.\n` +
            `They can now open a new ticket.\n\n` +
            `-# ⚠️ The Fluxer channel (if it still exists) was **not** deleted. Remove it manually if needed.`
          )
          .addFields(
            { name: 'Case ID',    value: `\`${ticket.case_id}\``,  inline: true },
            { name: 'Was Status', value: ticket.status,               inline: true },
            { name: 'User',       value: `<@${targetId}>`,            inline: true },
            { name: 'Cleared By', value: `<@${authorId}>`,            inline: true },
          )
          .toJSON()],
      });
      return;
    }

    // ── Unknown subcommand, reference card ────────────────
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.INFO)
          .setTitle('🔧  Ticket Fix: Reference')
          .setDescription('Repair ticket state left broken by a WS disconnect.')
          .addFields(
            { name: `\`${PREFIX}ticketfix scan\``,                value: 'Scan the guild for all broken ticket states',                                  inline: false },
            { name: `\`${PREFIX}ticketfix ghost <@user>\``,       value: 'Clear a DB record whose channel no longer exists (unblocks the user)',         inline: false },
            { name: `\`${PREFIX}ticketfix orphan <#channel>\``,   value: 'Register a channel that exists but has no DB record, then re-apply perms',     inline: false },
            { name: `\`${PREFIX}ticketfix perms <#channel>\``,    value: 'Re-apply all permission overwrites to an existing ticket channel',             inline: false },
            { name: `\`${PREFIX}ticketfix resend <#channel>\``,   value: 'Re-send the opening embed to a ticket channel that never received it',         inline: false },
            { name: `\`${PREFIX}ticketfix clear <@user>\``,       value: 'Force-close all open records for a user (last resort, does not delete channel)', inline: false },
          )
          .setFooter({ text: 'Start with scan to identify issues automatically.' })
          .toJSON(),
      ],
    });
  },
};