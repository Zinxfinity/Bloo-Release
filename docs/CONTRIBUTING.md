# Changing Bloo

A practical guide to adding to or changing your copy of Bloo, whether you're adding a command for your own servers or sending a fix back. Read `README.md` and `ARCHITECTURE.md` first. This file assumes you know roughly how the bot fits together and covers the conventions to follow while writing code for it.

## Before you start

This release doesn't contain the economy game, the web dashboard or the website (see `README.md`). Nothing here depends on them, so everything you change can be run and tested with just the bot. Don't add code that imports economy files: they don't exist in this build, and the bot would fail to start.

Keep your changes easy to carry forward. Updates to Bloo arrive as a new version of these files, so a change made in its own new file (a new command, a new handler) merges more easily than an edit scattered across existing ones.

## The shape of a file

A command is a single file that exports one plain object with these fields:

- `name`: the word someone types to run it.
- `aliases`: optional other words that also run it.
- `description` and `usage`: shown by `b!help`.
- `accessLevel` and `requiredPermission`: who may run it. `requiredPermission` is a permission constant from `config/guildPermissions.js`, `null` if anyone may run it, or one of the special values `'SERVER_OWNER'` or `'BOT_OWNER'`.
- `internalAccess`: set to `true` on a command that checks permissions per subcommand itself (with `resolveAccess`), like `ticket` or `tag`. The command handler then only applies a server's "disabled" override and leaves the rest to the command.
- `cooldown`: how many seconds someone waits between uses.
- `execute`: an `async` function that receives `{ message, args, client, prefix }` and does the work.

An event file looks almost the same, with `name` set to a real Fluxer event and `execute(client, ...args)` instead.

Before writing a new command or event, open an existing one in the same category and copy its shape. Consistency matters more here than any one file being clever.

Rules that have caught real bugs:

- A channel ID from a user must belong to the server it's used in, otherwise staff in one server could point the bot at another server's channel. The command handler rejects any command whose arguments name another server's channel. Channel IDs that arrive another way (a stored setting, a message link) still need `isChannelInGuild` from `utils/channelGuard.js`. A command that deliberately takes another server's channel sets `allowForeignChannels: true`.
- When posting through raw REST (`client.rest.post`), mention settings go in the body as `allowed_mentions`. The camelCase `allowedMentions` only works with the library's `message.reply` and `send`.
- Timestamps in the database are unix seconds.

When a command or handler grows past a few hundred lines because it does more than one job, turn it into a folder. `commands/moderation/ticket/` is the example to copy: `index.js` works out which subcommand was used and hands off to a file next to it (`config.js`, `options.js`, `close.js` and so on). The loader accepts a single file or a folder with an `index.js`, so the split needs no changes anywhere else.

## Events have to be real Fluxer events

An event file's name has to match one of the event names `@fluxerjs/core` exports. The bot checks this at startup and rejects a file that doesn't match, with a logged error. There's no custom event system to fall back on: if you need to react to something Fluxer doesn't send as an event, put that logic inside an existing event handler.

Run `pnpm run check:events` after touching anything in `events/`. It's the same check the bot does at startup, without needing a token or a connection.

## Handling failures: runCritical and runLight

`handlers/resilience.js` provides two functions. Anywhere the bot calls into a command, an event step or a background job should go through one of them rather than a plain `try`/`catch`.

Use `runCritical(key, fn, opts)` for anything that controls who can do what in a server: anti-raid, bans and warnings, automod, the word filter, tickets. It counts failures in a row under that key and locks the feature down after too many, so a bug can't keep misbehaving quietly.

Use `runLight(key, fn, opts)` for lower-stakes features: XP, giveaways, the starboard, reaction roles, analytics. It has the same shape as `runCritical` without the lockout, so moving a feature between the two later is a one-line change.

Name each key after what it protects (`antiRaid.handleJoin`, not `antiRaid`), so a problem in one small piece doesn't lock down unrelated code in the same file.

## Database conventions

A handler that needs its own tables creates them the first time it loads, with `CREATE TABLE IF NOT EXISTS`. Later changes to a table are an additive `ALTER TABLE ... ADD COLUMN`, wrapped in a `try`/`catch` that ignores the "column already exists" error from running it twice. There's no single migrations file: the handler that uses a table owns its schema. `handlers/ticketSystem/schema.js` is a good example to copy.

Never rename or drop a column that's already shipped. Add a new one and move over to it, so an older copy of the database keeps working.

## Testing a change

- `pnpm run check` for a quick syntax check of the entry file.
- `pnpm run check:events` after event changes.
- Run the bot against a test server of your own before putting a change on the bot your communities use. A second bot account with its own token and its own `DB_PATH` keeps test data away from your real database.
- `b!reload` picks up edited commands without a restart, which speeds up trying things.
