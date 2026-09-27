// ─── !antiraid on/off/role/channel/mode/status ─────────────────────────────────

import { Embed } from '../../../config/embeds.js';
import { siteHost } from '../../../config/site.js';
import { postVerifyPanel } from '../../../handlers/antiRaid/index.js';
import { upsert, parseRoleId, parseChannelId, getConfig } from './helpers.js';
import { isChannelInGuild } from '../../../utils/channelGuard.js';

export async function handleConfig({ message, client, prefix, guildId, subLower, value, args: ctxArgs = [] }) {
  const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';

  // ── !antiraid on ──────────────────────────────────────
  if (subLower === 'on') {
    // Captcha only. Raid Mode (account-age kick/ban) is opted into
    // separately with `!antiraid raid on`, so turning verification on never
    // starts removing new accounts as a side effect.
    upsert(guildId, { captcha_enabled: 1 });
    const cfg = getConfig(guildId);

    const missing = [];
    if (!cfg.verified_role_id)  missing.push(`• No verified role set. Use \`${PREFIX}antiraid role @Role\``);
    if (!cfg.verify_channel_id) missing.push(`• No verify channel set. Use \`${PREFIX}antiraid channel #channel\``);

    const embed = Embed.success('🛡️  Anti-Raid Enabled')
      .setDescription('New members must pass captcha to access the server.');

    if (missing.length) {
      embed.addFields({ name: '⚠️  Setup Incomplete', value: missing.join('\n'), inline: false });
    } else {
      embed.addFields({
        name:  '✅  Fully Configured',
        value: `Verified role: <@&${cfg.verified_role_id}>\nVerify channel: <#${cfg.verify_channel_id}>`,
        inline: false,
      });
    }

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
    return;
  }

  // ── !antiraid off ─────────────────────────────────────
  if (subLower === 'off') {
    upsert(guildId, { enabled: 0, captcha_enabled: 0 });
    await message.reply({
      embeds: [
        Embed.warning('🛡️  Anti-Raid Disabled')
          .setDescription('Captcha verification is now **off**. New members can join without completing a challenge.\n\n-# Your configuration is saved. Re-enable with `antiraid on`.').toJSON(),
      ],
    });
    return;
  }

  // ── !antiraid role @Role ──────────────────────────────
  if (subLower === 'role') {
    const roleId = parseRoleId(value);
    if (!roleId) {
      await message.reply({ embeds: [Embed.warning('Missing Role').setDescription(`Mention the role to assign after verification.\n\nUsage: \`${PREFIX}antiraid role @Verified\``).toJSON()] }).catch(() => {});
      return;
    }
    upsert(guildId, { verified_role_id: roleId });
    await message.reply({
      embeds: [
        Embed.success('Verified Role Set')
          .setDescription(`<@&${roleId}> will be granted to members after they pass captcha.`)
          .toJSON(),
      ],
    });
    return;
  }

  // ── !antiraid channel #channel ────────────────────────
  if (subLower === 'channel') {
    const channelId = parseChannelId(value);
    if (!channelId) {
      await message.reply({ embeds: [Embed.warning('Missing Channel').setDescription(`Mention the channel to post the verify panel in.\n\nUsage: \`${PREFIX}antiraid channel #verify-here\``).toJSON()] }).catch(() => {});
      return;
    }

    upsert(guildId, { verify_channel_id: channelId });

    // Post the proper react-to-verify panel (registers with reactionAdd.js)
    const msgId = await postVerifyPanel(client, guildId);

    if (!msgId) {
      await message.reply({ embeds: [Embed.warning('Panel Failed').setDescription(`Could not post the verify panel in <#${channelId}>. Check that Bloo has Send Messages and Add Reactions permissions there.`).toJSON()] }).catch(() => {});
      return;
    }

    await message.reply({
      embeds: [
        Embed.success('✅  Verify Channel Set')
          .setDescription(
            `Panel posted in <#${channelId}>.\n\n` +
            `Members whose DMs are closed will see their link there when they react ✅.\n\n` +
            `-# The panel is registered and active. Run this command again if you need to re-post it.`
          )
          .toJSON(),
      ],
    });
    return;
  }

  // ── !antiraid mode web|dm ────────────────────────────────
  if (subLower === 'mode') {
    const modeArg = value?.toLowerCase();
    if (modeArg !== 'web' && modeArg !== 'dm') {
      const cfg = getConfig(guildId);
      const current = cfg.verify_mode ?? 'web';
      await message.reply({
        embeds: [
          Embed.info('🔀  Verification Mode')
            .setDescription(
              `Current mode: **${current === 'dm' ? 'In-DM image captcha' : 'Web captcha (hCaptcha)'}**\n\n` +
              `\`${PREFIX}antiraid mode web\`: sends a link to an external captcha page. Stronger bot protection but requires leaving Fluxer.\n\n` +
              `\`${PREFIX}antiraid mode dm\`: sends an image with a code to type, entirely inside Fluxer. Members stay on-platform the whole time.`
            )
            .toJSON(),
        ],
      }).catch(() => {});
      return;
    }

    upsert(guildId, { verify_mode: modeArg });

    const label = modeArg === 'dm' ? 'In-DM image captcha' : 'Web captcha (hCaptcha)';
    const desc  = modeArg === 'dm'
      ? `Members will receive a Fluxer DM containing an image with a 6-character code to type back. **They never leave the platform.**\n\n-# If a member has DMs closed, Bloo will post a nudge in the verify channel.`
      : `Members will receive a DM with a link to \`${siteHost()}/verify\` where they complete an hCaptcha challenge.\n\n-# Stronger bot protection but requires members to visit an external site.`;

    await message.reply({
      embeds: [Embed.success(`🔀  Mode Set: ${label}`).setDescription(desc).toJSON()],
    }).catch(() => {});
    return;
  }

  // ── !antiraid raid on|off|age <days>|action kick|ban|log #channel ──
  if (subLower === 'raid') {
    const [, opt, arg] = ctxArgs;
    const o = opt?.toLowerCase();
    if (o === 'on' || o === 'off') {
      upsert(guildId, { enabled: o === 'on' ? 1 : 0 });
      const cfg = getConfig(guildId);
      await message.reply({ embeds: [(o === 'on'
        ? Embed.warning('🛡️  Raid Mode On').setDescription(`Accounts younger than **${cfg.min_account_age ?? 7} day(s)** will be **${cfg.action === 'ban' ? 'banned' : 'kicked'}** automatically when they join.`)
        : Embed.success('🛡️  Raid Mode Off').setDescription('New accounts are no longer removed automatically.')).toJSON()] }).catch(() => {});
      return;
    }
    if (o === 'age') {
      const days = parseInt(arg, 10);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}antiraid raid age <1-365>\``).toJSON()] }).catch(() => {});
        return;
      }
      upsert(guildId, { min_account_age: days });
      await message.reply({ embeds: [Embed.success(`Raid Mode minimum account age set to **${days} day(s)**.`).toJSON()] }).catch(() => {});
      return;
    }
    if (o === 'action') {
      const a = arg?.toLowerCase();
      if (a !== 'kick' && a !== 'ban') {
        await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}antiraid raid action <kick|ban>\``).toJSON()] }).catch(() => {});
        return;
      }
      upsert(guildId, { action: a });
      await message.reply({ embeds: [Embed.success(`Raid Mode action set to **${a}**.`).toJSON()] }).catch(() => {});
      return;
    }
    if (o === 'log') {
      const channelId = parseChannelId(arg);
      if (!channelId || !await isChannelInGuild(client, guildId, channelId)) {
        await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}antiraid raid log #channel\` (a channel in this server)`).toJSON()] }).catch(() => {});
        return;
      }
      upsert(guildId, { log_channel_id: channelId });
      await message.reply({ embeds: [Embed.success(`Raid Mode alerts will be posted in <#${channelId}>.`).toJSON()] }).catch(() => {});
      return;
    }
    await message.reply({ embeds: [Embed.info('🛡️  Raid Mode')
      .setDescription('Automatically kick or ban accounts younger than a minimum age when they join. Off by default, separate from captcha.')
      .addFields(
        { name: `\`${PREFIX}antiraid raid on|off\``,          value: 'Turn Raid Mode on or off', inline: false },
        { name: `\`${PREFIX}antiraid raid age <days>\``,      value: 'Minimum account age (default 7)', inline: false },
        { name: `\`${PREFIX}antiraid raid action kick|ban\``, value: 'What happens to younger accounts (default kick)', inline: false },
        { name: `\`${PREFIX}antiraid raid log #channel\``,    value: 'Where to post an alert for each removal', inline: false },
      ).toJSON()] }).catch(() => {});
    return;
  }

  // ── !antiraid status ──────────────────────────────────
  if (subLower === 'status') {
    const cfg = getConfig(guildId);
    await message.reply({
      embeds: [
        Embed.info('🛡️  Anti-Raid: Current Config')
          .addFields(
            { name: '🔒  Raid Mode',      value: cfg.enabled ? '✅ On' : '❌ Off',                                    inline: true  },
            { name: '🧩  Captcha',         value: cfg.captcha_enabled ? '✅ On' : '❌ Off',                           inline: true  },
            { name: '🔀  Verify Mode',     value: (cfg.verify_mode ?? 'web') === 'dm' ? '📱 In-DM image' : '🌐 Web captcha', inline: true },
            { name: '🎭  Verified Role',   value: cfg.verified_role_id ? `<@&${cfg.verified_role_id}>` : '❌ Not set', inline: true  },
            { name: '📋  Verify Channel',  value: cfg.verify_channel_id ? `<#${cfg.verify_channel_id}>` : '❌ Not set', inline: true  },
            { name: '🕐  Min Account Age', value: `${cfg.min_account_age ?? 7} day(s)`,                               inline: true  },
            { name: '⚡  Action',          value: cfg.action ?? 'kick',                                               inline: true  },
          )
          .toJSON(),
      ],
    });
    return;
  }
}

export const CONFIG_SUBCOMMANDS = new Set(['on', 'off', 'role', 'channel', 'mode', 'status', 'raid']);
