# Architecture

This file explains how your copy of Bloo is put together, from the moment it starts to how a chat message ends up running a command. It assumes you've read `README.md`. You don't need to have worked on a chat bot before: where a section needs background, it explains the idea first and then how Bloo uses it.

## Some background: what a bot connection is

A bot stays connected to Fluxer through the gateway, a connection that stays open the whole time the bot runs, instead of the bot repeatedly asking for news. Fluxer pushes events down that connection as they happen: someone sent a message, someone joined a server, a reaction was added. The bot listens for the events it cares about and reacts to them, which is why so much of this codebase is organised around events rather than requests and responses.

## Boot

`index.js` is the first file that runs. In order, it:

1. Loads your settings from `.env` (or from the file named in `DOTENV_CONFIG_PATH`, if you set one), then `config/envClean.js` strips any comment left on the same line as one of Bloo's settings, since systemd would otherwise pass it through as part of the value.
2. Creates the connection object (the `Client` from `@fluxerjs/core` 3.3, the library Bloo is built on).
3. Loads `db.js`, which opens the database and creates the core tables before anything else touches it.
4. Loads every command (`handlers/commandLoader.js`) and every event handler (`handlers/eventHandler.js`).
5. Connects to the gateway, retrying with growing delays if the first attempt fails.

While it connects, Fluxer sends each server the bot is already in. The library reports those as "available", and saves "a server was created" (`GuildCreate`) for servers the bot joins after it's up, so `events/guild/guildCreate.js` only ever greets genuinely new servers. `ready.js` registers the startup servers itself.

Once connected, `events/client/ready.js` starts the background jobs: the heartbeat the watchdog reads, temporary ban expiry, giveaways, polls, reminders, scheduled messages, XP decay, feed polling and the rest. After that, everything is triggered by events arriving over the gateway. There's no main loop polling for work.

## A message's path through the bot

From the moment someone sends a message in a server your bot is in, to a command running:

1. Fluxer sends a `MessageCreate` event down the gateway.
2. `handlers/eventHandler.js` checked at startup that this is a real Fluxer event name. It also wraps the handler, so an unexpected error inside is caught and logged instead of dropping the connection.
3. `events/guild/messageCreate.js` runs a fixed list of steps in order: saving the message for ticket transcripts if it's in a ticket channel, XP, analytics, message logging, automod, the word filter, link enforcement and the link auditor. The order matters, since automod, the word filter or link enforcement can stop a message (by deleting it, for example) before it reaches anything later.
4. If nothing stopped it, the message reaches `handlers/commandHandler.js`, which decides whether it's a command. It checks the server's prefix, whether commands are allowed in this channel, whether this user may run this command (including any per-server change made with `b!permissions`), and whether they're on cooldown. A word that isn't a real command or alias is looked up last as one of the server's tags, so a tag can never replace a real command.
5. Only after all of those checks pass does the command's own code run.

If a command throws an unexpected error (anything other than a known case like missing permissions or a brief network problem), it locks itself so only the bot owners can run it, until an owner clears the lock with `b!fix`. One broken command then can't keep failing for everyone.

## Commands and events are plain files

There's no decorator system, class hierarchy or build step. A command is one JavaScript file exporting a plain object with a name, a description, who may run it, and a function that runs when it's used. An event file looks almost the same, reacting to a Fluxer event by name instead. `CONTRIBUTING.md` shows the exact shape of both.

One rule is enforced automatically: an event file's name has to match an event Fluxer really sends. If it doesn't, the bot logs an error and refuses to register that file. A mistyped event name would otherwise make a feature stop working without any sign.

## Keeping one failure from spreading

`handlers/resilience.js` is the safety net used wherever the bot calls into a command, an event step or a background job. It comes in two versions:

