// ============================================================
//  commands/fun/confess.js
//
//  !confess setup #channel       , set confession channel
//  !confess moderation <on|off>  , require mod approval before posting
//  !confess replies <on|off>     , allow anon replies
//  !confess modchannel #channel  , where pending confessions go
//  !confess approve <id>         , approve a pending confession
//  !confess deny <id>            , deny without posting
//  !confess pending              , list awaiting approval
//  !confess blacklist add/remove <@user>
//  !confess reveal <id>          , Server Owner only: reveal author (logged)
//  !confess status               , show config
//
//  User flow (DM the bot):
//    confess <guildId> <message>
//    confessreply <guildId> <confessionNumber> <reply>
//
//  handleConfessDM() is exported and called from messageCreate
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import { resolveAccess } from '../../handlers/commandPermissions.js';
import { Permissions } from '../../config/guildPermissions.js';
import {
  getConfessionConfig, setConfessionConfig,
  isBlacklisted, blacklistConfessionUser, unblacklistConfessionUser,
  createConfession, getConfession, getPendingConfessions,
  setConfessionStatus, revealConfessionAuthor,
  approveConfession, denyConfession, ConfessionError,
  confessionEmbed, CONFESSION_COLOR,
} from '../../handlers/confessionSystem.js';

// ── DM handler ────────────────────────────────────────────────
export async function handleConfessDM(message, client) {
  if (message.author.bot) return;
  const content = message.content.trim();

  const isReply    = content.toLowerCase().startsWith('confessreply ');
  const isConfess  = content.toLowerCase().startsWith('confess ');
  if (!isConfess && !isReply) return;

  if (isConfess) {
    // confess <guildId> <text>
    const parts   = content.slice(8).trim().split(/\s+/);
    const guildId = parts[0];
    const text    = parts.slice(1).join(' ').trim();

    if (guildId && !/^\d{17,20}$/.test(guildId)) {
      await message.reply({ embeds: [Embed.warning('Invalid Server ID').setDescription('The server ID must be a numeric Fluxer snowflake.').toJSON()] }).catch(() => {});
      return;
    }

    if (!guildId || !text || text.length < 10) {
      await message.reply({ embeds: [Embed.warning('Format').setDescription('`confess <server_id> <your confession>`\nMinimum 10 characters.').toJSON()] }).catch(() => {});
      return;
    }

    const cfg = getConfessionConfig(guildId);
    if (!cfg.enabled || !cfg.channel_id) {
      await message.reply({ embeds: [Embed.warning('Not Enabled').setDescription('That server doesn\'t have confessions enabled.').toJSON()] }).catch(() => {});
      return;
    }

    if (isBlacklisted(guildId, message.author.id)) {
      await message.reply({ embeds: [Embed.warning('Blocked').setDescription('You are not allowed to submit confessions in that server.').toJSON()] }).catch(() => {});
      return;
    }

    if (text.length > 1000) {
      await message.reply({ embeds: [Embed.warning('Too Long').setDescription('Confessions must be under 1000 characters.').toJSON()] }).catch(() => {});
      return;
    }

    const id = createConfession({ guildId, authorId: message.author.id, content: text });

    // Raw REST throughout below, not client.channels.fetch() + channel.send():
    // confirmed in production that pattern fails with "channel.send is not
    // a function" for at least one channel type on v2.0.1's SDK.
    if (cfg.moderation && cfg.mod_channel_id) {
      // Hold for approval
      try {
        const pendingEmbed = new EmbedBuilder()
          .setTitle(`📋  Pending Confession #${id}`)
          .setDescription(text)
          .setColor(0xfbbf24)
          .setFooter({ text: `Use ${process.env.PREFIX || 'b!'}confess approve ${id} or deny ${id}, or the dashboard's Confessions page` })
          .setTimestamp();
        await client.rest.post(`/channels/${cfg.mod_channel_id}/messages`, { body: { embeds: [pendingEmbed.toJSON()] } });
      } catch { /* non-fatal */ }
      await message.reply({ embeds: [Embed.success('Confession Submitted').setDescription('Your confession is pending moderator approval and will be posted once reviewed.').toJSON()] }).catch(() => {});
    } else {
      // Post directly
      const msg = await client.rest.post(`/channels/${cfg.channel_id}/messages`, { body: { embeds: [confessionEmbed(id, text, null)] } }).catch(() => null);
      if (!msg) {
        await message.reply({ embeds: [Embed.warning('Error').setDescription('Couldn\'t reach the confession channel. Please try again later.').toJSON()] }).catch(() => {});
        return;
      }
      setConfessionStatus(id, 'posted', msg.id);
      await message.reply({ embeds: [Embed.success('Confession Posted').setDescription(`Your confession has been posted anonymously as **#${id}**.`).toJSON()] }).catch(() => {});
    }

  } else {
    // confessreply <guildId> <confessionId> <text>
    const parts    = content.slice(13).trim().split(/\s+/);
    const guildId  = parts[0];
    const replyTo  = parseInt(parts[1], 10);
    const text     = parts.slice(2).join(' ').trim();

    if (guildId && !/^\d{17,20}$/.test(guildId)) {
      await message.reply({ embeds: [Embed.warning('Invalid Server ID').setDescription('The server ID must be a numeric Fluxer snowflake.').toJSON()] }).catch(() => {});
      return;
    }

    if (!guildId || isNaN(replyTo) || !text || text.length < 5) {
      await message.reply({ embeds: [Embed.warning('Format').setDescription('`confessreply <server_id> <confession_number> <reply text>`').toJSON()] }).catch(() => {});
      return;
    }

    const cfg = getConfessionConfig(guildId);
    if (!cfg.enabled || !cfg.allow_replies || !cfg.channel_id) {
      await message.reply({ embeds: [Embed.warning('Not Enabled').setDescription('That server doesn\'t have confession replies enabled.').toJSON()] }).catch(() => {});
      return;
    }

    if (isBlacklisted(guildId, message.author.id)) {
      await message.reply({ embeds: [Embed.warning('Blocked').toJSON()] }).catch(() => {});
      return;
    }

    const original = getConfession(replyTo);
    if (!original || original.guild_id !== guildId || original.status !== 'posted') {
      await message.reply({ embeds: [Embed.warning('Not Found').setDescription(`Couldn't find confession #${replyTo} in that server.`).toJSON()] }).catch(() => {});
      return;
    }

    const id = createConfession({ guildId, authorId: message.author.id, content: text, replyTo });
    const msg = await client.rest.post(`/channels/${cfg.channel_id}/messages`, { body: { embeds: [confessionEmbed(id, text, replyTo)] } }).catch(() => null);
    if (!msg) return;
    setConfessionStatus(id, 'posted', msg.id);
    await message.reply({ embeds: [Embed.success('Reply Posted').setDescription(`Your reply to confession #${replyTo} has been posted anonymously as **#${id}**.`).toJSON()] }).catch(() => {});
  }
}

