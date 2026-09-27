import { EmbedBuilder } from '@fluxerjs/core';
import { COLORS } from '../../config/embeds.js';
import { registerPagination } from '../../handlers/paginationManager.js';
import { isBotOwner, isRealOwner, getMemberPermissionBitsLive } from '../../handlers/staffSystem.js';
import { Permissions } from '../../config/guildPermissions.js';
import { isEconomyAdmin, isEconomyReleased, economyEnabled } from '../../config/features.js';

const PERM_NAMES = new Map([
  [Permissions.KICK_MEMBERS,     'Kick Members'],
  [Permissions.BAN_MEMBERS,      'Ban Members'],
  [Permissions.MANAGE_GUILD,     'Manage Server'],
  [Permissions.MANAGE_MESSAGES,  'Manage Messages'],
  [Permissions.MANAGE_CHANNELS,  'Manage Channels'],
  [Permissions.MANAGE_ROLES,     'Manage Roles'],
  [Permissions.MANAGE_WEBHOOKS,  'Manage Webhooks'],
  [Permissions.MODERATE_MEMBERS, 'Timeout Members'],
  [Permissions.ADMINISTRATOR,    'Administrator'],
]);

const CATEGORIES = [
  { key: 'moderation', label: '🛡️  Moderation' },
  { key: 'utility',    label: '🔧  Utility'    },
  { key: 'general',    label: '📋  General'    },
  { key: 'fun',        label: '🎉  Fun'         },
  { key: 'economy',    label: '💰  Economy'    },
  { key: 'debug',      label: '🔩  Debug'      },
];

const PAGE_SIZE = 8;

function getRequiresLabel(cmd) {
  const req = cmd.requiredPermission;
  if (req == null) return 'Everyone';
  if (req === 'BOT_OWNER') return 'Bot Owner';
  if (req === 'SERVER_OWNER') return 'Server Owner';
  return PERM_NAMES.get(req) ?? 'Unknown Permission';
}

// Whether the caller can see a command in the help overview, not part of
// access control itself (commandHandler.js's Gate 3 is the real gate).
function canSeeCommand(cmd, { isBotOwnerUser, isOwnerUser, bits, economyVisible }) {
  if (isBotOwnerUser) return true;
  if (cmd.category === 'debug') return false;
  if (cmd.hidden) return false;
  // Economy is gated behind the same release toggle commandHandler.js's
  // Gate 4 already enforces at execution time. Previously this listed every
  // economy command for everyone regardless of release state, so a regular
  // user would see !ecobalance etc. in !help and only discover it's
  // unreleased after trying to run one and getting a "Coming Soon" reply.
  if (cmd.category === 'economy' && !economyVisible) return false;
  const req = cmd.requiredPermission;
  if (req == null) return true;
  if (req === 'BOT_OWNER') return false;
  if (req === 'SERVER_OWNER') return isOwnerUser;
  return (bits & req) !== 0n;
}

// message.reply() fails with FluxerAPIError "Message wasn't found" when the
// message being replied to (the user's own !help invocation) is gone by the
// time the reply actually sends, most commonly because it got purged
// moments after being typed. Confirmed identical on both @fluxerjs/core
// v2.0.1 (production) and v3.0.0 (dev branch), not a version-specific
// regression, so the fix doesn't need to be either: fall back to a plain
// send in the same channel, using only APIs unchanged across both versions.
async function safeReply(client, message, payload) {
  try {
    return await message.reply(payload);
  } catch {
    // Confirmed in production: client.channels.fetch() + .send() isn't
    // reliable here either, some channel types don't come back as a
    // proper text-based object with a working .send() on v2.0.1's SDK.
    // Post via raw REST instead, keyed only by the channel ID string, no
    // channel-type or SDK-object dependency at all, matching how every
    // other message-sending call site in this codebase already works.
    return client.rest.post(`/channels/${message.channelId}/messages`, { body: payload }).catch(() => null);
  }
}

function getCanonicalCommands(client, access) {
  const seen = new Set();
  const out  = [];
  for (const [key, cmd] of client.commands) {
    if (key !== cmd.name) continue;
    if (seen.has(cmd.name)) continue;
    seen.add(cmd.name);
    if (!canSeeCommand(cmd, access)) continue;
    out.push(cmd);
  }
  return out;
}

