// ─── !ticket setup/channel/category/role/title/description/icon/banner/color/remove/panel/status ───

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed } from '../../../config/embeds.js';
import {
  getTicketConfig as getConfig, setTicketField,
  getTicketOptions as getOptions,
} from '../../../handlers/ticketSystem/index.js';
import { parseChannelId, parseRoleId, hexToInt, buildPanelEmbed } from './helpers.js';

export async function handleConfig({ message, client, prefix, guildId, subCmd, rest }) {
  const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';

  switch (subCmd) {

    // ── !ticket setup ──────────────────────────────────────
    case 'setup': {
      await message.reply({ embeds: [Embed.info('🎫 Ticket System Setup')
        .setDescription(
          `Run these commands in order:\n\n` +
          `\`${PREFIX}ticket channel <#channel>\`: channel to post the panel\n` +
          `\`${PREFIX}ticket category <id>\`: Fluxer category for ticket channels\n` +
          `\`${PREFIX}ticket role <@role>\`: support role that can see tickets\n` +
          `\`${PREFIX}ticket title <text>\`: embed title\n` +
          `\`${PREFIX}ticket description <text>\`: embed description\n` +
          `\`${PREFIX}ticket icon <url>\`: thumbnail icon (optional)\n` +
          `\`${PREFIX}ticket color <#hex>\`: embed color (optional)\n` +
          `\`${PREFIX}ticket delay <seconds>\`: delay before a closed ticket's channel is deleted (optional, default 10)\n` +
          `\`${PREFIX}ticket option add <emoji> <label>\`: add up to 5 reaction options\n` +
          `\`${PREFIX}ticket panel\`: post the panel when ready\n` +
          `\`${PREFIX}ticket remove\`: remove the panel before relocating\n\n` +
          `-# Run \`${PREFIX}ticket status\` at any time to see current config.`
        ).toJSON()] });
      return;
    }

    // ── !ticket channel <#channel> ─────────────────────────
    case 'channel': {
      const channelId = parseChannelId(rest[0]);
      if (!channelId) {
        await message.reply({ embeds: [Embed.warning('Usage: `' + PREFIX + 'ticket channel <#channel>`').toJSON()] }).catch(() => {});
        return;
      }
      setTicketField(guildId, 'channel_id', channelId);
      await message.reply({ embeds: [Embed.success(`Panel channel set to <#${channelId}>.`).toJSON()] }).catch(() => {});
      return;
    }

    // ── !ticket category <id> ──────────────────────────────
    case 'category': {
      const raw = rest.join(' ').trim();
      if (!raw) {
        await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket category <category-id>\`\n-# Provide the Fluxer category channel ID.`).toJSON()] }).catch(() => {});
        return;
      }
      let categoryId = raw.match(/^\d{17,20}$/) ? raw : null;
      if (!categoryId) {
        try {
          const channels = await client.rest.get(`/guilds/${guildId}/channels`);
          const match = channels?.find(c =>
            c.name?.toLowerCase() === raw.toLowerCase() && c.type === 4 // GUILD_CATEGORY = 4
          );
          categoryId = match?.id ?? null;
        } catch { /* fall through to not-found */ }
      }
      if (!categoryId) {
        await message.reply({ embeds: [Embed.warning('Category not found. Provide the category channel ID.').toJSON()] }).catch(() => {});
        return;
      }
      setTicketField(guildId, 'category_id', categoryId);
      await message.reply({ embeds: [Embed.success(`Ticket category set to \`${categoryId}\`.`).toJSON()] }).catch(() => {});
      return;
    }

    // ── !ticket role <@role> ───────────────────────────────
    case 'role': {
      const roleId = parseRoleId(rest[0]);
      if (!roleId) {
        await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket role <@role>\``).toJSON()] }).catch(() => {});
        return;
      }
      setTicketField(guildId, 'support_role_id', roleId);
      await message.reply({ embeds: [Embed.success(`Support role set to <@&${roleId}>.\n-# This role will have access to all ticket channels.`).toJSON()] }).catch(() => {});
      return;
    }

    // ── !ticket title <text> ───────────────────────────────
    case 'title': {
      const text = rest.join(' ').trim();
      if (!text) {
        await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket title <text>\``).toJSON()] }).catch(() => {});
        return;
      }
      setTicketField(guildId, 'title', text);
      await message.reply({ embeds: [Embed.success(`Panel title set to **${text}**.`).toJSON()] }).catch(() => {});
      return;
    }

    // ── !ticket description <text> ─────────────────────────
    case 'description': {
      const text = rest.join(' ').trim();
      if (!text) {
        await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket description <text>\``).toJSON()] }).catch(() => {});
        return;
      }
      setTicketField(guildId, 'description', text);
      await message.reply({ embeds: [Embed.success('Panel description updated.').toJSON()] }).catch(() => {});
      return;
    }

    // ── !ticket icon <url> ─────────────────────────────────
    case 'icon': {
      const url = rest[0]?.trim();
      if (url === 'remove' || url === 'clear') {
        setTicketField(guildId, 'icon_url', null);
        await message.reply({ embeds: [Embed.success(`Thumbnail icon removed.\n-# Run \`${PREFIX}ticket panel\` to repost.`).toJSON()] }).catch(() => {});
        return;
      }
      if (!url || !url.startsWith('http')) {
        await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket icon <url>\` (must be a valid http(s) URL, or \`remove\` to clear)`).toJSON()] }).catch(() => {});
        return;
      }
      setTicketField(guildId, 'icon_url', url);
      await message.reply({ embeds: [Embed.success(`Thumbnail icon set.\n-# Run \`${PREFIX}ticket panel\` to repost the panel.`).toJSON()] }).catch(() => {});
      return;
    }

    // ── !ticket banner <url|remove> ────────────────────────
    // Large image displayed below the panel description.
    case 'banner': {
      const url = rest[0]?.trim();
      if (!url) {
        await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket banner <url>\` or \`${PREFIX}ticket banner remove\` to clear.`).toJSON()] }).catch(() => {});
        return;
      }
      if (url === 'remove' || url === 'clear') {
        setTicketField(guildId, 'banner_url', null);
        await message.reply({ embeds: [Embed.success(`Banner image removed.\n-# Run \`${PREFIX}ticket panel\` to repost the panel.`).toJSON()] }).catch(() => {});
        return;
      }
      if (!url.startsWith('http')) {
        await message.reply({ embeds: [Embed.warning('Must be a valid http(s) URL.').toJSON()] }).catch(() => {});
        return;
      }
      setTicketField(guildId, 'banner_url', url);
      await message.reply({ embeds: [Embed.success(`Banner image set.\n-# Run \`${PREFIX}ticket panel\` to repost the panel.`).toJSON()] }).catch(() => {});
      return;
    }

    // ── !ticket color <#hex> ───────────────────────────────
    case 'color': {
      const color = hexToInt(rest[0] ?? '');
      if (color === null) {
        await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket color <#hex>\` e.g. \`#5865F2\``).toJSON()] }).catch(() => {});
        return;
      }
      setTicketField(guildId, 'color', color);
      await message.reply({ embeds: [Embed.success('Panel color updated.').toJSON()] }).catch(() => {});
      return;
    }

    // ── !ticket closeemoji <emoji|reset> ────────────────────
    // The emoji on a ticket's close button, as on the dashboard.
    case 'closeemoji': {
      const raw = rest[0]?.trim();
      if (!raw) {
        await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket closeemoji <emoji>\` or \`reset\` for ❌`).toJSON()] }).catch(() => {});
        return;
      }
      const reset = raw.toLowerCase() === 'reset';
      // An emoji, or a custom one as <:name:id>; nothing long or with spaces.
      if (!reset && (raw.length > 64 || /\s/.test(raw) || /^[\w#@!.]+$/.test(raw))) {
        await message.reply({ embeds: [Embed.warning('That doesn\'t look like an emoji. Use one emoji, like 🔒.').toJSON()] }).catch(() => {});
        return;
      }
      setTicketField(guildId, 'close_emoji', reset ? null : raw);
      await message.reply({ embeds: [Embed.success(`Close button emoji set to ${reset ? '❌ (the default)' : raw}. New tickets use it.`).toJSON()] }).catch(() => {});
      return;
    }

    // ── !ticket delay <seconds> ─────────────────────────────
    // How long a closed ticket's closing notice stays up before the channel
    // is deleted. Persisted (not just an in-memory timer), see
    // handlers/ticketSystem/deletionPoller.js for why that matters.
    case 'delay': {
      const seconds = parseInt(rest[0], 10);
      if (!rest[0] || isNaN(seconds) || seconds < 0 || seconds > 3600) {
        await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket delay <seconds>\` (0-3600)`).toJSON()] }).catch(() => {});
        return;
      }
      setTicketField(guildId, 'close_delay_seconds', seconds);
      await message.reply({ embeds: [Embed.success(`Channel deletion delay set to **${seconds}** second${seconds === 1 ? '' : 's'} after closing.`).toJSON()] }).catch(() => {});
      return;
    }

    // ── !ticket remove ────────────────────────────────────
    // Deletes the live panel from Fluxer and clears the panel_message_id
    // from the DB so the next `!ticket panel` posts fresh without conflicts.
    // Use this whenever you need to relocate the panel to a new channel:
    //   1. !ticket remove
    //   2. !ticket channel <#new-channel>
    //   3. !ticket panel
    case 'remove': {
      const cfg = getConfig(guildId);

      if (!cfg?.panel_message_id) {
        await message.reply({ embeds: [Embed.info(`No panel is currently tracked in the database.\n-# Use \`${PREFIX}ticket panel\` to post one.`).toJSON()] });
        return;
      }

      try {
        await client.rest.delete(`/channels/${cfg.channel_id}/messages/${cfg.panel_message_id}`);
      } catch { /* already deleted or missing, still clear DB */ }

      setTicketField(guildId, 'panel_message_id', null);

      await message.reply({ embeds: [Embed.success(`Panel removed from <#${cfg.channel_id}>.\n-# To relocate: \`${PREFIX}ticket channel <#new-channel>\` then \`${PREFIX}ticket panel\``).toJSON()] });
      return;
    }

    // ── !ticket panel [delete] ────────────────────────────
    case 'panel': {
      if (rest[0]?.toLowerCase() === 'delete') {
        const cfg = getConfig(guildId);
        if (!cfg?.panel_message_id) {
          await message.reply({ embeds: [Embed.info('No panel message is currently set in the database.').toJSON()] }).catch(() => {});
          return;
        }
        try {
          await client.rest.delete(`/channels/${cfg.channel_id}/messages/${cfg.panel_message_id}`);
        } catch { /* already deleted or missing, still clear DB */ }
        setTicketField(guildId, 'panel_message_id', null);
        await message.reply({ embeds: [Embed.success(`Panel message deleted.\n-# Use \`${PREFIX}ticket panel\` to repost it.`).toJSON()] }).catch(() => {});
        return;
      }

      const cfg     = getConfig(guildId);
      const options = getOptions(guildId);

      if (!cfg?.channel_id) {
        await message.reply({ embeds: [Embed.warning(`No panel channel set. Run \`${PREFIX}ticket channel <#channel>\` first.`).toJSON()] }).catch(() => {});
        return;
      }
      if (!cfg.support_role_id) {
        await message.reply({ embeds: [Embed.warning(`No support role set. Run \`${PREFIX}ticket role <@role>\` first.`).toJSON()] }).catch(() => {});
        return;
      }
      if (!options.length) {
        await message.reply({ embeds: [Embed.warning(`No reaction options configured. Add at least one with \`${PREFIX}ticket option add <emoji> <label>\`.`).toJSON()] }).catch(() => {});
        return;
      }

      const embed = buildPanelEmbed(cfg, options);

      if (cfg.panel_message_id) {
        try {
          await client.rest.delete(`/channels/${cfg.channel_id}/messages/${cfg.panel_message_id}`);
        } catch { /* already deleted */ }
      }

      // Post new panel via REST, returns raw message object.
      // msg.react() is not available on raw objects, so we call the REST
      // reaction endpoint directly in the loop below.
      const msg = await client.rest.post(`/channels/${cfg.channel_id}/messages`, {
        body: { embeds: [embed] },
      });

      // Route: PUT /channels/:channel_id/messages/:message_id/reactions/:emoji/@me
      // Emoji format: raw unicode char or "name:id" for custom, both must be percent-encoded.
      for (const opt of options) {
        try {
          const encodedEmoji = encodeURIComponent(opt.emoji);
          await client.rest.put(`/channels/${cfg.channel_id}/messages/${msg.id}/reactions/${encodedEmoji}/@me`);
        } catch (err) {
          console.warn(`[TICKETS] Could not add reaction ${opt.emoji}:`, err.message);
        }
      }

      setTicketField(guildId, 'panel_message_id', msg.id);

      await message.reply({ embeds: [Embed.success(`Panel posted in <#${cfg.channel_id}>.\n-# ${options.length} reaction option(s) added. Message ID: \`${msg.id}\``).toJSON()] });
      return;
    }

    // ── !ticket status ─────────────────────────────────────
    case 'status': {
      const cfg     = getConfig(guildId);
      const options = getOptions(guildId);

      if (!cfg) {
        await message.reply({ embeds: [Embed.info(`Ticket system not configured yet. Run \`${PREFIX}ticket setup\` to get started.`).toJSON()] }).catch(() => {});
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('🎫 Ticket System Status')
        .setColor(cfg.color ?? 0x5865F2)
        .addFields(
          { name: 'Panel Channel',   value: cfg.channel_id      ? `<#${cfg.channel_id}>`      : '❌ not set', inline: true },
          { name: 'Ticket Category', value: cfg.category_id     ? `\`${cfg.category_id}\``    : '❌ not set', inline: true },
          { name: 'Support Role',    value: cfg.support_role_id ? `<@&${cfg.support_role_id}>` : '❌ not set', inline: true },
          { name: 'Panel Title',     value: cfg.title,                                          inline: true },
          { name: 'Panel Message',   value: cfg.panel_message_id ? `\`${cfg.panel_message_id}\`` : '❌ not posted', inline: true },
          { name: 'Delete Delay',    value: `${cfg.close_delay_seconds ?? 10}s`,                 inline: true },
          { name: 'Close Emoji',     value: cfg.close_emoji || '❌',                             inline: true },
          { name: 'Options',         value: options.length
            ? options.map(o => `${o.emoji} ${o.label}`).join('\n')
            : '❌ none',
            inline: false },
        );

      await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
      return;
    }
  }
}

export const CONFIG_SUBCOMMANDS = new Set([
  'setup', 'channel', 'category', 'role', 'title', 'description',
  'icon', 'banner', 'color', 'delay', 'remove', 'panel', 'status', 'closeemoji',
]);
