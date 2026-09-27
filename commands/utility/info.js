// ============================================================
//  commands/utility/info.js
//  Category : Utility  |  Access 0, Everyone  |  Rank 0, Public
//
//  Shows general bot information and live runtime stats.
// ============================================================

import { Embed } from '../../config/embeds.js';
import { latestRelease } from '../../handlers/changelog.js';
import { siteUrl } from '../../config/site.js';
import { readFileSync } from 'fs';

// The last published changelog release, or package.json before the first one.
const PKG_VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return null; } })();

export default {
  name: 'info',
  aliases: ['about', 'botinfo'],
  description: 'View Bloo\'s current version and runtime stats.',
  usage: '{prefix}info',
  category: 'utility',

  requiredPermission: null,

  cooldown: 10,

  async execute({ message, client }) {
    const upSec = Math.floor(process.uptime());
    const h = Math.floor(upSec / 3600);
    const m = Math.floor((upSec % 3600) / 60);
    const s = upSec % 60;

    const commandCount = client.commands
      ? new Set([...client.commands.values()].map(c => c.name)).size
      : '—';

    const release = latestRelease();
    const version = release?.version ?? PKG_VERSION;

    const embed = Embed.info('Bloo')
      .setDescription(
        'A moderation and management bot built on **FluxerJS**.\n' +
        'For help or to report an issue, contact the server owner or bot developer.\n\nSupport the bot developer [here](https://ko-fi.com/bloofluxer).'
      )
      .addFields(
        { name: '🏷️  Version',    value: version ? `[v${version}](${release?.url ?? `${siteUrl()}/docs/changelog/`})` : '—', inline: true },
        { name: '⚙️  Framework',  value: 'FluxerJS',                          inline: true },
        { name: '⏱️  Uptime',     value: `${h}h ${m}m ${s}s`,                 inline: true },
        { name: '📋  Commands',   value: `${commandCount}`,                    inline: true },
        { name: '🌐  Servers',    value: `${client.guilds?.size ?? '—'}`,       inline: true },
        { name: '🛠️  Node.js',    value: process.version,                      inline: true },
        { name: '📊  Memory',     value: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`, inline: true },
      )
      .setFooter({ text: 'All rights reserved, Bloo' });

    await message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
  },
};
