// ============================================================
//  commands/general/bugreport.js
//
//  !bugreport <description>
//  Optionally attach an image to include a screenshot.
//
//  Sends a formatted report to REPORT_WEBHOOK (Fluxer webhook URL)
//  and DMs the reporter a confirmation with their report ID.
//
//  Env vars:
//    REPORT_WEBHOOK         , Fluxer webhook URL to receive reports
//    REPORT_CONTACT_INVITE  , Optional: server invite link shown to reporter
//    REPORT_CONTACT_EMAIL   , Optional: contact email shown to reporter
//    BLOO_PFP_URL           , Optional: bot avatar for the webhook message
// ============================================================

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed }        from '../../config/embeds.js';
import { siteUrl }      from '../../config/site.js';

// Generate a short unique report ID: RPT-XXXXXX
function makeReportId() {
  return 'RPT-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Post to a Fluxer webhook URL
async function postToWebhook(webhookUrl, payload) {
  const url = webhookUrl.includes('?') ? webhookUrl : `${webhookUrl}?wait=true`;
  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!r.ok && r.status !== 204)
    throw new Error(`Webhook returned HTTP ${r.status}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

export default {
  name:    'bugreport',
  aliases: ['report', 'feedback'],
  description: 'Submit a bug report or feedback to the Bloo team. Attach an image for screenshots.',
  usage:   '{prefix}bugreport <description>',
  category: 'general',

  requiredPermission: null,

  cooldown:          60, // 1 minute cooldown to prevent spam

  async execute({ message, args, client, prefix }) {
    const webhookUrl = process.env.REPORT_WEBHOOK;

    if (!webhookUrl) {
      await message.reply({
        embeds: [Embed.info('Reports Unavailable')
          .setDescription('The bug report system is not configured yet.')
          .toJSON()],
      });
      return;
    }

    const description = args.join(' ').trim();
    if (!description) {
      await message.reply({
        embeds: [Embed.info('Bug Report')
          .setDescription(
            `**Usage:** \`${prefix}bugreport <description>\`\n\n` +
            `Describe the issue clearly. You can attach a screenshot by uploading an image with your message.\n\n` +
            `**Tips for a good report:**\n` +
            `• What command or feature were you using?\n` +
            `• What did you expect to happen?\n` +
            `• What actually happened?\n` +
            `• Does it happen every time or occasionally?`
          )
          .toJSON()],
      });
      return;
    }

    if (description.length < 10) {
      await message.reply({
        embeds: [Embed.danger('Too Short')
          .setDescription('Please provide a more detailed description (at least 10 characters).')
          .toJSON()],
      });
      return;
    }

    if (description.length > 1800) {
      await message.reply({
        embeds: [Embed.danger('Too Long')
          .setDescription('Description must be under 1800 characters.')
          .toJSON()],
      });
      return;
    }

    // Find attached image (first image attachment if any)
    const attachments = message.attachments
      ? (Array.isArray(message.attachments)
          ? message.attachments
          : [...(message.attachments.values?.() ?? [])])
      : [];
    const image = attachments.find(a =>
      a.contentType?.startsWith('image/') ||
      /\.(png|jpg|jpeg|gif|webp)$/i.test(a.url ?? a.filename ?? '')
    );

    const reportId  = makeReportId();
    const guildId   = message.guildId;
    const userId    = message.author.id;
    const username  = message.author.username;
    const ts        = Math.floor(Date.now() / 1000);

    // Resolve guild name
    const guild = message.guild
      ?? client.guilds?.cache?.get(guildId)
      ?? await client.guilds.fetch(guildId).catch(() => null);
    const guildName = guild?.name ?? `Unknown (${guildId})`;

    // ── Build webhook embed ──────────────────────────────────
    const reportEmbed = {
      color:  0xf87171,
      title:  `🐛 Bug Report: ${reportId}`,
      fields: [
        { name: '📋 Description', value: description,                              inline: false },
        { name: '🏠 Server',      value: `${guildName}\n\`${guildId}\``,           inline: true  },
        { name: '👤 Reporter',    value: `<@${userId}>\n${username}`,              inline: true  },
        { name: '📍 Channel',     value: `<#${message.channelId}>`,                inline: true  },
        { name: '🕐 Time',        value: `<t:${ts}:F>`,                            inline: true  },
        { name: '🆔 Report ID',   value: `\`${reportId}\``,                        inline: true  },
        { name: '📩 Reply',       value: `To contact: reply to this message or DM <@${userId}> (ID: \`${userId}\`)`, inline: false },
      ],
      footer:    { text: 'Bloo Bug Report System' },
      timestamp: new Date().toISOString(),
    };

    if (image) {
      reportEmbed.image = { url: image.url };
      reportEmbed.fields.splice(1, 0, {
        name: '📸 Screenshot', value: '(see image below)', inline: false,
      });
    }

    // ── Post to webhook ──────────────────────────────────────
    try {
      await postToWebhook(webhookUrl, {
        username:   'Bloo Reports',
        avatar_url: process.env.BLOO_PFP_URL || 'https://bloo-bot.xyz/assets/bloo-pfp.png',
        embeds:  [reportEmbed],
      });
    } catch (err) {
      console.error('[BUGREPORT] Webhook post failed:', err.message);
      await message.reply({
        embeds: [Embed.danger('Submission Failed')
          .setDescription('Could not submit your report. Please try again later.')
          .toJSON()],
      });
      return;
    }

    // ── Build contact options ────────────────────────────────
    const contactLines = [];
    if (process.env.REPORT_CONTACT_INVITE) {
      contactLines.push(`💬 **Support Server:** ${process.env.REPORT_CONTACT_INVITE}`);
    }
    if (process.env.REPORT_CONTACT_EMAIL) {
      contactLines.push(`📧 **Email:** \`${process.env.REPORT_CONTACT_EMAIL}\``);
    }
    contactLines.push(`🌐 **Dashboard:** ${siteUrl()}`);

    const contactSection = contactLines.length
      ? `\n\n**Need to follow up?**\n${contactLines.join('\n')}`
      : '';

    // ── Confirm in channel ───────────────────────────────────
    await message.reply({
      embeds: [new EmbedBuilder()
        .setTitle('✅ Report Submitted')
        .setDescription(
          `Your bug report has been received.\n` +
          `-# Report ID: \`${reportId}\`` +
          contactSection
        )
        .setColor(0x4ade80)
        .setTimestamp(new Date())
        .toJSON()],
    });

    // ── DM confirmation ──────────────────────────────────────
    try {
      const u  = await client.users.fetch(userId);
      const dm = await u.createDM();
      await dm.send({
        embeds: [{
          color:       0x4ade80,
          title:       '✅ Bug Report Received',
          description: `Thank you for your report! The Bloo team has been notified.\n\n` +
                       `**Report ID:** \`${reportId}\`\n` +
                       `**Summary:** ${description.slice(0, 200)}${description.length > 200 ? '…' : ''}\n\n` +
                       `Keep this ID. You may be asked for it if we follow up.` +
                       contactSection,
          footer:    { text: 'Bloo Bug Report System' },
          timestamp: new Date().toISOString(),
        }],
      });
    } catch { /* DMs closed, confirmation already sent in channel */ }
  },
};