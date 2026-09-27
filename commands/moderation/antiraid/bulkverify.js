// ─── !antiraid bulkverify [all | role @Role1 @Role2 ...] ───────────────────────

import { Embed } from '../../../config/embeds.js';
import { getConfig } from './helpers.js';
import db from '../../../db.js';
import { giveHeldAutorole } from '../../../handlers/autoroleGate.js';

export async function handleBulkVerify({ message, args, client, prefix, guildId }) {
  const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';
  const value  = args[1];
  const cfg    = getConfig(guildId);

  if (!cfg.verified_role_id) {
    await message.reply({
      embeds: [Embed.warning('No Verified Role').setDescription(
        `Set a verified role first with \`${PREFIX}antiraid role @Role\` before running a bulk verify.`
      ).toJSON()],
    });
    return;
  }

  // Parse mode, "all" or "role @Role1 @Role2 ..."
  const mode = value?.toLowerCase();
  if (mode !== 'all' && mode !== 'role') {
    await message.reply({
      embeds: [
        Embed.info('🛡️  Bulk Verify: Usage')
          .addFields(
            { name: `\`${PREFIX}antiraid bulkverify all\``,            value: "Grant the verified role to every current member who doesn't have it", inline: false },
            { name: `\`${PREFIX}antiraid bulkverify role @R1 @R2 ...\``, value: 'Grant the verified role to members who hold any of the specified roles', inline: false },
          )
          .setFooter({ text: 'Large servers: the bot will process in batches and report progress.' })
          .toJSON(),
      ],
    });
    return;
  }

  // Collect target role IDs for "role" mode
  let filterRoleIds = [];
  if (mode === 'role') {
    filterRoleIds = args.slice(2).map(a => a.match(/^<@&(\d+)>$/)?.[1] ?? (a.match(/^\d{17,20}$/) ? a : null)).filter(Boolean);
    if (!filterRoleIds.length) {
      await message.reply({
        embeds: [Embed.warning('No Roles Specified').setDescription(
          `Mention at least one role.\n\nExample: \`${PREFIX}antiraid bulkverify role @Members @Regulars\``
        ).toJSON()],
      });
      return;
    }
  }

  // Post a live status message
  const status = await message.reply({
    embeds: [
      Embed.info('⏳  Bulk Verify Starting…')
        .setDescription(
          mode === 'all'
            ? 'Fetching all members. This may take a moment for large servers.'
            : 'Fetching members with roles: ' + filterRoleIds.map(id => `<@&${id}>`).join(', ')
        )
        .setFooter({ text: 'Progress will update every 25 members.' })
        .toJSON(),
    ],
  });

  // Fetch member list
  const guild = message.guild ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    await status.edit({ embeds: [Embed.danger('Error').setDescription('Could not fetch guild.').toJSON()] });
    return;
  }

  // Paginated REST fetch, works without Server Members Intent
  const candidates = [];
  try {
    let after = '0';
    while (true) {
      const r = await fetch(
        `https://api.fluxer.app/guilds/${guildId}/members?limit=1000&after=${after}`,
        { headers: { Authorization: `Bot ${process.env.FLUXER_BOT_TOKEN}` } }
      );
      if (!r.ok) break;
      const batch = await r.json();
      if (!Array.isArray(batch) || !batch.length) break;

      for (const m of batch) {
        const userId = m.user?.id ?? m.id;
        if (!userId || m.user?.bot) continue;

        // Skip if they already have the verified role
        const memberRoles = m.roles ?? [];
        if (memberRoles.includes(cfg.verified_role_id)) continue;

        // Role filter for 'role' mode
        if (mode === 'role') {
          const hasAny = filterRoleIds.some(rid => memberRoles.includes(rid));
          if (!hasAny) continue;
        }

        candidates.push(userId);
      }

      if (batch.length < 1000) break;
      after = batch[batch.length - 1].user?.id ?? batch[batch.length - 1].id;
    }
  } catch (err) {
    await status.edit({ embeds: [Embed.danger('Error').setDescription(`Could not fetch member list: ${err.message}`).toJSON()] });
    return;
  }

  if (!candidates.length) {
    await status.edit({
      embeds: [Embed.success('✅  Nothing to Do').setDescription('All eligible members already have the verified role.').toJSON()],
    });
    return;
  }

  // Process in batches, update progress embed every 25 grants
  const UPDATE_EVERY = 25;
  let granted = 0, failed = 0;

  const progressEmbed = () => {
    const desc = 'Processing **' + candidates.length + '** member(s)…\n\n' +
      '✅  Granted: **' + granted + '**\n' +
      '❌  Failed:  **' + failed + '**\n' +
      '⏳  Remaining: **' + (candidates.length - granted - failed) + '**';
    return Embed.info('⏳  Bulk Verify In Progress')
      .setDescription(desc)
      .setFooter({ text: 'Do not run other bulk operations until this completes.' })
      .toJSON();
  };

  await status.edit({ embeds: [progressEmbed()] });

  for (let i = 0; i < candidates.length; i++) {
    const userId = candidates[i];
    try {
      await client.rest.put(`/guilds/${guildId}/members/${userId}/roles/${cfg.verified_role_id}`);
      await giveHeldAutorole(client, db, guildId, userId);
      granted++;
    } catch (err) {
      failed++;
      console.warn('[BULKVERIFY] Failed to grant role to ' + userId + ': ' + err.message);
    }

    // Throttle, 1 request per 100ms to avoid hitting rate limits hard
    await new Promise(r => setTimeout(r, 100));

    // Progress update every UPDATE_EVERY members
    if ((i + 1) % UPDATE_EVERY === 0 || i === candidates.length - 1) {
      await status.edit({ embeds: [progressEmbed()] }).catch(() => {});
    }
  }

  // Final result
  const modeLabel = mode === 'all'
    ? 'all members'
    : 'members with ' + filterRoleIds.map(id => '<@&' + id + '>').join(', ');

  const finalDesc = 'Processed **' + candidates.length + '** candidate(s) (' + modeLabel + ').\n\n' +
    '✅  Granted: **' + granted + '**\n' +
    '❌  Failed:  **' + failed + '**' +
    (failed > 0 ? '\n\n-# Failures are usually members who left mid-process or role permission issues.' : '');

  await status.edit({
    embeds: [
      (failed === 0 ? Embed.success : Embed.warning)('✅  Bulk Verify Complete')
        .setDescription(finalDesc)
        .addFields({ name: '🎭  Role Granted', value: '<@&' + cfg.verified_role_id + '>', inline: true })
        .toJSON(),
    ],
  });
}
