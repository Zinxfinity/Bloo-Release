import db from '../../db.js';
import { Embed } from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
// channel_lock_snapshots is created in db.js global schema

const stmts = {
  // target_id/target_type supplied explicitly: the live table predates
  // this file's simpler 4-column model (db.js's own CREATE TABLE IF NOT
  // EXISTS is a no-op against it) and has NOT NULL target_id/target_type
  // columns with no default, part of its real PRIMARY KEY (guild_id,
  // channel_id, target_id). Every existing live row already uses
  // target_id === guild_id (the @everyone role's ID always equals the
  // guild ID), matching what this code snapshots, so that's supplied
  // consistently here too. Omitting these threw "NOT NULL constraint
  // failed: channel_lock_snapshots.target_id" on every single lock,
  // uncaught, quarantining the whole command after one use.
  saveSnapshot: db.prepare(`
    INSERT OR REPLACE INTO channel_lock_snapshots
      (guild_id, channel_id, target_id, target_type, allow, deny, snapshot, locked_at)
    VALUES (?, ?, ?, 0, ?, ?, ?, unixepoch())
  `),
  getSnapshot:    db.prepare(`SELECT snapshot FROM channel_lock_snapshots WHERE guild_id = ? AND channel_id = ?`),
  deleteSnapshot: db.prepare(`DELETE FROM channel_lock_snapshots WHERE guild_id = ? AND channel_id = ?`),
  listLocked:     db.prepare(`SELECT channel_id FROM channel_lock_snapshots WHERE guild_id = ?`),
};

// Permission bits to deny when locking a text / voice channel
const SEND_MESSAGES          = 1n << 11n;
const CREATE_PUBLIC_THREADS  = 1n << 35n;
const CREATE_PRIVATE_THREADS = 1n << 36n;
const SPEAK                  = 1n << 21n;

const TEXT_LOCK_BITS  = (SEND_MESSAGES | CREATE_PUBLIC_THREADS | CREATE_PRIVATE_THREADS).toString();
const VOICE_LOCK_BITS = SPEAK.toString();

// Channel types: text=0, voice=2, category=4, announcement=5, thread=15, stage=13
const TEXT_TYPES  = new Set([0, 5, 15]);
const VOICE_TYPES = new Set([2, 13]);

function lockBitsFor(type) {
  if (VOICE_TYPES.has(type)) return VOICE_LOCK_BITS;
  return TEXT_LOCK_BITS;
}

// Lock bits are layered onto the existing @everyone overwrite rather than
// replacing it: replacing dropped every other deny, so a private channel
// (@everyone denied View Channel) became visible for the whole lockdown.
export function mergeLockBits(existingAllow, existingDeny, lockBits) {
  const lock = BigInt(lockBits);
  return {
    allow: (BigInt(existingAllow || '0') & ~lock).toString(),
    deny:  (BigInt(existingDeny  || '0') |  lock).toString(),
  };
}

// Returns true when the channel ends up locked.
export async function lockChannel(client, guildId, channelId, type) {
  const ch = await client.rest.get(`/channels/${channelId}`).catch(() => null);
  if (!ch || ch.guild_id !== guildId) return false;
  const everyoneOW = ch.permission_overwrites?.find(o => o.id === guildId);

  // Only snapshot the pre-lock state once. Locking an already-locked channel
  // (e.g. `lockdown` then `lockdown all`) used to overwrite the real
  // snapshot with the locked state, so unlocking restored the lock.
  if (!stmts.getSnapshot.get(guildId, channelId)) {
    stmts.saveSnapshot.run(
      guildId, channelId, guildId,
      everyoneOW?.allow ?? '0', everyoneOW?.deny ?? '0',
      JSON.stringify(everyoneOW ?? {}),
    );
  }

  const bits = mergeLockBits(everyoneOW?.allow, everyoneOW?.deny, lockBitsFor(type ?? ch.type ?? 0));
  try {
    await client.rest.put(`/channels/${channelId}/permissions/${guildId}`, {
      body: { id: guildId, type: 0, ...bits },
    });
    return true;
  } catch {
    return false;
  }
}

export async function restoreChannel(client, guildId, channelId) {
  const row = stmts.getSnapshot.get(guildId, channelId);

  let snap = null;
  if (row?.snapshot) { try { snap = JSON.parse(row.snapshot); } catch { /* corrupt */ } }

  try {
    if (snap && (snap.allow !== undefined || snap.deny !== undefined)) {
      await client.rest.put(`/channels/${channelId}/permissions/${guildId}`, {
        body: { id: guildId, type: 0, allow: snap.allow ?? '0', deny: snap.deny ?? '0' },
      });
    } else if (row) {
      // Snapshot says there was no @everyone overwrite before the lock.
      await client.rest.delete(`/channels/${channelId}/permissions/${guildId}`);
    } else {
      // No snapshot at all: only lift the lock bits, never wipe the whole
      // overwrite (that made private channels public on a stray unlock).
      const ch = await client.rest.get(`/channels/${channelId}`).catch(() => null);
      if (!ch || ch.guild_id !== guildId) return false;
      const ow = ch.permission_overwrites?.find(o => o.id === guildId);
      if (!ow) return true;
      const lock = BigInt(TEXT_LOCK_BITS) | BigInt(VOICE_LOCK_BITS);
      await client.rest.put(`/channels/${channelId}/permissions/${guildId}`, {
        body: { id: guildId, type: 0, allow: ow.allow ?? '0', deny: (BigInt(ow.deny ?? '0') & ~lock).toString() },
      });
    }
  } catch {
    return false;
  }
  stmts.deleteSnapshot.run(guildId, channelId);
  return true;
}

