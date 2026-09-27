# Bloo (self-hosted release)

Bloo is a moderation and community bot for the [Fluxer](https://fluxer.app) platform. This repository is the release build: the bot's source code, published so you can run your own copy of Bloo on your own machine or server, under your own bot account.

It is not the same thing as the Bloo you can invite from bloo-bot.xyz. That bot is run by Bloo's developer and includes extras this release leaves out, listed below. Your copy is yours to run: you create the bot account, you hold its token, and its data lives only on your machine.

## What's included

Everything below runs from chat commands, with the prefix you choose (`b!` by default):

- **Moderation:** warnings with automatic punishments, bans and temporary bans with an optional approval step, kicks, timeouts, purge, lockdown, slowmode, shadowbans, a watchlist, member history and lookups, and a mod log.
- **Protection:** anti-raid detection, member verification, automod, a word filter, link enforcement, and a link auditor that archives posted links.
- **Roles:** auto-role for new members (held until they pass verification, when verification is on), reaction roles, role menus, role persistence for members who leave and rejoin, and bulk role changes.
- **Support tickets:** ticket panels, staff-only channels, and an HTML transcript sent to the person who opened the ticket.
- **Ban appeals:** banned members can appeal by replying to Bloo's DM.
- **Community:** XP and levels, giveaways, polls, a starboard, welcome messages, tags and custom command aliases, reminders, scheduled messages, an embed builder, RSS and social feeds posted through webhooks, and announcement relays between servers.
- **General and fun:** server and user info, avatars, quotes, profiles, dice, 8ball, and a handful of light games.
- **Owner tools:** four commands only you (the people in `BOT_OWNERS`) can run. `b!fix` clears a command that locked itself after repeated errors, `b!reload` reloads commands without a restart, `b!eval` runs code in the bot's process, and `b!changelog` writes release notes and posts them to a webhook.
- **An alert watchdog** (`watchdog.js`) that watches the bot from outside and posts to a webhook when it freezes, loses its connection, or gets stuck restarting.

## What's not included

- **The economy.** Bloo's economy game (coins, jobs, the shop, NPCs, crafting, expeditions and the rest) is not part of this release and can't be switched on. Its code isn't in this repository, so there is nothing to enable.
- **The web dashboard.** Everything in this release is configured with chat commands instead. Commands that manage dashboard access, such as `b!dash`, still run, but they have nothing to connect to.
- **The website, docs site and status page** at bloo-bot.xyz.
- **Web captcha verification.** It sends members to a verification page on the website, which you won't have. Use the in-DM image captcha instead (see [Before you invite it](#before-you-invite-it)).
- **Hosting setup:** the developer's deploy scripts, server config and the watchdog service that restarts the official bot. You pick your own way of keeping the bot running.
- **The official bot's owner tools,** such as its global ban list and status page controls.

## What you need

- [Node.js](https://nodejs.org) 22 or newer.
- [pnpm](https://pnpm.io), the package manager this project uses.
- A bot application on Fluxer, created in your Fluxer developer settings, and its bot token.
- Somewhere to leave it running. A small VPS or a home machine that stays on both work. The bot keeps its data in one SQLite file, so there's no database server to set up.

Two dependencies (`better-sqlite3` and `canvas`) are native modules. pnpm downloads a prebuilt copy for most systems. If yours isn't covered, it builds one, which needs a C++ compiler and Python (on Debian or Ubuntu, `sudo apt install build-essential python3`).

## Setting it up

```bash
pnpm install
cp .env.example .env
```

Open `.env` in a text editor. Only two settings are required:

- `FLUXER_BOT_TOKEN`: your bot's token. Anyone who has it controls your bot, so never share `.env` or commit it anywhere.
- `BOT_OWNERS`: your own Fluxer user ID (or several, comma-separated). These accounts can run the owner tools.

Every other setting is optional and has a comment explaining it. A few worth a look early on:

- `FLUXER_CLIENT_ID`: your bot application's ID.
- `PREFIX`: the default prefix new servers start with. Each server can change its own with `b!prefix`.
- `ERROR_WEBHOOK_URL` and `STARTUP_WEBHOOK_URL`: Fluxer webhooks for error reports and start/stop notices, so you hear about problems without watching the console.
- `SITE_URL`: if you run your own site for the bot, set it here so links the bot sends point at your site.

Then start it:

```bash
pnpm start
```

The console should report the commands and events it loaded, then a successful connection to Fluxer. The database is created automatically at `data/bot.db` (change it with `DB_PATH`).

## Before you invite it

Run `b!botinvite` in a server where the bot already is, or build the invite link from your Fluxer developer settings. The default link asks for Administrator. `INVITE_PERMISSIONS` in `.env` changes that.

If a server uses verification, switch it to the in-DM captcha once with `b!antiraid mode dm`. The default mode is the web captcha, which this release can't serve.

`b!help` lists every command the bot has loaded, and `b!help <command>` explains one.

## Keeping it running

`pnpm start` stops when you close the terminal. On a server, run it under a process manager that starts it on boot and restarts it if it crashes, such as a systemd service with `Restart=always`, or pm2 (`pm2 start index.js --name bloo`).

The watchdog is optional. It only alerts and never restarts anything. To use it, set `WATCHDOG_WEBHOOK_URL` (and `WATCHDOG_WEBHOOK_PUBLIC_URL` if you want a short public status message too), then run `pnpm run watchdog` as a second process next to the bot.

## Updating

Pull the new version, run `pnpm install` again in case dependencies changed, and restart the bot. Database changes apply themselves when the bot starts. Back up `data/` first anyway: it's a copy of one file, and it's every server's settings.

## Useful checks

- `pnpm run check` does a quick syntax check of the entry file without starting the bot.
- `pnpm run check:events` confirms every file in `events/` is wired to a real Fluxer event.
- `pnpm run cleanup:guilds` lists leftover data for servers your bot is no longer in. It only reports by default; add `-- --execute` to delete it. Back up `data/` first.

## Project layout

- **`commands/`**: one file per chat command, in folders by category. A big command can be a folder with an `index.js` inside, like `commands/moderation/ticket/`.
- **`events/`**: one file per Fluxer event the bot listens to.
- **`handlers/`**: the logic behind the commands and events, including database access and background jobs.
- **`config/`**: permission constants, staff ranks, embed builders and feature switches.
- **`utils/`**: shared helpers such as the logger.
- **`scripts/`**: the scripts behind `pnpm run check:events` and `pnpm run cleanup:guilds`.
- **`docs/`**: this file, `ARCHITECTURE.md` (how the bot fits together) and `CONTRIBUTING.md` (conventions for changing it).

## License

AGPL-3.0. See `LICENSE`. If you change Bloo and let other people use your changed copy, the license asks you to share your changes under the same terms.
