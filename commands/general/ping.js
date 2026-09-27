import { Embed } from '../../config/embeds.js';

export default {
  name: 'ping',
  description: 'Check bot latency and uptime.',
  usage: '{prefix}ping',
  requiredPermission: null,

  cooldown: 5,

  async execute({ message, client }) {
    const start    = Date.now();
    const sent     = await message.reply({ embeds: [Embed.info('Pinging…').toJSON()] });
    const latency  = Date.now() - start;
    const uptime   = process.uptime();
    const uptimeLabel = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`;

    await sent.edit({
      embeds: [Embed.success(
        `**Latency:** ${latency}ms\n**Uptime:** ${uptimeLabel}`
      ).toJSON()],
    });
  },
};