export default {
  name: 'help',
  aliases: ['h', 'commands'],
  description: 'Show all commands, a specific category, or details on one command.',
  usage: '{prefix}help [command|category] [page]',
  requiredPermission: null,

  cooldown: 5,

  async execute({ message, args, prefix, client }) {
    const guildId = message.guildId;
    const userId  = message.author.id;
    const isBotOwnerUser = isBotOwner(userId);
    const isOwnerUser    = isBotOwnerUser || await isRealOwner(guildId, userId);
    const bits           = await getMemberPermissionBitsLive(client, guildId, userId);
    const economyVisible = economyEnabled() && (isBotOwnerUser || await isEconomyReleased() || await isEconomyAdmin(userId));
    const access         = { isBotOwnerUser, isOwnerUser, bits, economyVisible };

    // Separate query from optional page number
    // Supports: b!help moderation, b!help moderation 2, b!help ban
    let query    = args[0]?.toLowerCase();
    let pageArg  = parseInt(args[1], 10);
    if (!query) pageArg = 1;

    // ── Specific command lookup ───────────────────────────────────────────
    if (query) {
      const command = client.commands.get(query);
      // canSeeCommand check added here too: this direct-lookup branch
      // previously ignored it entirely, so `!help ecobalance` (or any
      // debug/BOT_OWNER-only command) showed full usage details to anyone
      // regardless of category visibility, bypassing the same hide the
      // category-listing view already enforced below.
      if (command && canSeeCommand(command, access) && !CATEGORIES.find(c => c.key === query)) {
        const rankLabel = getRequiresLabel(command);
        const pfx = (s) => (s ?? '').replace(/\{prefix\}/g, prefix);

        const embed = new EmbedBuilder()
          .setColor(COLORS.INFO)
          .setTitle(`${prefix}${command.name}`)
          .addFields(
            { name: 'Description', value: command.description ?? 'No description.', inline: false },
            { name: 'Usage',       value: pfx(command.usage ?? `{prefix}${command.name}`), inline: false },
            { name: 'Category',    value: command.category?.charAt(0).toUpperCase() + command.category?.slice(1) ?? 'Unknown', inline: true },
            { name: 'Requires',    value: rankLabel, inline: true },
            { name: 'Cooldown',    value: `${command.cooldown ?? 3}s`, inline: true },
          );

        if (command.example) {
          embed.addFields({ name: 'Example', value: pfx(command.example).slice(0, 1024), inline: false });
        }
        if (command.aliases?.length) {
          embed.addFields({
            name:  'Aliases',
            value: command.aliases.map(a => `\`${prefix}${a}\``).join(', '),
            inline: false,
          });
        }

        return safeReply(client, message, { embeds: [embed.toJSON()] });
      }

      // ── Category view with pagination ─────────────────────────────────
      const catMatch = CATEGORIES.find(c =>
        c.key === query || c.label.toLowerCase().includes(query)
      );

      if (catMatch) {
        const cmds = getCanonicalCommands(client, access)
          .filter(c => c.category === catMatch.key)
          .sort((a, b) => a.name.localeCompare(b.name));

        if (!cmds.length) {
          return safeReply(client, message, { content: `No accessible commands in **${catMatch.label}**.` });
        }

        const totalPages = Math.ceil(cmds.length / PAGE_SIZE);

        // Build every page embed upfront for the pagination manager
        const pageEmbeds = Array.from({ length: totalPages }, (_, i) => {
          const slice = cmds.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
          const rows  = slice.map(c => {
            const req = c.requiredPermission != null ? getRequiresLabel(c) : null;
            const tag = req ? ` *(${req})*` : '';
            return `\`${prefix}${c.name}\`${tag}: ${c.description ?? ''}`;
          });

          const title = totalPages > 1
            ? `${catMatch.label} (Page ${i + 1}/${totalPages})`
            : catMatch.label;

          const footer = totalPages > 1
            ? `◀ ▶ to navigate  ·  ${prefix}help <command> for usage details`
            : `${prefix}help <command> for usage details`;

          return new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle(title)
            .setDescription(rows.join('\n'))
            .setFooter({ text: footer })
            .setTimestamp()
            .toJSON();
        });

        const sent = await safeReply(client, message, { embeds: [pageEmbeds[0]] });

        if (totalPages > 1 && sent?.id) {
          await registerPagination(
            client,
            sent.channelId ?? message.channelId,
            sent.id,
            userId,
            pageEmbeds,
          );
        }

        return;
      }

      // Nothing matched, check if it's a number (user did b!help 2 by mistake)
      return safeReply(client, message, {
        content: `No command or category called \`${query}\`. Use \`${prefix}help\` to see all categories.`,
      });
    }

    // ── Top-level overview ────────────────────────────────────────────────
    const allCmds = getCanonicalCommands(client, access);
    const grouped = new Map();
    for (const cmd of allCmds) {
      const cat = cmd.category ?? 'other';
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat).push(cmd.name);
    }

    const embed = new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle('Bloo: Commands')
      .setDescription(
        `\`${prefix}help <category>\` to browse a category.\n` +
        `\`${prefix}help <command>\` for usage details on a specific command.`
      )
      .setTimestamp();

    const rendered = new Set();

    for (const { key, label } of CATEGORIES) {
      const cmds = grouped.get(key);
      if (!cmds?.length) continue;
      const sorted = cmds.sort();
      const preview = sorted.slice(0, 6).map(c => `\`${c}\``).join('  ');
      const overflow = sorted.length > 6 ? `  *+${sorted.length - 6} more*` : '';
      embed.addFields({
        name:   `${label} (${sorted.length})`,
        value:  preview + overflow,
        inline: false,
      });
      rendered.add(key);
    }

    for (const [cat, cmds] of [...grouped.entries()].sort()) {
      if (rendered.has(cat)) continue;
      const sorted = cmds.sort();
      const preview = sorted.slice(0, 6).map(c => `\`${c}\``).join('  ');
      const overflow = sorted.length > 6 ? `  *+${sorted.length - 6} more*` : '';
      embed.addFields({
        name:  `${cat.charAt(0).toUpperCase() + cat.slice(1)} (${sorted.length})`,
        value: preview + overflow,
        inline: false,
      });
    }

    await safeReply(client, message, { embeds: [embed.toJSON()] });
  },
};
