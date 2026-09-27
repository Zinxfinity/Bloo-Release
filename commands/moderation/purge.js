import { EmbedBuilder }        from '@fluxerjs/core';
import { Embed, COLORS }        from '../../config/embeds.js';
import { Permissions } from '../../config/guildPermissions.js';

const BULK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const FLUXER_EPOCH    = 1420070400000;
const FETCH_CHUNK     = 100;
const BULK_DELAY_MS   = 300;
const DEL_DELAY_MS    = 150;
const MAX_COUNT       = 500;
const MAX_SCAN        = 5000;
const URL_REGEX       = /https?:\/\/\S+/i;

function parseUserId(arg) {
  if (!arg) return null;
  return arg.match(/^<@!?(\d+)>$/)?.[1] ?? (arg.match(/^\d{17,20}$/) ? arg : null);
}

function snowflakeToMs(id) {
  return Number(BigInt(id) >> 22n) + FLUXER_EPOCH;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(rest, channelId, before) {
  const url = before
    ? `/channels/${channelId}/messages?limit=${FETCH_CHUNK}&before=${before}`
    : `/channels/${channelId}/messages?limit=${FETCH_CHUNK}`;
  try {
    const result = await rest.get(url);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

async function collectMessages(rest, channelId, target, filterFn, skipIds) {
  const cutoffMs = Date.now() - BULK_MAX_AGE_MS;
  const bulk = [], individual = [];
  let before  = null;
  let scanned = 0;
  const limit = isFinite(target) ? Math.min(target * 5, MAX_SCAN) : MAX_SCAN;

  while (scanned < limit) {
    const batch = await fetchPage(rest, channelId, before);
    if (!batch.length) break;
    scanned += batch.length;

    for (const msg of batch) {
      if (skipIds.has(msg.id)) continue;
      const t = msg.type ?? 0;
      if (t !== 0 && t !== 19) continue;
      if (!filterFn(msg)) continue;
      if (snowflakeToMs(msg.id) > cutoffMs) bulk.push(msg.id);
      else individual.push(msg.id);
      if (bulk.length + individual.length >= target) break;
    }

    if (bulk.length + individual.length >= target) break;
    before = batch[batch.length - 1].id;
    if (batch.length < FETCH_CHUNK) break;
  }

  return { bulk, individual };
}

async function bulkDeleteChunked(rest, channelId, ids) {
  ids = [...new Set(ids)];
  let deleted = 0;
  for (let i = 0; i < ids.length; i += FETCH_CHUNK) {
    const chunk = ids.slice(i, i + FETCH_CHUNK);
    if (chunk.length === 1) {
      try {
        await rest.delete(`/channels/${channelId}/messages/${chunk[0]}`);
        deleted++;
      } catch { /* skip */ }
    } else {
      try {
        await rest.post(`/channels/${channelId}/messages/bulk-delete`, {
          body: { messages: chunk },
        });
        deleted += chunk.length;
      } catch {
        for (const id of chunk) {
          try { await rest.delete(`/channels/${channelId}/messages/${id}`); deleted++; } catch { /* skip */ }
          await sleep(DEL_DELAY_MS);
        }
      }
    }
    if (i + FETCH_CHUNK < ids.length) await sleep(BULK_DELAY_MS);
  }
  return deleted;
}

async function individualDelete(rest, channelId, ids) {
  let deleted = 0;
  const CONCURRENCY = 5;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(id => rest.delete(`/channels/${channelId}/messages/${id}`))
    );
    deleted += results.filter(r => r.status === 'fulfilled').length;
    if (i + CONCURRENCY < ids.length) await sleep(DEL_DELAY_MS);
  }
  return deleted;
}

async function doPurge(message, client, count, filterFn, filterDesc) {
  const channelId = message.channelId;

  // Raw REST throughout, not client.channels.fetch() + channel.send(): that
  // pattern was confirmed in production to fail with "channel.send is not
  // a function" for at least one channel type on v2.0.1's SDK. Posting by
  // channel ID string sidesteps channel-type/SDK-object issues entirely,
  // matching how most of this codebase already sends messages elsewhere.
  const working = await client.rest.post(`/channels/${channelId}/messages`, {
    body: { embeds: [Embed.info(`Scanning for ${filterDesc}…`, 'Working…').toJSON()] },
  }).catch(() => null);

  const { bulk, individual } = await collectMessages(
    client.rest, channelId, count, filterFn,
    new Set([message.id, working?.id].filter(Boolean))
  );
  const total = bulk.length + individual.length;

  if (!total) {
    if (working?.id) client.rest.delete(`/channels/${channelId}/messages/${working.id}`).catch(() => {});
    const m = await client.rest.post(`/channels/${channelId}/messages`, {
      body: { embeds: [Embed.warning(`No messages matching **${filterDesc}** found.`, 'Nothing Found').toJSON()] },
    }).catch(() => null);
    if (m?.id) setTimeout(() => client.rest.delete(`/channels/${channelId}/messages/${m.id}`).catch(() => {}), 6000);
    return;
  }

  if (working?.id) {
    client.rest.patch(`/channels/${channelId}/messages/${working.id}`, {
      body: { embeds: [Embed.info(`Deleting **${total}** message${total === 1 ? '' : 's'} (${filterDesc})…`, 'Working…').toJSON()] },
    }).catch(() => {});
  }

  let deleted = 0;
  if (bulk.length)       deleted += await bulkDeleteChunked(client.rest, channelId, bulk);
  if (individual.length) deleted += await individualDelete(client.rest, channelId, individual);

  client.rest.delete(`/channels/${channelId}/messages/${message.id}`).catch(() => {});
  if (working?.id) client.rest.delete(`/channels/${channelId}/messages/${working.id}`).catch(() => {});

  const confirm = await client.rest.post(`/channels/${channelId}/messages`, {
    body: {
      embeds: [new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle('Purge Complete')
        .setDescription(`Deleted **${deleted}** message${deleted === 1 ? '' : 's'} (${filterDesc}).`)
        .addFields({ name: 'By', value: message.author.username, inline: true })
        .toJSON()],
    },
  }).catch(() => null);
  if (confirm?.id) setTimeout(() => client.rest.delete(`/channels/${channelId}/messages/${confirm.id}`).catch(() => {}), 5000);
}

export default {
  name: 'purge',
  aliases: ['clear', 'prune', 'bulkdelete', 'cleanup'],
  description: 'Delete messages in bulk. Filter by user, type, or keyword.',
  usage: '{prefix}purge <number | all> [@user]\n{prefix}purge user @user [count]\n{prefix}purge images | links | bots | humans | embeds | pins [count]\n{prefix}purge contains <text>\n{prefix}purge nuke confirm',
  category: 'moderation',
  requiredPermission: Permissions.MANAGE_MESSAGES,

  cooldown: 5,

  async execute({ message, args, prefix, client }) {
    const PREFIX  = prefix ?? process.env.PREFIX ?? 'b!';
    if (!message.guildId) return;

    const raw0 = args[0]?.toLowerCase();

    if (raw0 === 'images') {
      const count = Math.min(parseInt(args[1], 10) || 100, MAX_COUNT);
      return doPurge(message, client, count, msg => (msg.attachments?.length ?? 0) > 0, 'images & attachments');
    }

    if (raw0 === 'links') {
      const count = Math.min(parseInt(args[1], 10) || 100, MAX_COUNT);
      return doPurge(message, client, count, msg => URL_REGEX.test(msg.content ?? ''), 'links & URLs');
    }

    if (raw0 === 'bots') {
      const count = Math.min(parseInt(args[1], 10) || 100, MAX_COUNT);
      return doPurge(message, client, count, msg => msg.author?.bot === true, 'bot messages');
    }

    if (raw0 === 'humans') {
      const count = Math.min(parseInt(args[1], 10) || 100, MAX_COUNT);
      return doPurge(message, client, count, msg => msg.author?.bot !== true, 'human messages');
    }

    if (raw0 === 'embeds') {
      const count = Math.min(parseInt(args[1], 10) || 100, MAX_COUNT);
      return doPurge(message, client, count, msg => (msg.embeds?.length ?? 0) > 0, 'embeds');
    }

    if (raw0 === 'pins') {
      const count = Math.min(parseInt(args[1], 10) || 100, MAX_COUNT);
      return doPurge(message, client, count, msg => msg.pinned === true, 'pinned messages');
    }

    if (raw0 === 'nuke') {
      if (args[1]?.toLowerCase() !== 'confirm') {
        return message.reply({
          embeds: [Embed.warning(
            `⚠️ This will instantly wipe **every message** in <#${message.channelId}> by cloning and deleting the channel.\n\nAll messages are gone permanently, pins, history, everything.\n\nRun \`${PREFIX}purge nuke confirm\` to proceed.`,
            'Confirm Required'
          ).toJSON()],
        }).catch(() => {});
      }

      let chData;
      try {
        chData = await client.rest.get(`/channels/${message.channelId}`);
      } catch (err) {
        return message.reply({
          embeds: [Embed.danger(`Could not fetch channel data: ${err.message}`, 'Failed').toJSON()],
        }).catch(() => {});
      }

      const cloneBody = {
        name:                  chData.name,
        type:                  chData.type,
        topic:                 chData.topic              ?? undefined,
        nsfw:                  chData.nsfw               ?? undefined,
        rate_limit_per_user:   chData.rate_limit_per_user ?? undefined,
        parent_id:             chData.parent_id          ?? undefined,
        position:              chData.position           ?? undefined,
        permission_overwrites: chData.permission_overwrites ?? [],
      };

      let newChannel;
      try {
        newChannel = await client.rest.post(`/guilds/${message.guildId}/channels`, { body: cloneBody });
      } catch (err) {
        return message.reply({
          embeds: [Embed.danger(`Could not create clone channel: ${err.message}`, 'Failed').toJSON()],
        }).catch(() => {});
      }

      try {
        await client.rest.delete(`/channels/${message.channelId}`);
      } catch (err) {
        try {
          await client.rest.post(`/channels/${newChannel.id}/messages`, {
            body: { embeds: [Embed.warning(
              `Original channel could not be deleted: ${err.message}\nPlease delete it manually.`,
              'Partial Nuke'
            ).toJSON()] },
          });
        } catch { /* ignore */ }
        return;
      }

      try {
        const conf = await client.rest.post(`/channels/${newChannel.id}/messages`, {
          body: { embeds: [new EmbedBuilder()
            .setColor(COLORS.SUCCESS)
            .setTitle('Channel Nuked')
            .setDescription(`This channel was wiped by **${message.author.username}**.\nAll previous messages have been permanently deleted.`)
            .toJSON()] },
        }).catch(() => null);
        if (conf?.id) setTimeout(() => client.rest.delete(`/channels/${newChannel.id}/messages/${conf.id}`).catch(() => {}), 8000);
      } catch { /* ignore */ }
      return;
    }

    if (raw0 === 'contains') {
      const phrase = args.slice(1).join(' ').trim();
      if (!phrase) {
        return message.reply({
          embeds: [Embed.warning(`Usage: \`${PREFIX}purge contains <text to match>\``, 'Missing Text').toJSON()],
        }).catch(() => {});
      }
      const lower = phrase.toLowerCase();
      return doPurge(message, client, 100, msg => (msg.content ?? '').toLowerCase().includes(lower), `messages containing "${phrase}"`);
    }

    if (raw0 === 'user') {
      const userId = parseUserId(args[1]);
      if (!userId) {
        return message.reply({
          embeds: [Embed.warning(`Usage: \`${PREFIX}purge user <@user|userId> [count]\``, 'Missing User').toJSON()],
        }).catch(() => {});
      }
      const count = Math.min(parseInt(args[2], 10) || 100, MAX_COUNT);
      return doPurge(message, client, count, msg => msg.author?.id === userId, `messages from <@${userId}>`);
    }

    // ── Standard: !purge <number | all> [@user] ───────────────
    const isAll        = raw0 === 'all';
    const rawCount     = isAll ? Infinity : parseInt(raw0, 10);
    const filterUserId = parseUserId(args[1]);

    if (isAll && !args.slice(1).includes('confirm')) {
      return message.reply({
        embeds: [Embed.warning(
          `⚠️ \`${PREFIX}purge all\` will delete **every message** in this channel (up to ${MAX_SCAN.toLocaleString()}).\n\nRun \`${PREFIX}purge all confirm\` to proceed, or \`${PREFIX}purge all @user confirm\` to wipe one user's messages.`,
          'Confirm Required'
        ).toJSON()],
      }).catch(() => {});
    }

    if (!isAll && (!rawCount || isNaN(rawCount) || rawCount < 1 || rawCount > MAX_COUNT)) {
      return message.reply({
        embeds: [Embed.info(
          [
            `**Standard:**  \`${PREFIX}purge <1-${MAX_COUNT} | all> [@user]\``,
            `**By User:**   \`${PREFIX}purge user @user [count]\``,
            `**Images:**    \`${PREFIX}purge images [count]\``,
            `**Links:**     \`${PREFIX}purge links [count]\``,
            `**Bots:**      \`${PREFIX}purge bots [count]\``,
            `**Humans:**    \`${PREFIX}purge humans [count]\``,
            `**Embeds:**    \`${PREFIX}purge embeds [count]\``,
            `**Pins:**      \`${PREFIX}purge pins [count]\``,
            `**Contains:**  \`${PREFIX}purge contains <text>\``,
            `**Nuke:**      \`${PREFIX}purge nuke confirm\`, wipe entire channel instantly`,
          ].join('\n'),
          'Purge, Usage'
        ).toJSON()],
      }).catch(() => {});
    }

    const target   = isAll ? Infinity : rawCount;
    const filterFn = filterUserId ? msg => msg.author?.id === filterUserId : () => true;

    // Raw REST, not client.channels.fetch() + channel.send(), see doPurge's
    // identical comment above for why.
    const working = await client.rest.post(`/channels/${message.channelId}/messages`, {
      body: { embeds: [Embed.info(
        `Collecting ${isAll ? 'all' : rawCount} message${rawCount === 1 ? '' : 's'}${filterUserId ? ` from <@${filterUserId}>` : ''}…`,
        'Working…'
      ).toJSON()] },
    }).catch(() => null);

    const { bulk, individual } = await collectMessages(
      client.rest, message.channelId, target, filterFn,
      new Set([message.id, working?.id].filter(Boolean))
    );
    const total = bulk.length + individual.length;

    if (!total) {
      if (working?.id) client.rest.delete(`/channels/${message.channelId}/messages/${working.id}`).catch(() => {});
      const m = await client.rest.post(`/channels/${message.channelId}/messages`, {
        body: { embeds: [Embed.warning(
          filterUserId ? `No messages from <@${filterUserId}> found.` : 'No messages found.',
          'Nothing to Delete'
        ).toJSON()] },
      }).catch(() => null);
      if (m?.id) setTimeout(() => client.rest.delete(`/channels/${message.channelId}/messages/${m.id}`).catch(() => {}), 6000);
      return;
    }

    if (working?.id) {
      client.rest.patch(`/channels/${message.channelId}/messages/${working.id}`, {
        body: { embeds: [Embed.info(
          `Deleting **${total}** message${total === 1 ? '' : 's'}${filterUserId ? ` from <@${filterUserId}>` : ''}…`,
          'Working…'
        ).toJSON()] },
      }).catch(() => {});
    }

    let deleted = 0;
    if (bulk.length)       deleted += await bulkDeleteChunked(client.rest, message.channelId, bulk);
    if (individual.length) deleted += await individualDelete(client.rest, message.channelId, individual);

    client.rest.delete(`/channels/${message.channelId}/messages/${message.id}`).catch(() => {});
    if (working?.id) client.rest.delete(`/channels/${message.channelId}/messages/${working.id}`).catch(() => {});

    const confirm = await client.rest.post(`/channels/${message.channelId}/messages`, {
      body: {
        embeds: [new EmbedBuilder()
          .setColor(COLORS.SUCCESS)
          .setTitle('Purge Complete')
          .setDescription(filterUserId
            ? `Deleted **${deleted}** message${deleted === 1 ? '' : 's'} from <@${filterUserId}>.`
            : `Deleted **${deleted}** message${deleted === 1 ? '' : 's'}.`)
          .addFields({ name: 'By', value: message.author.username, inline: true })
          .toJSON()],
      },
    }).catch(() => null);
    if (confirm?.id) setTimeout(() => client.rest.delete(`/channels/${message.channelId}/messages/${confirm.id}`).catch(() => {}), 5000);
  },
};