// ── Staff command ─────────────────────────────────────────────
export default {
  name: 'confess',
  aliases: ['confession', 'confessions'],
  description: 'Set up and manage the anonymous confession system. Members DM the bot to post confessions anonymously.',
  usage: '{prefix}confess setup #channel\n{prefix}confess moderation <on|off>\n{prefix}confess replies <on|off>\n{prefix}confess approve <id>\n{prefix}confess deny <id>\n{prefix}confess pending\n{prefix}confess blacklist <add|remove> <@user>\n{prefix}confess reveal <id>\n{prefix}confess status',
  category: 'fun',
  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    if (!guildId) return;

    const [sub, ...rest] = args;
    const cfg = getConfessionConfig(guildId);

    switch (sub?.toLowerCase()) {

      case 'setup': {
        const chId = rest[0]?.replace(/[<#>]/g, '');
        if (!chId) { await message.reply({ embeds: [Embed.warning('Missing Channel').toJSON()] }); return; }
        setConfessionConfig(guildId, { channel_id: chId, enabled: 1 });
        await message.reply({
          embeds: [Embed.success('Confessions Set Up')
            .setDescription(
              `Confessions will be posted to <#${chId}>.\n\n` +
              `Members DM the bot:\n\`confess ${guildId} <their confession>\`\n\n` +
              `Replies:\n\`confessreply ${guildId} <number> <reply>\``
            ).toJSON()],
        });
        break;
      }

      case 'enable': {
        setConfessionConfig(guildId, { enabled: 1 });
        await message.reply({ embeds: [Embed.success('Confessions Enabled').toJSON()] }).catch(() => {});
        break;
      }

      case 'disable': {
        setConfessionConfig(guildId, { enabled: 0 });
        await message.reply({ embeds: [Embed.success('Confessions Disabled').toJSON()] }).catch(() => {});
        break;
      }

      case 'moderation': {
        const on = rest[0]?.toLowerCase() === 'on';
        setConfessionConfig(guildId, { moderation: on ? 1 : 0 });
        await message.reply({ embeds: [Embed.success(`Moderation ${on ? 'Enabled' : 'Disabled'}`).setDescription(on ? 'Confessions will be held for approval before posting.' : 'Confessions will post immediately.').toJSON()] }).catch(() => {});
        break;
      }

      case 'modchannel': {
        const chId = rest[0]?.replace(/[<#>]/g, '');
        if (!chId) { await message.reply({ embeds: [Embed.warning('Missing Channel').toJSON()] }); return; }
        setConfessionConfig(guildId, { mod_channel_id: chId });
        await message.reply({ embeds: [Embed.success('Moderation Channel Set').setDescription(`Pending confessions will be sent to <#${chId}>.`).toJSON()] }).catch(() => {});
        break;
      }

      case 'replies': {
        const on = rest[0]?.toLowerCase() !== 'off';
        setConfessionConfig(guildId, { allow_replies: on ? 1 : 0 });
        await message.reply({ embeds: [Embed.success(`Replies ${on ? 'Enabled' : 'Disabled'}`).toJSON()] }).catch(() => {});
        break;
      }

      case 'approve':
      case 'deny': {
        // Shared with the dashboard's Confessions page (handlers/confessionSystem.js).
        const id = parseInt(rest[0], 10);
        try {
          if (sub.toLowerCase() === 'approve') {
            await approveConfession(client, guildId, id);
            await message.reply({ embeds: [Embed.success(`Confession #${id} Approved`).setDescription('Posted to the confession channel.').toJSON()] }).catch(() => {});
          } else {
            denyConfession(guildId, id);
            await message.reply({ embeds: [Embed.success(`Confession #${id} Denied`).setDescription('Confession removed. The user was not notified.').toJSON()] }).catch(() => {});
          }
        } catch (err) {
          if (!(err instanceof ConfessionError)) throw err;
          await message.reply({ embeds: [Embed.warning('Not Done').setDescription(err.message).toJSON()] }).catch(() => {});
        }
        break;
      }

      case 'pending': {
        const list = getPendingConfessions(guildId);
        if (!list.length) { await message.reply({ embeds: [Embed.info('No Pending Confessions').toJSON()] }); return; }
        const lines = list.map(c => `**#${c.id}**: ${c.content.slice(0, 80)}… <t:${Math.floor(c.submitted_at / 1000)}:R>`);
        await message.reply({ embeds: [new EmbedBuilder().setTitle(`📋 Pending Confessions (${list.length})`).setColor(0xfbbf24).setDescription(lines.join('\n')).toJSON()] }).catch(() => {});
        break;
      }

      case 'blacklist': {
        const action = rest[0]?.toLowerCase();
        const userId = rest[1]?.replace(/[<@!>]/g, '');
        if (!userId) { await message.reply({ embeds: [Embed.warning('Missing User').toJSON()] }); return; }
        if (action === 'add') {
          blacklistConfessionUser(guildId, userId);
          await message.reply({ embeds: [Embed.success('Blacklisted').setDescription(`<@${userId}> can no longer submit confessions.`).toJSON()] }).catch(() => {});
        } else if (action === 'remove') {
          unblacklistConfessionUser(guildId, userId);
          await message.reply({ embeds: [Embed.success('Removed from Blacklist').toJSON()] }).catch(() => {});
        } else {
          await message.reply({ embeds: [Embed.warning('Usage').setDescription(`\`${PREFIX}confess blacklist add|remove @user\``).toJSON()] }).catch(() => {});
        }
        break;
      }

      case 'reveal': {
        if (!await resolveAccess(client, guildId, message.author.id, 'confess', 'SERVER_OWNER')) {
          await message.reply({ embeds: [Embed.denied('Server Owner or higher').setDescription('Revealing confession authors requires Server Owner.').toJSON()] }).catch(() => {});
          return;
        }
        const id     = parseInt(rest[0], 10);
        const userId = id ? revealConfessionAuthor(id) : null;
        if (!userId) { await message.reply({ embeds: [Embed.warning('Not Found').toJSON()] }); return; }
        await message.reply({
          embeds: [new EmbedBuilder()
            .setTitle(`🔍  Confession #${id}: Author Revealed`)
            .setDescription(`Author: <@${userId}> \`${userId}\`\n\n-# This reveal has been logged.`)
            .setColor(0xf87171)
            .toJSON()],
        });
        // Log the reveal
        console.warn(`[CONFESS REVEAL] Confession #${id} revealed by ${message.author.id} (${message.author.username}), author: ${userId}`);
        break;
      }

      case 'status': // explicit alias, falls through to default embed
      default: {
        const enabled = cfg.enabled ? '✅ Enabled' : '❌ Disabled';
        await message.reply({
          embeds: [new EmbedBuilder()
            .setTitle('💜  Confession System: Status')
            .setColor(CONFESSION_COLOR)
            .addFields(
              { name: 'Status',        value: enabled,                                                                   inline: true  },
              { name: 'Channel',       value: cfg.channel_id ? `<#${cfg.channel_id}>` : 'Not set',                      inline: true  },
              { name: 'Moderation',    value: cfg.moderation ? '✅ On (approval required)' : '❌ Off (instant)',         inline: true  },
              { name: 'Replies',       value: cfg.allow_replies ? '✅ Enabled' : '❌ Disabled',                          inline: true  },
              { name: '📖 User Guide', value:
                `Members DM the bot:\n` +
                `\`confess ${guildId} <message>\`\n` +
                `\`confessreply ${guildId} <#> <reply>\``,
                inline: false },
            )
            .toJSON()],
        });
      }
    }
  },
};