- **`runCritical`** is for moderation and protection, where a silent failure is a real problem: anti-raid, bans and warnings, automod, the word filter, tickets. It counts failures in a row, and after too many it stops trying and locks that one piece down.
- **`runLight`** is for everything else, where a failure is worth logging but doesn't need a lockout: XP, giveaways, the starboard, reaction roles and similar.

Each use has its own specific label (like `antiRaid.handleJoin` rather than `antiRaid`), so a bug in one small piece doesn't lock down unrelated features in the same file.

## Growing a file into a folder

When a command or handler file gets too big because it does several jobs, it becomes a folder. `commands/moderation/ticket/` and `handlers/ticketSystem/` are the reference example: the command folder handles what a user types and sees, and the handler folder owns the database and the logic of opening, closing and reopening tickets. The command side calls the handler side, never the other way round. The loader accepts both a single file and a folder with an `index.js`, so splitting a file never means touching the loader.

## Database

`db.js` opens one shared SQLite database (a database kept in a single file, with no separate server) in WAL mode, which lets several processes read and write it safely at the same time. Past that connection and a few global tables, every feature owns its own tables: a handler creates what it needs the first time it loads, and later changes to a table are added on top rather than replacing anything. There's no central list of migrations, so adding a feature never means editing an unrelated shared file. It also means updating your copy needs no migration step: new tables and columns appear the next time the bot starts.

Most tables only grow as fast as servers use a feature. Analytics is the exception: it records every hour for each server that turned it on, so `handlers/analyticsSystem.js` cleans up after itself once a day. In this release analytics stays off, because the switch for it lives on the dashboard, so those tables stay empty.

Images live next to the database, not in it. `data/card-backgrounds/` holds rank card backgrounds members submit, and `data/welcome-backgrounds/` holds welcome card images: one a server owner uploaded, or a card-sized copy of a server's banner. Every image is cropped and re-saved by Bloo, so nothing is stored at its original size. A server's welcome images are deleted when the bot leaves that server.

Back up the whole `data/` folder before updating or moving the bot. Copy it while the bot is stopped, or copy the `-wal` and `-shm` files next to `bot.db` as well.

## Ticket transcripts

When a ticket closes, the person who opened it is sent a readable copy of the conversation before the channel is deleted. The transcript is an HTML file styled like a Fluxer conversation, drawn by `utils/transcriptHtml.js`. Only the ticket opener and the staff involved appear in it, so someone who wandered into the channel isn't included in the record.

## Who counts as staff

Bloo's own permission checks sit on top of Fluxer's. `config/guildPermissions.js` names the Fluxer permissions each command needs, and a server can move a command up or down with `b!permissions`. Two values go beyond Fluxer permissions: `SERVER_OWNER` (only the server's owner) and `BOT_OWNER` (only the accounts in `BOT_OWNERS`, which is you).

## The changelog

`handlers/changelog.js` keeps release notes for your bot. `b!changelog add` writes an entry as a draft, and `b!changelog publish` gathers every draft into a numbered release and posts it through the webhook in `CHANGELOG_WEBHOOK_URL`. `b!info` shows the latest version. You don't have to use it: with no releases, `b!info` shows the version from `package.json`.

## The watchdog

The bot writes a small heartbeat file every few seconds (`handlers/heartbeat.js`), including how long it has been since the gateway last sent anything. `watchdog.js` runs as a separate process and reads that file from outside, since a frozen or crashed process can't report its own problem. When the heartbeat goes stale, the gateway goes quiet, or the bot keeps restarting, it posts to your watchdog webhooks. It never restarts the bot itself; that's your process manager's job.

## What this release leaves out

This release is built from the same source as the official Bloo, minus a few parts. The economy game isn't in it: where shared code would reach the economy, it asks `config/features.js` first, which answers that there is no economy, so nothing economy-related loads or runs. The web dashboard isn't in it either. It's a separate program that reads the same database. Almost everything it changes also has a chat command, so the bot works without it; the few dashboard-only settings (analytics, for one) simply stay at their defaults.
