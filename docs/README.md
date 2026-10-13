# Bloo (self-hosted release)

Hi! I'm the developer of Bloo, a moderation and community bot for [Fluxer](https://fluxer.app). This repository is the release build: Bloo's source code, published so you can run your own copy on your own machine or server, under your own bot account.

Your copy isn't the Bloo you can invite from bloo-bot.xyz. I run that one, and it has a few extras this release leaves out, listed below. Your copy is yours: you create the bot account, you hold its token, and its data stays on your machine. I never see any of it.

## What you get

Everything below runs from chat commands, with the prefix you choose (`b!` by default):

- **Moderation:** warnings with automatic punishments, bans and temporary bans with an optional approval step, kicks, timeouts, purge, lockdown, slowmode, shadowbans, a watchlist, member history and lookups, and a mod log.
- **Protection:** anti-raid detection, member verification, automod, a word filter, link enforcement, and a link auditor that archives posted links.
- **Roles:** auto-role for new members (held until they pass verification, when verification is on), reaction roles, role menus, role persistence for members who leave and rejoin, and bulk role changes.
- **Support tickets:** ticket panels, staff-only channels, and an HTML transcript sent to whoever opened the ticket. By default, people can attach files, embed links and react in their own ticket. `b!ticket perms` changes that for new tickets, and `b!ticket allow attach` or `b!ticket deny attach`, run inside a ticket, changes it for that one.
- **Ban appeals:** banned members can appeal by replying to Bloo's DM.
- **Welcomes and goodbyes:** a welcome message, and a welcome card (an image with the member's avatar and two lines of text) in any of eight themes. A server can set its own colours, use its banner as the card's background, or (the server owner only) upload its own image. The same card can show when someone leaves. Placeholders like `{name}`, `{count}` and `{ordinal}` work in all of it; `b!welcome card` explains the options.
- **Community:** XP and levels, giveaways, polls, a starboard, tags and custom command aliases, reminders, scheduled messages, an embed builder, and RSS and social feeds posted through webhooks.
- **Rank cards:** image rank and profile cards in eight themes, picked per member with `b!card`. Members can also submit their own card background, but that's switched off until you turn it on with `b!card backgrounds on`, and every upload waits for you to approve it (`b!card review`).
- **Hearing from your users:** `b!suggest` posts ideas to a channel for voting and DMs the suggester when you set a status, `b!feedback` takes private notes, and commands marked as beta only work for a beta tester role. They're set up in `.env` (the Community section).
- **FluxerList votes:** if your copy has its own FluxerList listing, `b!vote` and voter perks (a Supporter badge, a card theme and an optional role) work with your own API key.
- **A welcome DM** to the owner of each new server your copy joins, sent once, with where to start.
- **General and fun:** server and user info, avatars, quotes, profiles, dice, 8ball, and a handful of light games.
- **Owner tools:** four commands only you (the accounts in `BOT_OWNERS`) can run. `b!fix` clears a command that locked itself after repeated errors, `b!reload` reloads commands without a restart, `b!eval` runs code in the bot's process, and `b!changelog` writes release notes and posts them to a webhook.
- **An alert watchdog** (`watchdog.js`) that watches the bot from outside and posts to a webhook when it freezes, loses its connection, or gets stuck restarting.

## What's not included

- **The economy.** Bloo's economy game (coins, jobs, the shop, NPCs, crafting, expeditions and the rest) isn't part of this release and can't be switched on. Its code isn't in this repository, so there's nothing to enable.
- **The web dashboard.** Everything here is set up with chat commands instead. Commands that manage dashboard access, such as `b!dash`, still run, but there's nothing for them to connect to. A few things only the dashboard can do (analytics, the server insights page, switching welcome card uploads off) stay at their defaults.
- **The website, docs site and status page** at bloo-bot.xyz, including posting status updates to Fluxer.
- **Web captcha verification.** It sends members to a verification page on my website, which your copy doesn't have. Use the in-DM image captcha instead (see [Before you invite it](#before-you-invite-it)).
- **My hosting setup:** my deploy scripts, server config, local development launcher, and the watchdog service that restarts the official bot. You pick your own way of keeping your copy running.
- **The official bot's owner tools,** such as its global ban list, status page controls and contributor credits.

## What you need

- [Node.js](https://nodejs.org) 22.13 or newer.
- [pnpm](https://pnpm.io), the package manager this project uses.
- A bot application on Fluxer, created in your Fluxer developer settings, and its bot token.
- Somewhere to leave it running. A small VPS or a home machine that stays on both work. The bot keeps its data in one SQLite file, so there's no database server to set up.

Two dependencies (`better-sqlite3` and `canvas`) are native modules. pnpm downloads a prebuilt copy for most systems. If yours isn't covered, it builds one, which needs a C++ compiler and Python (on Debian or Ubuntu, `sudo apt install build-essential python3`).

Bloo is built on [`@fluxerjs/core`](https://fluxer.js.org) 3.3. The lockfile pins the exact versions I've tested, so `pnpm install` gives you the same ones.

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

Keep each comment on its own line, not after a value. If you run Bloo under systemd, it reads everything after `=` as the value, comment and all. Bloo ignores those comments for its own settings and tells you at startup which ones it found, but it's tidier to fix them.

Then check it and start it:

```bash
pnpm run env:check
pnpm start
```

`env:check` compares your `.env` with `.env.example` and lists anything missing, without ever printing your values. The console should then report the commands and events it loaded, then a successful connection to Fluxer. The database is created automatically at `data/bot.db` (change it with `DB_PATH`).

## Before you invite it

Run `b!botinvite` in a server where the bot already is, or build the invite link from your Fluxer developer settings. The default link asks for Administrator; `INVITE_PERMISSIONS` in `.env` changes that.

If a server uses verification, switch it to the in-DM captcha once with `b!antiraid mode dm`. The default mode is the web captcha, which this release can't serve.

`b!help` lists every command your bot has loaded, and `b!help <command>` explains one.

## Keeping it running

`pnpm start` stops when you close the terminal. On a server, run it under a process manager that starts it on boot and restarts it if it crashes, such as a systemd service with `Restart=always`, or pm2 (`pm2 start index.js --name bloo`).

The watchdog is optional. It only alerts and never restarts anything. To use it, set `WATCHDOG_WEBHOOK_URL` (and `WATCHDOG_WEBHOOK_PUBLIC_URL` if you want a short public status message too), then run `pnpm run watchdog` as a second process next to the bot.

## Updating

When I publish a new version:

1. Back up `data/` first. It's every server's settings, plus any card images people have uploaded.
2. Pull the new version and run `pnpm install`, in case the dependencies changed.
3. Run `pnpm run env:check`. It lists any settings the update added, with what each one is for, so you can add them to your `.env`.
4. Restart the bot. Database changes apply themselves when it starts.

## Useful checks

- `pnpm run env:check` compares your `.env` with `.env.example` (add `-- path/to/file` to check another file).
- `pnpm run check` does a quick syntax check of the entry file without starting the bot.
- `pnpm run check:events` confirms every file in `events/` is wired to a real Fluxer event.
- `pnpm run cleanup:guilds` lists leftover data for servers your bot is no longer in. It only reports by default; add `-- --execute` to delete it. Back up `data/` first.

## Project layout

- **`commands/`**: one file per chat command, in folders by category. A big command can be a folder with an `index.js` inside, like `commands/moderation/ticket/`.
- **`events/`**: one file per Fluxer event the bot listens to.
- **`handlers/`**: the logic behind the commands and events, including database access and background jobs.
- **`config/`**: permission constants, staff ranks, embed builders and feature switches.
- **`utils/`**: shared helpers such as the logger.
- **`scripts/`**: the scripts behind `pnpm run env:check`, `check:events` and `cleanup:guilds`.
- **`data/`** (created when the bot first runs): the database, plus `card-backgrounds/` and `welcome-backgrounds/` for card images.
- **`docs/`**: this file, `ARCHITECTURE.md` (how the bot fits together) and `CONTRIBUTING.md` (conventions for changing it).

## License

AGPL-3.0. See `LICENSE`. If you change Bloo and let other people use your changed copy, the license asks you to share your changes under the same terms.

Thanks for running Bloo. If you find a bug, I'd love to hear about it in the [Bloo support server](https://fluxer.gg/bloo).