export default {
  name: 'lockdown',
  aliases: ['lock', 'unlock', 'lift'],
  description: 'Lock or unlock channels. Use `all` for server-wide lockdown or a category name/ID.',
  usage: '{prefix}lockdown [#channel|all|<category>] [reason]\n{prefix}lockdown unlock [#channel|all]\n{prefix}lockdown lift [all]',
  requiredPermission: Permissions.BAN_MEMBERS,

  cooldown: 5,

  async execute({ message, args, prefix, client }) {
    const guildId   = message.guildId;
    const channelId = message.channelId;
    if (!guildId) return;

    const cmdName = message.content.slice(prefix?.length ?? 2).trim().split(/\s+/)[0].toLowerCase();
    const sub     = args[0]?.toLowerCase();

    // Unlock / lift subcommand
    if (sub === 'unlock' || sub === 'lift' || cmdName === 'unlock' || cmdName === 'lift') {
      const targetArg = (sub === 'unlock' || sub === 'lift') ? args[1] : args[0];
      return handleUnlock(client, message, targetArg, guildId, channelId);
    }

    const lockAll = sub === 'all';

    // Detect channel mention or ID as first arg
    const channelArgMatch = args[0]?.match(/^<#(\d+)>$/) ?? (args[0]?.match(/^\d{17,20}$/) ? [null, args[0]] : null);
    let targetChannelId = channelArgMatch ? channelArgMatch[1] : channelId;
    const reason = (lockAll
      ? args.slice(1)
      : channelArgMatch ? args.slice(1) : args
    ).join(' ') || 'Lockdown.';

    if (lockAll) {
      const channels = await client.rest.get(`/guilds/${guildId}/channels`).catch(() => []);
      const lockable  = channels.filter(c => TEXT_TYPES.has(c.type) || VOICE_TYPES.has(c.type));
      const failed = await lockMany(client, guildId, lockable);
      return message.reply({ embeds: [Embed.warning(`🔒 Locked **${lockable.length - failed}** channels${failed ? ` (${failed} failed, check my permissions)` : ''}. Reason: ${reason}`).toJSON()] });
    }

    // Category lockdown: if arg is not a channel mention and not empty, treat as category name/id
    if (args[0] && !channelArgMatch) {
      const allChannels = await client.rest.get(`/guilds/${guildId}/channels`).catch(() => []);
      const categories  = allChannels.filter(c => c.type === 4);
      const cat = categories.find(c =>
        c.id === args[0] || c.name.toLowerCase() === args[0].toLowerCase()
      );
      if (cat) {
        const children = allChannels.filter(c =>
          c.parent_id === cat.id && (TEXT_TYPES.has(c.type) || VOICE_TYPES.has(c.type))
        );
        const failed = await lockMany(client, guildId, children);
        return message.reply({ embeds: [Embed.warning(`🔒 Locked **${children.length - failed}** channels in **${cat.name}**${failed ? ` (${failed} failed)` : ''}. Reason: ${reason}`).toJSON()] });
      }
    }

    // lockChannel fetches the channel itself, so it uses the real channel
    // type (voice gets Speak denied, not Send Messages) and refuses channels
    // from other servers.
    if (!await lockChannel(client, guildId, targetChannelId)) {
      return message.reply({ embeds: [Embed.danger('Could not lock that channel. It may not be in this server, or I lack Manage Channels / Manage Roles there.').toJSON()] });
    }
    await message.reply({ embeds: [Embed.warning(`🔒 <#${targetChannelId}> locked. Reason: ${reason}`).toJSON()] });
  },
};

async function lockMany(client, guildId, channels) {
  let failed = 0;
  for (const ch of channels) if (!await lockChannel(client, guildId, ch.id, ch.type)) failed++;
  return failed;
}

async function handleUnlock(client, message, targetArg, guildId, currentChannelId) {
  const unlockAll = targetArg?.toLowerCase() === 'all';

  if (unlockAll) {
    const locked = stmts.listLocked.all(guildId);
    if (!locked.length) {
      return message.reply({ embeds: [Embed.info('No locked channels found in the snapshot.').toJSON()] });
    }
    let failed = 0;
    for (const row of locked) if (!await restoreChannel(client, guildId, row.channel_id)) failed++;
    return message.reply({ embeds: [Embed.success(`🔓 Unlocked **${locked.length - failed}** channels${failed ? ` (${failed} failed, their snapshots are kept so you can retry)` : ''}.`).toJSON()] });
  }

  const channelMatch = targetArg?.match(/^<#(\d+)>$/) ?? (targetArg?.match(/^\d{17,20}$/) ? [null, targetArg] : null);
  const targetId = channelMatch ? channelMatch[1] : currentChannelId;

  if (!await restoreChannel(client, guildId, targetId)) {
    return message.reply({ embeds: [Embed.danger('Could not unlock that channel. It may not be in this server, or I lack permission there.').toJSON()] });
  }
  await message.reply({ embeds: [Embed.success(`🔓 <#${targetId}> unlocked.`).toJSON()] });
}
