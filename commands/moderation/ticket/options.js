// ─── !ticket option add/remove/list/message ────────────────────────────────────

import { Embed } from '../../../config/embeds.js';
import { resolveShortcode } from '../../../config/emojiMap.js';
import {
  getTicketOptions as getOptions,
  addTicketOption as addOption,
  removeTicketOption as removeOption,
  setOptionMessage,
  setOptionKeyword,
  setOptionRole,
  setOptionCategory,
  setOptionEnabled,
  setOptionDisabledMessage,
  setOptionNoPrefix,
  normalizeKeyword,
} from '../../../handlers/ticketSystem/index.js';

function parseRoleId(arg) {
  if (!arg) return null;
  return arg.match(/^<@&(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

// resolveShortcode only handles :shortcode: lookups and unicode, a pasted
// custom emoji like <:partner:123456789012345678> passed straight through
// unchanged, angle brackets and all. handleTicketReaction() (panels.js)
// keys custom emoji as bare "name:id", with NO animated distinction, its
// reactionKey is always `${emoji.name}:${emoji.id}` regardless of
// emoji.animated, unlike role_menus/reaction_roles which do prefix
// animated ones with "a_". A mapping stored with the brackets still on it,
// or with an incorrectly-added "a_" prefix, would never match an incoming
// reaction, silently making that option's panel entry non-functional (its
// own reaction PUT would even fail to attach at post time). Matches
// dashboard/routes/tickets.js's normaliseEmoji() exactly, that file is the
// one already used by handleTicketReaction's own subsystem.
function resolveEmojiInput(raw) {
  const custom = raw.match(/^<a?:(\w+):(\d+)>$/);
  if (custom) return `${custom[1]}:${custom[2]}`;
  return resolveShortcode(raw);
}

export async function handleOptions({ message, prefix, guildId, rest }) {
  const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';
  const [action, emoji, ...labelParts] = rest;

  if (action === 'add') {
    if (!emoji || !labelParts.length) {
      await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket option add <emoji> <label>\``).toJSON()] }).catch(() => {});
      return;
    }
    const label         = labelParts.join(' ');
    const resolvedEmoji = resolveEmojiInput(emoji);
    const existing      = getOptions(guildId);
    if (existing.length >= 5) {
      await message.reply({ embeds: [Embed.warning('Ticket panels support a maximum of 5 options. Remove one before adding another.', 'Option Limit Reached').toJSON()] }).catch(() => {});
      return;
    }
    if (existing.some(o => o.emoji === resolvedEmoji)) {
      await message.reply({ embeds: [Embed.warning(`${resolvedEmoji} is already used by an existing option.`, 'Duplicate Emoji').toJSON()] }).catch(() => {});
      return;
    }
    addOption(guildId, resolvedEmoji, label);
    const count   = existing.length + 1;
    const keyword = normalizeKeyword(null, label);
    await message.reply({ embeds: [Embed.success(
      `Tickets from this option will look like \`ticket-${keyword}-0001\`.\n-# Run \`${PREFIX}ticket option keyword ${resolvedEmoji} <word>\` to change it, or \`${PREFIX}ticket panel\` to repost the panel.`,
      `Option added: ${resolvedEmoji} ${label}`
    ).toJSON()] });
    return;
  }

  if (action === 'remove') {
    if (!emoji) {
      await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket option remove <emoji>\``).toJSON()] }).catch(() => {});
      return;
    }
    const resolvedEmoji = resolveEmojiInput(emoji);
    const result = removeOption(guildId, resolvedEmoji);
    if (result.error) {
      await message.reply({ embeds: [Embed.warning(result.error).toJSON()] }).catch(() => {});
      return;
    }
    await message.reply({ embeds: [Embed.success(`Option ${resolvedEmoji} removed.\n-# Run \`${PREFIX}ticket panel\` to repost.`).toJSON()] }).catch(() => {});
    return;
  }

  if (action === 'list') {
    const options = getOptions(guildId);
    if (!options.length) {
      await message.reply({ embeds: [Embed.info(`No options configured yet. Use \`${PREFIX}ticket option add <emoji> <label>\`.`).toJSON()] }).catch(() => {});
      return;
    }
    const lines = options.map((o, i) =>
      `${i + 1}. ${o.emoji} **${o.label}** \`${normalizeKeyword(o.keyword, o.label)}\`` +
      (o.enabled ? '' : ' 🔴 **disabled**') +
      (o.support_role_id ? ` → <@&${o.support_role_id}>` : '') +
      (o.category_id ? ` (category \`${o.category_id}\`)` : '') +
      (o.opening_message ? `\n   ↳ _${o.opening_message.slice(0, 80)}${o.opening_message.length > 80 ? '…' : ''}_` : '') +
      (!o.enabled && o.disabled_message ? `\n   ↳ 🔴 _${o.disabled_message.slice(0, 80)}${o.disabled_message.length > 80 ? '…' : ''}_` : '')
    );
    await message.reply({ embeds: [Embed.info(
      lines.join('\n') + `\n\n-# ${options.length}/5 options. The \`word\` next to each is what shows up in the channel name and case ID.`,
      'Ticket Options'
    ).setFooter({ text: `${PREFIX}ticket option keyword <emoji> <word> to change it, ${PREFIX}ticket option message <emoji> <text> for the opening message` })
      .toJSON()] });
    return;
  }

  if (action === 'keyword') {
    // !ticket option keyword <emoji> <word>
    // Sets the word used for this option's channel name and case ID
    // category (e.g. "bug" -> ticket-bug-0001, Ticket-Bug-0001).
    const word = labelParts.join(' ');
    if (!emoji || !word) {
      await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket option keyword <emoji> <word>\`\n-# e.g. \`${PREFIX}ticket option keyword 🐛 bug\``).toJSON()] });
      return;
    }
    const resolvedEmoji = resolveEmojiInput(emoji);
    const result = setOptionKeyword(guildId, resolvedEmoji, word);
    if (result.error) {
      await message.reply({ embeds: [Embed.warning(result.error).toJSON()] }).catch(() => {});
      return;
    }
    await message.reply({ embeds: [Embed.success(
      `New tickets from this option will look like \`ticket-${result.keyword}-0001\` and case ID \`Ticket-${result.keyword.charAt(0).toUpperCase() + result.keyword.slice(1)}-0001\`.`,
      `Keyword for ${resolvedEmoji} set to \`${result.keyword}\``
    ).toJSON()] });
    return;
  }

  if (action === 'role') {
    // !ticket option role <emoji> <@role|roleId|off>
    // Per-category staff routing: tickets from this option get this role
    // instead of the guild-wide support role (falls back to it when off).
    const roleArg = labelParts[0];
    if (!emoji || !roleArg) {
      await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket option role <emoji> <@role|off>\``).toJSON()] });
      return;
    }
    const resolvedEmoji = resolveEmojiInput(emoji);
    const roleId = roleArg.toLowerCase() === 'off' ? null : parseRoleId(roleArg);
    if (roleArg.toLowerCase() !== 'off' && !roleId) {
      await message.reply({ embeds: [Embed.warning('Provide a role mention, role ID, or `off` to clear it.').toJSON()] });
      return;
    }
    const result = setOptionRole(guildId, resolvedEmoji, roleId);
    if (result.error) {
      await message.reply({ embeds: [Embed.warning(result.error).toJSON()] }).catch(() => {});
      return;
    }
    await message.reply({ embeds: [Embed.success(
      roleId ? `Tickets from ${resolvedEmoji} will now ping <@&${roleId}> instead of the default support role.` : `${resolvedEmoji} now uses the default support role again.`,
      `Support role for ${resolvedEmoji} updated`
    ).toJSON()] });
    return;
  }

  if (action === 'category') {
    // !ticket option category <emoji> <categoryId|off>
    // Per-category channel destination: tickets from this option are
    // created under this Fluxer channel category instead of the
    // guild-wide default (falls back to it when off).
    const catArg = labelParts[0];
    if (!emoji || !catArg) {
      await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket option category <emoji> <categoryId|off>\``).toJSON()] });
      return;
    }
    const resolvedEmoji = resolveEmojiInput(emoji);
    const categoryId = catArg.toLowerCase() === 'off' ? null : catArg.replace(/\D/g, '');
    if (catArg.toLowerCase() !== 'off' && !categoryId) {
      await message.reply({ embeds: [Embed.warning('Provide a valid channel category ID, or `off` to clear it.').toJSON()] });
      return;
    }
    const result = setOptionCategory(guildId, resolvedEmoji, categoryId);
    if (result.error) {
      await message.reply({ embeds: [Embed.warning(result.error).toJSON()] }).catch(() => {});
      return;
    }
    await message.reply({ embeds: [Embed.success(
      categoryId ? `Tickets from ${resolvedEmoji} will now be created under category \`${categoryId}\`.` : `${resolvedEmoji} now uses the default channel category again.`,
      `Channel category for ${resolvedEmoji} updated`
    ).toJSON()] });
    return;
  }

  if (action === 'message') {
    // !ticket option message <emoji> <text>
    // Sets a custom opening message for this specific option.
    // Placeholders: {user} {role} {ticket} {label}
    const text = labelParts.join(' ');
    if (!emoji) {
      await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket option message <emoji> <text>\`\n-# Placeholders: \`{user}\` \`{role}\` \`{ticket}\` \`{label}\``).toJSON()] });
      return;
    }
    if (!text) {
      const resolvedEmoji = resolveEmojiInput(emoji);
      const result = setOptionMessage(guildId, resolvedEmoji, null);
      if (result.error) {
        await message.reply({ embeds: [Embed.warning(result.error).toJSON()] }).catch(() => {});
        return;
      }
      await message.reply({ embeds: [Embed.success(`Opening message for ${resolvedEmoji} reset to default.`).toJSON()] }).catch(() => {});
      return;
    }
    const resolvedEmoji = resolveEmojiInput(emoji);
    const result = setOptionMessage(guildId, resolvedEmoji, text);
    if (result.error) {
      await message.reply({ embeds: [Embed.warning(result.error).toJSON()] }).catch(() => {});
      return;
    }
    await message.reply({ embeds: [Embed.success(
      `\`\`\`${text.slice(0, 300)}\`\`\`\n-# Placeholders: \`{user}\` mention, \`{role}\` support role, \`{ticket}\` case ID, \`{label}\` option name`,
      `Opening message set for ${resolvedEmoji}`
    ).toJSON()] });
    return;
  }

  if (action === 'toggle' || action === 'enable' || action === 'disable') {
    // !ticket option toggle <emoji>   (or explicit enable/disable <emoji>)
    // Temporarily turns a category off without removing it or losing its
    // role/category routing, e.g. "not offering partnerships right now".
    // The option stays visible on the panel; reacting to it while disabled
    // DMs disabled_message (or a default) instead of opening a ticket.
    if (!emoji) {
      await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket option toggle <emoji>\``).toJSON()] });
      return;
    }
    const resolvedEmoji = resolveEmojiInput(emoji);
    const match = getOptions(guildId).find(o => o.emoji === resolvedEmoji);
    if (!match) {
      await message.reply({ embeds: [Embed.warning(`No ticket option found for emoji ${resolvedEmoji}.`).toJSON()] }).catch(() => {});
      return;
    }
    const nextEnabled = action === 'enable' ? true : action === 'disable' ? false : !match.enabled;
    setOptionEnabled(guildId, resolvedEmoji, nextEnabled);
    await message.reply({ embeds: [Embed.success(
      nextEnabled
        ? `${resolvedEmoji} **${match.label}** is now accepting new tickets again.`
        : `${resolvedEmoji} **${match.label}** will no longer open new tickets. Users who react get ${match.disabled_message ? 'your custom message' : 'a default "not accepting tickets" message'} instead.\n-# Set one with \`${PREFIX}ticket option disabledmessage ${resolvedEmoji} <text>\``,
      `${match.label} ${nextEnabled ? 'enabled' : 'disabled'}`
    ).toJSON()] });
    return;
  }

  if (action === 'prefix') {
    // !ticket option prefix <emoji> <on|off>
    // "on" (default) keeps the generic ticket-{word}-0001 channel name.
    // "off" drops the "ticket-" label for categories that don't read like a
    // support request, e.g. a Partner category channel becomes partner-0001.
    // Only affects the channel name, not the internal case ID.
    const arg = labelParts[0]?.toLowerCase();
    if (!emoji || !['on', 'off'].includes(arg)) {
      await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket option prefix <emoji> <on|off>\``).toJSON()] });
      return;
    }
    const resolvedEmoji = resolveEmojiInput(emoji);
    const match = getOptions(guildId).find(o => o.emoji === resolvedEmoji);
    if (!match) {
      await message.reply({ embeds: [Embed.warning(`No ticket option found for emoji ${resolvedEmoji}.`).toJSON()] }).catch(() => {});
      return;
    }
    setOptionNoPrefix(guildId, resolvedEmoji, arg === 'off');
    const word = normalizeKeyword(match.keyword, match.label);
    await message.reply({ embeds: [Embed.success(
      arg === 'off'
        ? `New ${resolvedEmoji} channels will look like \`${word}-0001\` (no "ticket-" label).`
        : `New ${resolvedEmoji} channels will look like \`ticket-${word}-0001\` again.`,
      `"ticket-" label for ${resolvedEmoji} turned ${arg}`
    ).toJSON()] });
    return;
  }

  if (action === 'disabledmessage') {
    // !ticket option disabledmessage <emoji> <text>
    // Custom message DM'd to whoever reacts while this option is disabled.
    // Placeholder: {label}. Empty text resets to the built-in default.
    const text = labelParts.join(' ');
    if (!emoji) {
      await message.reply({ embeds: [Embed.warning(`Usage: \`${PREFIX}ticket option disabledmessage <emoji> <text>\`\n-# Placeholder: \`{label}\``).toJSON()] });
      return;
    }
    const resolvedEmoji = resolveEmojiInput(emoji);
    const result = setOptionDisabledMessage(guildId, resolvedEmoji, text || null);
    if (result.error) {
      await message.reply({ embeds: [Embed.warning(result.error).toJSON()] }).catch(() => {});
      return;
    }
    await message.reply({ embeds: [Embed.success(
      text ? `\`\`\`${text.slice(0, 300)}\`\`\`` : 'Reset to the default "not accepting tickets" message.',
      `Disabled-message for ${resolvedEmoji} updated`
    ).toJSON()] });
    return;
  }

  await message.reply({ embeds: [Embed.info(
    `\`${PREFIX}ticket option add <emoji> <label>\`: add option (max 5)\n` +
    `\`${PREFIX}ticket option keyword <emoji> <word>\`: set the channel-name/case-ID word\n` +
    `\`${PREFIX}ticket option message <emoji> <text>\`: set custom opening message\n` +
    `\`${PREFIX}ticket option role <emoji> <@role|off>\`: route this category to its own support role\n` +
    `\`${PREFIX}ticket option category <emoji> <categoryId|off>\`: route this category to its own channel category\n` +
    `\`${PREFIX}ticket option toggle <emoji>\`: turn this category on/off without removing it\n` +
    `\`${PREFIX}ticket option disabledmessage <emoji> <text>\`: message DM'd when someone reacts while it's off\n` +
    `\`${PREFIX}ticket option prefix <emoji> <on|off>\`: drop the "ticket-" label from this category's channel name\n` +
    `\`${PREFIX}ticket option remove <emoji>\`: remove option\n` +
    `\`${PREFIX}ticket option list\`: list options`,
    'Ticket Options'
  ).toJSON()] });
}
