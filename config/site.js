// The public site this bot points people at: verify links, the dashboard,
// the changelog and the "Watching" presence. SITE_URL in .env sets it, so a
// self-hosted copy links to its own site instead of bloo-bot.xyz.
export const siteUrl  = () => (process.env.SITE_URL || 'https://bloo-bot.xyz').replace(/\/+$/, '');
export const siteHost = () => siteUrl().replace(/^https?:\/\//, '');
