// ============================================================
//  commands/moderation/appeal.js
//
//  Staff commands:
//    !appeal channel <#channel>   , set appeals channel
//    !appeal enable / disable     , toggle the system
//    !appeal cooldown <days>      , set days between appeals
//    !appeal list                 , list pending appeals
//    !appeal approve <id> [reason], approve an appeal (unbans)
//    !appeal deny <id> [reason]   , deny an appeal
//    !appeal status               , show config
//
//  User flow: banned users DM the bot with:
//    appeal <guild_id> <their reason>
//  (The bot's help command / ban message should tell them this.)
//
//  The handleAppealDM() export is called from the bot's messageCreate
//  event handler when a DM is received.
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';
import { clearPendingTempbans } from '../../handlers/warnSystem.js';
import { isChannelInGuild } from '../../utils/channelGuard.js';
import {
  getAppealConfig, setAppealConfig,
  getLastAppeal, createAppeal, setAppealMessageId,
  getAppeal, getPendingAppeals, resolveAppeal,
} from '../../handlers/appealSystem.js';

// ── DM handler, called from messageCreate when channel.type === 'DM' ──
export async function handleAppealDM(message, client) {
  if (message.author.bot) return;

  const content = message.content.trim();
  if (!content.toLowerCase().startsWith('appeal ')) return;

  // Format: appeal <guildId> <reason text>
  const parts   = content.slice(7).trim().split(/\s+/);
  const guildId = parts[0];
  const reason  = parts.slice(1).join(' ').trim();

  // Validate guildId is a snowflake (17-20 digits) before any DB hit
  if (guildId && !/^\d{17,20}$/.test(guildId)) {
    await message.reply({
      embeds: [Embed.warning('Invalid Server ID').setDescription('The server ID must be a numeric Fluxer snowflake.').toJSON()],
    }).catch(() => {});
    return;
  }

  if (!guildId || !reason || reason.length < 20) {
    await message.reply({
      embeds: [Embed.warning('Invalid Format')
        .setDescription(
          'To submit a ban appeal, DM me:\n\n' +
          '`appeal <server_id> <your reason>`\n\n' +
          '**Example:**\n`appeal 123456789012345678 I was banned unfairly, I didn\'t break any rules and...'  +
          '`\n\nYour reason must be at least 20 characters.'
        ).toJSON()],
    });
    return;
  }

  // Check guild exists and has appeals enabled
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    await message.reply({ embeds: [Embed.warning('Server Not Found').setDescription('I couldn\'t find that server. Make sure you copied the server ID correctly.').toJSON()] }).catch(() => {});
    return;
  }

  const config = getAppealConfig(guildId);
  if (!config.enabled || !config.channel_id) {
    await message.reply({ embeds: [Embed.warning('Appeals Disabled').setDescription('That server does not have ban appeals enabled.').toJSON()] }).catch(() => {});
    return;
  }

  // Check user is actually banned
  const ban = await client.rest.get(`/guilds/${guildId}/bans/${message.author.id}`).catch(() => null);
  if (!ban) {
    await message.reply({ embeds: [Embed.warning('Not Banned').setDescription('You don\'t appear to be banned from that server.').toJSON()] }).catch(() => {});
    return;
  }

  // Cooldown check
  const last = getLastAppeal(guildId, message.author.id);
  if (last && last.status !== 'approved') {
    const cooldownMs  = config.cooldown_days * 86_400_000;
    const nextAllowed = last.submitted_at + cooldownMs;
    if (Date.now() < nextAllowed) {
      const ts = Math.floor(nextAllowed / 1000);
      await message.reply({
        embeds: [Embed.warning('Cooldown Active').setDescription(`You already submitted an appeal recently. You can submit again <t:${ts}:R>.`).toJSON()],
      });
      return;
    }
  }

  // Create appeal
  const appealId = createAppeal({
    guildId,
    userId: message.author.id,
    username: message.author.username,
    reason,
  });

  // Post to appeals channel. Raw REST, not client.channels.fetch() +
  // channel.send(): confirmed in production that pattern fails with
  // "channel.send is not a function" for at least one channel type.
  const banReason = ban.reason ?? 'No reason provided';
  const appealEmbed = new EmbedBuilder()
    .setTitle(`📋  Ban Appeal #${appealId}`)
    .setColor(COLORS.WARNING)
    .addFields(
      { name: '👤  User',        value: `<@${message.author.id}> \`${message.author.id}\``, inline: true  },
      { name: '📅  Submitted',   value: `<t:${Math.floor(Date.now() / 1000)}:R>`,            inline: true  },
      { name: '🔨  Ban Reason',  value: banReason.slice(0, 512),                             inline: false },
      { name: '📝  Appeal Text', value: reason.slice(0, 1000),                               inline: false },
    )
    .setFooter({ text: `Appeal ID: ${appealId} • Use !appeal approve/deny ${appealId} [reason]` });

  const appealMsg = await client.rest.post(`/channels/${config.channel_id}/messages`, {
    body: { embeds: [appealEmbed.toJSON()] },
  }).catch(() => null);
  if (!appealMsg) {
    await message.reply({ embeds: [Embed.warning('Channel Missing').setDescription('The appeals channel for that server seems to be deleted. Please contact the server staff directly.').toJSON()] }).catch(() => {});
    return;
  }
  setAppealMessageId(appealId, appealMsg.id);

  await message.reply({
    embeds: [Embed.success('Appeal Submitted')
      .setDescription(
        `Your appeal for **${guild.name}** has been submitted (Appeal #${appealId}).\n\n` +
        `Staff will review it and you\'ll receive a DM when a decision is made.\n\n` +
        `-# You can submit another appeal in **${config.cooldown_days} days** if this one is denied.`
      ).toJSON()],
  });
}

