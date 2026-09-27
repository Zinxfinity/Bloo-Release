// ─── !ticket case [setperm <permission> | <id>] ────────────────────────────────
// BAN_MEMBERS+ by default; configurable per guild (Server Owner/Bot Owner only).

import { EmbedBuilder } from '@fluxerjs/core';
import { Embed, COLORS } from '../../../config/embeds.js';
import { isRealOwner, isBotOwner, getMemberPermissionBitsLive } from '../../../handlers/staffSystem.js';
import { Permissions } from '../../../config/guildPermissions.js';
import { getTicketByCase } from '../../../handlers/ticketSystem/index.js';
import { getCommandConfig, setCommandPermission } from '../../../handlers/commandPermissions.js';

// Per-guild minimum permission for case lookup, stored as a command_permissions
// row under 'ticket.case' (it used to be an in-memory Map, reset on restart).
const DEFAULT_CASE_PERMISSION = Permissions.BAN_MEMBERS;
function getCasePermission(guildId) {
  const cfg = getCommandConfig(guildId, 'ticket.case');
  return cfg?.required_type === 'permission' && cfg.required_value ? BigInt(cfg.required_value) : DEFAULT_CASE_PERMISSION;
}

const PERM_NAMES = new Map([
  ['kick',   Permissions.KICK_MEMBERS],
  ['ban',    Permissions.BAN_MEMBERS],
  ['manage', Permissions.MANAGE_GUILD],
  ['admin',  Permissions.ADMINISTRATOR],
]);
function permLabel(flag) {
  for (const [name, bit] of PERM_NAMES) if (bit === flag) return name;
  return `permission ${flag}`;
}

export async function handleCase({ message, client, prefix, guildId, rest }) {
  const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';
  const [caseArg, ...caseRest] = rest;
  const userId = message.author.id;

  // !ticket case setperm <permission>
  if (caseArg?.toLowerCase() === 'setperm') {
    // Hard lock: only Server Owner/Bot Owner can control who can look up cases
    if (!isBotOwner(userId) && !(await isRealOwner(guildId, userId))) {
      await message.reply({ embeds: [Embed.denied('Server Owner (this cannot be configured via !permissions)')
        .setDescription('Only the **Server Owner** can set the minimum permission for ticket case lookups.').toJSON()] });
      return;
    }
    const flag = PERM_NAMES.get(caseRest[0]?.toLowerCase());
    if (!flag) {
      await message.reply({ embeds: [new EmbedBuilder().setColor(COLORS.DANGER).setTitle('❌  Unknown Permission')
        .setDescription('Valid: `kick` `ban` `manage` `admin`').toJSON()] });
      return;
    }
    setCommandPermission(guildId, 'ticket.case', flag, userId);
    await message.reply({ embeds: [new EmbedBuilder().setColor(COLORS.SUCCESS).setTitle('✅  Minimum Permission Updated')
      .setDescription(`\`${PREFIX}ticket case\` now requires **${permLabel(flag)}** or above.`).setTimestamp().toJSON()] });
    return;
  }

  // Permission gate for lookup
  const requiredFlag = getCasePermission(guildId);
  const isOwner      = isBotOwner(userId) || await isRealOwner(guildId, userId);
  const bits         = isOwner ? 0n : await getMemberPermissionBitsLive(client, guildId, userId);
  const hasPerm      = isOwner || (bits & Permissions.ADMINISTRATOR) !== 0n || (bits & requiredFlag) !== 0n;
  if (!hasPerm) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(COLORS.DANGER).setTitle('🚫  Access Denied')
      .setDescription(`You need at least **${permLabel(requiredFlag)}** to look up ticket cases.`).toJSON()] });
    return;
  }

  const caseId = caseArg?.trim();
  if (!caseId) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(COLORS.DANGER).setTitle('❌  Missing Case ID')
      .setDescription(`Usage: \`${PREFIX}ticket case <id>\`, e.g. \`${PREFIX}ticket case support-0001\``).toJSON()] });
    return;
  }

  const ticket = getTicketByCase(guildId, caseId);
  if (!ticket || ticket.guild_id !== guildId) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(COLORS.DANGER).setTitle('❌  Ticket Not Found')
      .setDescription(`No ticket found with case ID \`${caseId}\` in this server.`).toJSON()] });
    return;
  }

  // 'creating'/'failed' are real statuses (see handlers/ticketSystem/schema.js's
  // claimCase/failCase), previously both fell through to the same "closed"
  // display as a fully-closed ticket, and failCase never sets closed_by, so
  // a failed ticket rendered a literal <@null> for "Closed By".
  const STATUS_META = {
    open:     { emoji: '🟢', label: '🟢 Open',     color: COLORS.SUCCESS },
    creating: { emoji: '🟡', label: '🟡 Creating', color: COLORS.WARNING },
    failed:   { emoji: '⚠️', label: '⚠️ Failed',   color: COLORS.DANGER },
  };
  const meta     = STATUS_META[ticket.status] ?? { emoji: '🔒', label: '🔴 Closed', color: COLORS.DANGER };
  const isOpen   = ticket.status === 'open';
  // ticket_cases timestamps are unix seconds already.
  const openedAt = ticket.opened_at;
  const closedAt = ticket.closed_at ?? null;

  const caseEmbed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji}  Ticket Case \`${ticket.case_id}\``)
    .addFields(
      { name: '📊 Status',    value: meta.label,                                     inline: true },
      { name: '👤 Opened By', value: `<@${ticket.user_id}> (${ticket.username})`,     inline: true },
      { name: '🕐 Opened',    value: `<t:${openedAt}:F>`,                             inline: true },
    );

  if (ticket.option_label) {
    caseEmbed.addFields({ name: '🏷️ Category', value: `${ticket.option_emoji ?? ''} ${ticket.option_label}`.trim(), inline: true });
  }
  if (ticket.channel_id) {
    caseEmbed.addFields({ name: '💬 Channel', value: isOpen ? `<#${ticket.channel_id}>` : `\`${ticket.channel_id}\` *(deleted)*`, inline: true });
  }
  if (closedAt) {
    const closedFields = [{ name: '🕐 Closed', value: `<t:${closedAt}:F>`, inline: true }];
    if (ticket.closed_by) closedFields.push({ name: '🔒 Closed By', value: `<@${ticket.closed_by}>`, inline: true });
    closedFields.push({ name: '📋 Reason', value: ticket.close_reason ?? 'No reason provided', inline: false });
    caseEmbed.addFields(...closedFields);
  }

  caseEmbed.setFooter({ text: `Server: ${guildId}` }).setTimestamp();
  await message.reply({ embeds: [caseEmbed.toJSON()] }).catch(() => {});
}
