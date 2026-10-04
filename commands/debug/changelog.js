// ============================================================
//  commands/debug/changelog.js
//  Category : Debug  |  Access: Bot Owner
//
//  Writes and publishes Bloo's changelog. Same records and rules as the
//  dashboard's Developer → Changelog, both use handlers/changelog.js.
//
//  b!changelog                                  drafts waiting to publish
//  b!changelog add [tag,tag] <title> | <body>    new draft entry
//  b!changelog edit <id> <title> | <body>        rewrite a draft
//  b!changelog tags <id> <tag,tag>               set a draft's tags
//  b!changelog remove <id>                       delete a draft
//  b!changelog publish <2.1.0|patch|minor|major> publish drafts and post them
//  b!changelog repost <version>                  post a release to Fluxer again
//  b!changelog latest                            show the last release
// ============================================================

import { Embed } from '../../config/embeds.js';
import {
  TAGS, listDrafts, addDraft, editDraft, deleteDraft, publish, postRelease,
  listReleases, latestRelease, suggestVersion, webhookSummary,
} from '../../handlers/changelog.js';
import { fitLines } from '../../utils/format.js';

const splitTitle = text => {
  const [title, ...body] = text.split('|');
  return { title: title.trim(), body: body.join('|').trim().replace(/\\n/g, '\n') };
};
const looksLikeTags = s => /^[a-z,]+$/.test(s ?? '') && s.split(',').every(t => TAGS.includes(t));

export default {
  name: 'changelog',
  aliases: ['release', 'releases'],
  description: 'Write and publish Bloo\'s changelog.',
  usage: '{prefix}changelog [add|edit|tags|remove|publish|repost|latest]',
  requiredPermission: 'BOT_OWNER',
  cooldown: 0,

  async execute({ message, args, prefix }) {
    const P = prefix ?? 'b!';
    const by = message.author.id;
    const reply = embed => message.reply({ embeds: [embed.toJSON()] }).catch(() => {});
    const sub = (args[0] ?? 'list').toLowerCase();
    const help = `\`${P}changelog add [${TAGS.slice(0, 3).join(',')}…] <title> | <body>\` (use \\n for a new line, "- " for bullets)
\`${P}changelog edit <id> <title> | <body>\` · \`${P}changelog tags <id> <tags>\` · \`${P}changelog remove <id>\`
\`${P}changelog publish <${suggestVersion('patch')}|patch|minor|major>\` · \`${P}changelog repost <version>\``;

    try {
      if (sub === 'list') {
        const drafts = listDrafts();
        const hook = webhookSummary();
        const lines = drafts.map(d => `**#${d.id} ${d.title}**${d.tags.length ? ` · ${d.tags.join(', ')}` : ''}${d.source === 'deploy' ? ' · from a deploy' : d.source?.startsWith('day:') ? ` · ${d.source.slice(4)}` : ''}`);
        const last = latestRelease();
        return reply(Embed.info(
          `${lines.length ? fitLines(lines) : 'No drafts waiting.'}\n\n${last ? `Last release: **v${last.version}** (build ${last.build})` : 'Nothing published yet.'}` +
          `\nWebhook: ${hook.configured ? `set (${hook.hint})` : 'not set, releases will only appear on the website'}\n\n${help}`,
          '📝 Changelog drafts'));
      }

      if (sub === 'add') {
        let rest = args.slice(1);
        const tags = looksLikeTags(rest[0]) ? rest.shift().split(',') : [];
        const { title, body } = splitTitle(rest.join(' '));
        const e = addDraft({ title, body, tags }, by);
        return reply(Embed.success(`Draft **#${e.id}** added.`, 'Changelog'));
      }

      if (sub === 'edit') {
        const { title, body } = splitTitle(args.slice(2).join(' '));
        const e = editDraft(args[1], { title, body });
        return reply(Embed.success(`Draft **#${e.id}** updated.`, 'Changelog'));
      }

      if (sub === 'tags') {
        const e = editDraft(args[1], { tags: args[2] ?? '' });
        return reply(Embed.success(`Draft **#${e.id}** tags: ${e.tags.join(', ') || 'none'}.`, 'Changelog'));
      }

      if (sub === 'remove' || sub === 'delete') {
        deleteDraft(args[1]);
        return reply(Embed.success(`Draft **#${args[1]}** removed.`, 'Changelog'));
      }

      if (sub === 'publish') {
        const want = (args[1] ?? '').toLowerCase();
        const version = ['patch', 'minor', 'major'].includes(want) ? suggestVersion(want) : want;
        const release = publish({ version }, by);
        const post = await postRelease(release.id);
        const where = post.status === 'posted' ? 'Posted to the changelog channel.' : post.status === 'skipped' ? 'No webhook is set, so it is only on the website.' : `The Fluxer post failed (${post.error}). Retry with \`${P}changelog repost ${release.version}\`.`;
        return reply(Embed.success(`**v${release.version}** (build ${release.build}) is live with ${release.entries.length} entr${release.entries.length === 1 ? 'y' : 'ies'}.\n${where}\n${release.url}`, 'Published'));
      }

      if (sub === 'repost') {
        const r = listReleases({ limit: 50 }).find(x => x.version === String(args[1] ?? '').replace(/^v/, ''));
        if (!r) return reply(Embed.warning(`No release called \`${args[1] ?? ''}\`.`));
        const post = await postRelease(r.id);
        return reply(post.ok ? Embed.success(`v${r.version} posted again.`, 'Changelog') : Embed.warning(`Not posted: ${post.error ?? 'no webhook is set'}.`));
      }

      if (sub === 'latest') {
        const r = latestRelease();
        if (!r) return reply(Embed.info('Nothing published yet.'));
        return reply(Embed.info(fitLines(r.entries.map(e => `**${e.title}**\n${e.body}`), { sep: '\n\n' }), `v${r.version} · build ${r.build}`));
      }

      return reply(Embed.info(help, 'Changelog'));
    } catch (e) {
      return reply(Embed.warning(e.status ? e.message : `Something went wrong: ${e.message}`));
    }
  },
};