// ── Staff command ─────────────────────────────────────────────
export default {
  name: 'appeal',
  aliases: ['appeals', 'banappeal'],
  description: 'Review ban appeals: set the appeals channel, list pending appeals, and approve (unbans) or deny them. Banned members appeal by DMing the bot: appeal <server id> <reason>.',
  usage: '{prefix}appeal <list | approve <id> [reason] | deny <id> [reason]>\n{prefix}appeal <channel #channel | enable | disable | cooldown <days> | status>',
  category: 'moderation',
  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 3,

  async execute({ message, args, client, prefix }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    const guildId = message.guildId;
    if (!guildId) return;

    const [sub, ...rest] = args;
    const config = getAppealConfig(guildId);

    switch (sub?.toLowerCase()) {

      case 'channel': {
        const chId = rest[0]?.replace(/[<#>]/g, '');
        if (!chId) {
          await message.reply({ embeds: [Embed.warning('Missing Channel').setDescription(`Usage: \`${PREFIX}appeal channel #channel\``).toJSON()] }).catch(() => {});
          return;
        }
        // Appeals contain the banned user's text and ban reason; they must
        // only ever be posted inside this server.
        if (!await isChannelInGuild(client, guildId, chId)) {
          await message.reply({ embeds: [Embed.warning('Invalid Channel').setDescription('That channel is not in this server.').toJSON()] }).catch(() => {});
          return;
        }
        setAppealConfig(guildId, { channel_id: chId });
        await message.reply({ embeds: [Embed.success('Appeals Channel Set').setDescription(`Appeals will be posted to <#${chId}>.`).toJSON()] }).catch(() => {});
        break;
      }

      case 'enable': {
        if (!config.channel_id) {
          await message.reply({ embeds: [Embed.warning('No Channel Set').setDescription(`Set an appeals channel first: \`${PREFIX}appeal channel #channel\``).toJSON()] }).catch(() => {});
          return;
        }
        setAppealConfig(guildId, { enabled: 1 });
        await message.reply({ embeds: [Embed.success('Appeals Enabled').setDescription('Banned users can now DM the bot to submit an appeal.').toJSON()] }).catch(() => {});
        break;
      }

      case 'disable': {
        setAppealConfig(guildId, { enabled: 0 });
        await message.reply({ embeds: [Embed.success('Appeals Disabled').toJSON()] }).catch(() => {});
        break;
      }

      case 'cooldown': {
        const days = parseInt(rest[0], 10);
        if (isNaN(days) || days < 1 || days > 365) {
          await message.reply({ embeds: [Embed.warning('Invalid').setDescription('Provide a number of days between 1 and 365.').toJSON()] }).catch(() => {});
          return;
        }
        setAppealConfig(guildId, { cooldown_days: days });
        await message.reply({ embeds: [Embed.success('Cooldown Set').setDescription(`Users must wait **${days} days** between appeals.`).toJSON()] }).catch(() => {});
        break;
      }

      case 'list': {
        const pending = getPendingAppeals(guildId);
        if (!pending.length) {
          await message.reply({ embeds: [Embed.info('No Pending Appeals').setDescription('There are no open appeals to review.').toJSON()] }).catch(() => {});
          return;
        }
        const lines = pending.map(a =>
          `**#${a.id}**: <@${a.user_id}> \`${a.user_id}\` • submitted <t:${Math.floor(a.submitted_at / 1000)}:R>`
        );
        await message.reply({
          embeds: [new EmbedBuilder()
            .setTitle(`📋  Pending Appeals (${pending.length})`)
            .setColor(COLORS.WARNING)
            .setDescription(lines.join('\n'))
            .setFooter({ text: `Use !appeal approve <id> or !appeal deny <id> to action` })
            .toJSON()],
        });
        break;
      }

      case 'approve': {
        const id     = parseInt(rest[0], 10);
        const appeal = id ? getAppeal(id) : null;
        if (!appeal || appeal.guild_id !== guildId) {
          await message.reply({ embeds: [Embed.warning('Not Found').toJSON()] }).catch(() => {});
          return;
        }
        if (appeal.status !== 'pending') {
          await message.reply({ embeds: [Embed.warning('Already Handled').setDescription(`Appeal #${id} is already **${appeal.status}**.`).toJSON()] }).catch(() => {});
          return;
        }

        const reason = rest.slice(1).join(' ') || 'Appeal approved by staff.';

        // Unban first; the appeal is only marked approved (and the user only
        // told they're unbanned) once that actually worked. 404 means they
        // weren't banned anymore, which is fine.
        try {
          await client.rest.delete(`/guilds/${guildId}/bans/${appeal.user_id}?reason=${encodeURIComponent(`Appeal #${id} approved by ${message.author.username}: ${reason}`)}`);
        } catch (err) {
          if (!(err.statusCode === 404 || err.status === 404)) {
            await message.reply({ embeds: [Embed.danger('Unban Failed').setDescription(`Couldn't unban <@${appeal.user_id}>: ${err.message}\nAppeal #${id} is still pending, check my Ban Members permission and try again.`).toJSON()] }).catch(() => {});
            return;
          }
        }
        clearPendingTempbans(guildId, appeal.user_id);
        resolveAppeal(id, message.author.id, 'approved', reason);

        // DM the user
        try {
          const guildName = (await client.rest.get(`/guilds/${guildId}`).catch(() => null))?.name ?? 'the server';
          const dm = await client.rest.post('/users/@me/channels', { body: { recipient_id: appeal.user_id } }).catch(() => null);
          if (dm) {
            await client.channels.send(dm.id, {
              embeds: [Embed.success('Ban Appeal Approved')
                .setDescription(
                  `Your ban appeal from **${guildName}** has been **approved**.\n\n` +
                  `**Staff Note:** ${reason}\n\n` +
                  `You have been unbanned and may rejoin the server.`
                ).toJSON()],
            }).catch(() => {});
          }
        } catch { /* DMs closed */ }

        // Update appeal embed
        if (appeal.message_id && config.channel_id) {
          try {
            {
              // config.channel_id is already the channel ID, fetching a
              // channel object here just to read its own .id back was
              // pointless, and exposed this to the same unreliable
              // client.channels.fetch() behavior for no benefit.
              const updated = new EmbedBuilder()
                .setTitle(`✅  Appeal #${id}: Approved`)
                .setColor(COLORS.SUCCESS)
                .addFields(
                  { name: '👤 User',       value: `<@${appeal.user_id}>`, inline: true },
                  { name: '👮 Actioned By', value: `<@${message.author.id}>`, inline: true },
                  { name: '📋 Reason',     value: reason, inline: false },
                );
              await client.rest.patch(`/channels/${config.channel_id}/messages/${appeal.message_id}`, { body: { embeds: [updated.toJSON()] } }).catch(() => {});
            }
          } catch { /* non-fatal */ }
        }

        await message.reply({ embeds: [Embed.success(`Appeal #${id} Approved`).setDescription(`<@${appeal.user_id}> has been unbanned. They've been notified by DM.`).toJSON()] }).catch(() => {});
        break;
      }

      case 'deny': {
        const id     = parseInt(rest[0], 10);
        const appeal = id ? getAppeal(id) : null;
        if (!appeal || appeal.guild_id !== guildId) {
          await message.reply({ embeds: [Embed.warning('Not Found').toJSON()] }).catch(() => {});
          return;
        }
        if (appeal.status !== 'pending') {
          await message.reply({ embeds: [Embed.warning('Already Handled').setDescription(`Appeal #${id} is already **${appeal.status}**.`).toJSON()] }).catch(() => {});
          return;
        }

        const reason = rest.slice(1).join(' ') || 'Appeal denied by staff.';
        resolveAppeal(id, message.author.id, 'denied', reason);

        // DM the user
        try {
          const guildName = (await client.rest.get(`/guilds/${guildId}`).catch(() => null))?.name ?? 'the server';
          const dm = await client.rest.post('/users/@me/channels', { body: { recipient_id: appeal.user_id } }).catch(() => null);
          if (dm) {
            await client.channels.send(dm.id, {
              embeds: [Embed.danger('Ban Appeal Denied')
                .setDescription(
                  `Your ban appeal from **${guildName}** has been **denied**.\n\n` +
                  `**Staff Note:** ${reason}\n\n` +
                  `-# You may resubmit an appeal after ${config.cooldown_days} days.`
                ).toJSON()],
            }).catch(() => {});
          }
        } catch { /* DMs closed */ }

        // Update appeal embed
        if (appeal.message_id && config.channel_id) {
          try {
            {
              const updated = new EmbedBuilder()
                .setTitle(`❌  Appeal #${id}: Denied`)
                .setColor(COLORS.DANGER)
                .addFields(
                  { name: '👤 User',       value: `<@${appeal.user_id}>`, inline: true },
                  { name: '👮 Actioned By', value: `<@${message.author.id}>`, inline: true },
                  { name: '📋 Reason',     value: reason, inline: false },
                );
              await client.rest.patch(`/channels/${config.channel_id}/messages/${appeal.message_id}`, { body: { embeds: [updated.toJSON()] } }).catch(() => {});
            }
          } catch { /* non-fatal */ }
        }

        await message.reply({ embeds: [Embed.success(`Appeal #${id} Denied`).setDescription(`<@${appeal.user_id}> has been notified by DM.`).toJSON()] }).catch(() => {});
        break;
      }

      case 'status':
      default: {
        await message.reply({
          embeds: [new EmbedBuilder()
            .setTitle('📋  Ban Appeals: Status')
            .setColor(COLORS.INFO)
            .addFields(
              { name: 'Status',      value: config.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
              { name: 'Channel',     value: config.channel_id ? `<#${config.channel_id}>` : 'Not set', inline: true },
              { name: 'Cooldown',    value: `${config.cooldown_days} day(s)`, inline: true },
              { name: '📖 How it works', value:
                `Banned users DM the bot:\n\`\`\`appeal ${guildId} <their reason>\`\`\`\n` +
                `The appeal posts to the appeals channel. Staff use \`${PREFIX}appeal approve/deny <id>\` to action it.`,
                inline: false },
            )
            .toJSON()],
        });
      }
    }
  },
};
