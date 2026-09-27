// Ticket transcript rendering, HTML/CSS render of a closed ticket's message
// log, copied verbatim from dashboard/server.js (self-contained template
// with no external deps beyond plain JS string building).

export function displayCaseId(caseId) {
  if (!caseId) return caseId;
  const m = String(caseId).match(/^\d+-(.+)$/);
  return m ? m[1] : caseId;
}

// options.guildName/guildIconUrl describe the single guild the ticket came
// from (rendered in the server-icon bar and channel header, this transcript
// only ever represents one server, never a multi-server client mockup).
// options.defaultAvatarUrl must be an absolute URL: this HTML is delivered
// standalone (DM'd as a file), so a relative '/assets/...' path, fine for
// the dashboard's own origin, would 404 with no page to resolve against.
function renderTranscriptHTML(ticket, messages, options = {}) {
  const {
    guildName = 'Support Server',
    guildIconUrl = null,
    defaultAvatarUrl = 'https://bloo-bot.xyz/assets/bloo-pfp.png',
  } = options;

  // ticket_cases/ticket_messages store all timestamps as unix seconds
  // (unixepoch()); normalize to ms once here since every date helper below
  // expects ms.
  messages = messages.map(m => ({ ...m, created_at: m.created_at * 1000 }));
  const ticketMs = {
    ...ticket,
    opened_at: ticket?.opened_at ? ticket.opened_at * 1000 : ticket?.opened_at,
    closed_at: ticket?.closed_at ? ticket.closed_at * 1000 : ticket?.closed_at,
  };

  // ── helpers ──────────────────────────────────────────────────────────────
  const _e = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const _fmtDate = ms => new Date(ms).toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  const _fmtTime = ms => new Date(ms).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false});
  const _fmtDay  = ms => new Date(ms).toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});

  function _avUrl(id, hash) {
    if (hash) return `https://fluxerusercontent.com/avatars/${id}/${hash}.webp?size=80`;
    return defaultAvatarUrl;
  }

  function _md(text) {
    if (!text) return '';
    // code blocks first to prevent inner processing
    const codeBlocks = [];
    let s = String(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_,lang,code) => {
      codeBlocks.push({lang:lang||'',code});
      return `\x00CB${codeBlocks.length-1}\x00`;
    });
    // inline code
    const inlineCodes = [];
    s = s.replace(/`([^`\n]+)`/g, (_,c) => { inlineCodes.push(c); return `\x00IC${inlineCodes.length-1}\x00`; });

    // escape HTML
    s = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // markdown
    s = s
      .replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,'<em>$1</em>')
      .replace(/__(.+?)__/g,'<u>$1</u>')
      .replace(/~~(.+?)~~/g,'<s>$1</s>')
      .replace(/\|\|(.+?)\|\|/g,'<span class="spoiler">$1</span>')
      .replace(/^>\s(.+)/gm,'<blockquote>$1</blockquote>')
      .replace(/\n/g,'<br>');

    // mentions & channels
    s = s
      .replace(/&lt;@!?(\d+)&gt;/g,'<span class="mention user-mention">@$1</span>')
      .replace(/&lt;@&amp;(\d+)&gt;/g,'<span class="mention role-mention">@$1</span>')
      .replace(/&lt;#(\d+)&gt;/g,'<span class="mention chan-mention">#$1</span>')
      .replace(/&lt;t:(\d+):?[TtDdFfR]?&gt;/g,(_,ts)=>`<span class="timestamp">${_fmtDate(Number(ts)*1000)}</span>`)
      .replace(/&lt;(a)?:(\w+):(\d+)&gt;/g,'<span class="custom-emoji" title="$2">:$2:</span>');

    // restore code
    s = s.replace(/\x00CB(\d+)\x00/g,(_,i)=>{
      const {lang,code}=codeBlocks[i];
      return `<div class="code-block"><div class="code-lang">${_e(lang)||'code'}</div><pre><code>${_e(code).trimEnd()}</code></pre></div>`;
    });
    s = s.replace(/\x00IC(\d+)\x00/g,(_,i)=>`<code class="inline-code">${_e(inlineCodes[i])}</code>`);
    return s;
  }

  function _renderEmbed(embed) {
    const col = embed.color ? '#'+embed.color.toString(16).padStart(6,'0') : '#4f545c';
    const fields = (embed.fields??[]).map(f=>`
      <div class="e-field${f.inline?' e-inline':''}">
        <div class="e-fname">${_md(f.name)}</div>
        <div class="e-fval">${_md(f.value)}</div>
      </div>`).join('');
    const hasThumb = embed.thumbnail?.url;
    return `<div class="embed" style="--ec:${col}">
      <div class="embed-inner">
        <div class="embed-body">
          ${embed.provider?.name?`<div class="e-provider">${_e(embed.provider.name)}</div>`:''}
          ${embed.author?.name?`<div class="e-author">${embed.author.icon_url?`<img class="e-author-icon" src="${_e(embed.author.icon_url)}" loading="lazy">`:''}${embed.author.url?`<a href="${_e(embed.author.url)}" target="_blank">${_e(embed.author.name)}</a>`:_e(embed.author.name)}</div>`:''}
          ${embed.title?`<div class="e-title">${embed.url?`<a href="${_e(embed.url)}" target="_blank">${_md(embed.title)}</a>`:_md(embed.title)}</div>`:''}
          ${embed.description?`<div class="e-desc">${_md(embed.description)}</div>`:''}
          ${fields?`<div class="e-fields">${fields}</div>`:''}
          ${embed.image?.url?`<img class="e-image" src="${_e(embed.image.url)}" loading="lazy">`:''}
          ${embed.footer?.text||embed.timestamp?`<div class="e-footer">
            ${embed.footer?.icon_url?`<img class="e-footer-icon" src="${_e(embed.footer.icon_url)}" loading="lazy">`:''}
            ${embed.footer?.text?`<span>${_e(embed.footer.text)}</span>`:''}
            ${embed.footer?.text&&embed.timestamp?`<span class="e-sep">•</span>`:''}
            ${embed.timestamp?`<span>${_fmtDate(new Date(embed.timestamp).getTime())}</span>`:''}
          </div>`:''}
        </div>
        ${hasThumb?`<img class="e-thumb" src="${_e(embed.thumbnail.url)}" loading="lazy">`:''}
      </div>
    </div>`;
  }

  // ── build unique participants for member list ─────────────────────────────
  const participants = new Map();
  for (const msg of messages) {
    if (!participants.has(msg.user_id)) {
      participants.set(msg.user_id, {
        userId:   msg.user_id,
        username: msg.display_name ?? msg.username,
        rawname:  msg.username,
        avatar:   msg.avatar_hash,
        isBot:    msg.is_bot,
        msgCount: 0,
      });
    }
    participants.get(msg.user_id).msgCount++;
  }
  const memberList = [...participants.values()].sort((a,b)=>b.msgCount-a.msgCount);

  // ── group messages (same author within 7 min = one group) ─────────────────
  const groups = [];
  let lastDay = null;
  for (const msg of messages) {
    const dayKey = new Date(msg.created_at).toDateString();
    if (dayKey !== lastDay) {
      groups.push({ type: 'divider', label: _fmtDay(msg.created_at) });
      lastDay = dayKey;
    }
    const last = groups.length ? groups[groups.length-1] : null;
    const prev = last?.type === 'group' ? last : null;
    if (prev && prev.userId===msg.user_id && (msg.created_at - prev.lastTs) < 7*60*1000) {
      prev.messages.push(msg); prev.lastTs = msg.created_at;
    } else {
      groups.push({ type:'group', userId:msg.user_id, username:msg.display_name??msg.username, avatarHash:msg.avatar_hash, isBot:msg.is_bot, firstTs:msg.created_at, lastTs:msg.created_at, messages:[msg] });
    }
  }

  const msgRowsHTML = groups.map(g => {
    if (g.type === 'divider') return `<div class="day-divider"><span>${_e(g.label)}</span></div>`;

    const av  = _avUrl(g.userId, g.avatarHash);
    const rows = g.messages.map(msg => {
      const embeds = (() => { try { return JSON.parse(msg.embeds??'[]'); } catch { return []; } })();
      const atts   = (() => { try { return JSON.parse(msg.attachments??'[]'); } catch { return []; } })();
      const attHTML = atts.map(a => {
        const isImg = /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(a.url??a.name??'');
        return isImg
          ? `<div class="att-wrap"><img class="att-img" src="${_e(a.url)}" loading="lazy" alt="${_e(a.name??'image')}" onclick="this.classList.toggle('zoomed')"></div>`
          : `<div class="att-file"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><polyline points="14 2 14 8 20 8"/></svg><a href="${_e(a.url)}" target="_blank">${_e(a.name??'file')}</a>${a.size?`<span class="att-size">${(a.size/1024).toFixed(1)} KB</span>`:''}</div>`;
      }).join('');
      return `<div class="msg-row" id="m${msg.message_id}">
        <span class="hover-ts">${_fmtTime(msg.created_at)}</span>
        <div class="msg-text">
          ${msg.content ? `<div class="msg-content">${_md(msg.content)}</div>` : ''}
          ${embeds.map(_renderEmbed).join('')}
          ${attHTML}
        </div>
      </div>`;
    }).join('');

    return `<div class="msg-group" data-uid="${_e(g.userId)}">
      <div class="av-col">
        <img class="avatar" src="${av}" alt="${_e(g.username)}" loading="lazy"
          onerror="this.src='${defaultAvatarUrl}'">
      </div>
      <div class="msg-col">
        <div class="msg-header">
          <span class="author-name${g.isBot?' is-bot':''}">${_e(g.username)}</span>
          ${g.isBot?'<span class="bot-badge">APP</span>':''}
          <span class="msg-ts">${_fmtDate(g.firstTs)}</span>
        </div>
        ${rows}
      </div>
    </div>`;
  }).join('');

  // ── member sidebar HTML ───────────────────────────────────────────────────
  const memberListHTML = memberList.map(m => `
    <div class="member-row" title="${_e(m.rawname)} · ${m.msgCount} msg${m.msgCount!==1?'s':''}">
      <div class="member-av-wrap">
        <img class="member-av" src="${_avUrl(m.userId,m.avatar)}" loading="lazy"
          onerror="this.src='${defaultAvatarUrl}'">
        <span class="member-status online"></span>
      </div>
      <div class="member-info">
        <div class="member-name${m.isBot?' is-bot':''}">${_e(m.username)}</div>
        ${m.isBot?'<div class="member-sub bot-sub">Bot</div>':`<div class="member-sub">${m.msgCount} msg${m.msgCount!==1?'s':''}</div>`}
      </div>
      ${m.isBot?'<span class="bot-badge sm">APP</span>':''}
    </div>`).join('');

  // ── ticket meta ───────────────────────────────────────────────────────────
  const caseId     = ticket?.case_id      ?? '—';
  const caseIdDisplay = displayCaseId(caseId);
  const category = ticket?.option_label ?? 'General Support';
  const opener   = ticket?.username     ?? 'Unknown';
  const openerId = ticket?.user_id      ?? '';
  const status   = ticket?.status       ?? 'unknown';
  const openedAt = ticketMs?.opened_at  ? _fmtDate(ticketMs.opened_at) : '—';
  const closedAt = ticketMs?.closed_at  ? _fmtDate(ticketMs.closed_at) : null;
  const closeBy  = ticket?.closed_by    ?? null;
  const closeReason = ticket?.close_reason ?? null;
  const msgCount = messages.length;
  const isClosed = status === 'closed';

  const openerAv = openerId ? _avUrl(openerId, participants.get(openerId)?.avatar ?? null) : defaultAvatarUrl;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${_e(caseIdDisplay)}, Ticket Transcript</title>
<style>
/* ═══════════════════════════════════════════════════════════
   Bloo Ticket Transcript
═══════════════════════════════════════════════════════════ */
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap');

:root {
  /* Fluxer UI colours */
  --dc-bg-primary:   #313338;
  --dc-bg-secondary: #2b2d31;
  --dc-bg-tertiary:  #1e1f22;
  --dc-bg-accent:    #232428;
  --dc-bg-hover:     rgba(255,255,255,.06);
  --dc-bg-active:    rgba(255,255,255,.1);
  --dc-bg-embed:     #2b2d31;
  --dc-text-normal:  #dcddde;
  --dc-text-muted:   #949ba4;
  --dc-text-header:  #f2f3f5;
  --dc-text-link:    #00a8fc;
  --dc-border:       rgba(255,255,255,.06);
  --dc-sidebar-w:    240px;
  --dc-members-w:    240px;
  --dc-header-h:     48px;
  --dc-blurple:      #5865f2;
  --dc-green:        #23a55a;
  --dc-red:          #ed4245;
  --dc-yellow:       #f0b132;
  --dc-brand:        #5865f2;
  --dc-mention-bg:   rgba(88,101,242,.15);
  --dc-mention:      #c9cdfb;
  --font: 'Noto Sans', 'gg sans', Whitney, 'Helvetica Neue', sans-serif;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  background: var(--dc-bg-primary);
  color: var(--dc-text-normal);
  font-family: var(--font);
  font-size: 16px;
  line-height: 1.375;
  display: flex;
  overflow: hidden;
}
a { color: var(--dc-text-link); text-decoration: none; }
a:hover { text-decoration: underline; }
img { max-width: 100%; }

/* ── Server sidebar (narrow icon strip) ──────────────── */
.server-bar {
  width: 72px;
  min-width: 72px;
  background: var(--dc-bg-tertiary);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: .75rem 0;
  gap: .5rem;
  overflow-y: auto;
  scrollbar-width: none;
  flex-shrink: 0;
}
.server-bar::-webkit-scrollbar { display: none; }

.server-icon {
  width: 48px; height: 48px; border-radius: 50%;
  background: var(--dc-bg-secondary);
  display: flex; align-items: center; justify-content: center;
  font-size: 1.2rem; cursor: pointer;
  transition: border-radius .15s, background .15s;
  position: relative;
  flex-shrink: 0;
}
.server-icon:hover { border-radius: 33%; background: var(--dc-blurple); }
.server-icon.active {
  border-radius: 33%;
  background: var(--dc-blurple);
}
.server-icon.active::before {
  content: '';
  position: absolute; left: -12px; top: 50%; transform: translateY(-50%);
  width: 4px; height: 70%; background: #fff; border-radius: 0 4px 4px 0;
}
.server-sep {
  width: 32px; height: 2px; background: var(--dc-border);
  border-radius: 1px; margin: .2rem 0; flex-shrink: 0;
}

/* ── Channel sidebar ─────────────────────────────────── */
.channel-bar {
  width: var(--dc-sidebar-w);
  min-width: var(--dc-sidebar-w);
  background: var(--dc-bg-secondary);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
}

.guild-header {
  height: var(--dc-header-h);
  min-height: var(--dc-header-h);
  display: flex; align-items: center;
  padding: 0 1rem;
  font-weight: 700; font-size: .9375rem; color: var(--dc-text-header);
  border-bottom: 1px solid var(--dc-border);
  cursor: pointer;
  flex-shrink: 0;
}
.guild-header:hover { background: var(--dc-bg-hover); }
.guild-chevron { margin-left: auto; opacity: .7; font-size: .75rem; }

.ch-section {
  padding: 1rem .5rem .25rem .75rem;
  font-size: .6875rem; font-weight: 700; letter-spacing: .03em;
  text-transform: uppercase; color: var(--dc-text-muted);
  display: flex; align-items: center; gap: .25rem; cursor: pointer;
}
.ch-section:hover { color: var(--dc-text-normal); }

.ch-list { flex: 1; overflow-y: auto; padding: 0 .5rem .5rem; scrollbar-width: thin; scrollbar-color: var(--dc-bg-tertiary) transparent; }
.ch-list::-webkit-scrollbar { width: 4px; }
.ch-list::-webkit-scrollbar-thumb { background: var(--dc-bg-tertiary); border-radius: 2px; }

.ch-item {
  display: flex; align-items: center; gap: .5rem;
  padding: .3rem .5rem;
  border-radius: 4px;
  font-size: .9375rem; color: var(--dc-text-muted);
  cursor: pointer; margin: 1px 0;
}
.ch-item:hover { background: var(--dc-bg-hover); color: var(--dc-text-normal); }
.ch-item.active {
  background: var(--dc-bg-active);
  color: var(--dc-text-header);
}
.ch-item.active .ch-icon { color: var(--dc-text-header); }
.ch-icon { font-size: .85rem; opacity: .6; flex-shrink: 0; }
.ch-item.active .ch-icon { opacity: 1; }
.ch-badge {
  margin-left: auto;
  background: var(--dc-red);
  color: #fff; font-size: .6rem; font-weight: 700;
  padding: .1rem .3rem; border-radius: 99px;
}

/* user panel at bottom of sidebar */
.user-panel {
  background: var(--dc-bg-tertiary);
  padding: .5rem .5rem;
  display: flex; align-items: center; gap: .5rem;
  flex-shrink: 0;
}
.user-panel-av { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; }
.user-panel-name { font-size: .875rem; font-weight: 600; color: var(--dc-text-header); }
.user-panel-sub  { font-size: .7rem; color: var(--dc-text-muted); }
.user-panel-icons { margin-left: auto; display: flex; gap: .25rem; color: var(--dc-text-muted); font-size: .9rem; }

/* ── Main content area ───────────────────────────────── */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--dc-bg-primary);
}

/* ── Channel header ──────────────────────────────────── */
.ch-header {
  height: var(--dc-header-h);
  min-height: var(--dc-header-h);
  background: var(--dc-bg-primary);
  border-bottom: 1px solid var(--dc-border);
  display: flex; align-items: center;
  padding: 0 1rem;
  gap: .75rem;
  flex-shrink: 0;
  z-index: 5;
}
.ch-header-hash {
  font-size: 1.4rem; color: var(--dc-text-muted); font-weight: 700; flex-shrink: 0;
}
.ch-header-name {
  font-weight: 700; font-size: .9375rem; color: var(--dc-text-header);
  flex-shrink: 0;
}
.ch-header-sep { width: 1px; height: 1.25rem; background: var(--dc-border); flex-shrink: 0; }
.ch-header-topic {
  font-size: .875rem; color: var(--dc-text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ch-header-right {
  margin-left: auto; display: flex; align-items: center; gap: .75rem; flex-shrink: 0;
}
.ch-header-btn {
  color: var(--dc-text-muted); cursor: pointer; font-size: .9rem; padding: .25rem;
  border-radius: 4px; transition: color .1s, background .1s;
}
.ch-header-btn:hover { color: var(--dc-text-header); background: var(--dc-bg-hover); }

/* status pill */
.status-pill {
  display: inline-flex; align-items: center; gap: .3rem;
  padding: .15rem .5rem;
  border-radius: 99px;
  font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
}
.pill-open   { background: rgba(35,165,90,.18);  color: #3ba55c; }
.pill-closed { background: rgba(237,66,69,.18);  color: #ed4245; }
.pill-open::before, .pill-closed::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
}
.pill-open::before   { background: #3ba55c; }
.pill-closed::before { background: #ed4245; }

/* ── Message feed ────────────────────────────────────── */
.messages-wrap {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  padding: 1rem 0 1.5rem;
  scrollbar-width: thin;
  scrollbar-color: var(--dc-bg-tertiary) transparent;
}
.messages-wrap::-webkit-scrollbar { width: 8px; }
.messages-wrap::-webkit-scrollbar-track { background: transparent; }
.messages-wrap::-webkit-scrollbar-thumb { background: var(--dc-bg-tertiary); border-radius: 4px; border: 2px solid var(--dc-bg-primary); }

/* channel intro block */
.ch-intro {
  padding: 1rem 1.125rem 1.5rem;
  border-bottom: 1px solid var(--dc-border);
  margin-bottom: .5rem;
}
.ch-intro-icon {
  width: 68px; height: 68px; border-radius: 50%;
  background: var(--dc-bg-tertiary);
  display: flex; align-items: center; justify-content: center;
  font-size: 2rem; margin-bottom: .75rem;
}
.ch-intro h2 { font-size: 1.5rem; font-weight: 700; color: var(--dc-text-header); margin-bottom: .25rem; }
.ch-intro p  { font-size: .9375rem; color: var(--dc-text-muted); }

/* day divider */
.day-divider {
  display: flex; align-items: center; gap: .75rem;
  margin: 1.25rem 1.125rem .5rem;
  font-size: .75rem; font-weight: 600; color: var(--dc-text-muted);
}
.day-divider::before, .day-divider::after {
  content: ''; flex: 1; height: 1px; background: var(--dc-border);
}

/* message group */
.msg-group {
  display: flex;
  padding: .125rem 1.125rem;
  gap: 1rem;
  border-left: 2px solid transparent;
  transition: background .05s;
}
.msg-group:hover {
  background: var(--dc-bg-hover);
}
.av-col { width: 40px; flex-shrink: 0; padding-top: .1rem; }
.avatar {
  width: 40px; height: 40px; border-radius: 50%;
  object-fit: cover; cursor: pointer;
  transition: opacity .1s;
}
.avatar:hover { opacity: .85; }
.msg-col { flex: 1; min-width: 0; }

.msg-header {
  display: flex; align-items: baseline; gap: .35rem; margin-bottom: .15rem; flex-wrap: wrap;
}
.author-name {
  font-size: .9375rem; font-weight: 600; color: var(--dc-text-header);
  cursor: pointer; line-height: 1.3;
}
.author-name:hover { text-decoration: underline; }
.author-name.is-bot { color: var(--dc-blurple); }
.bot-badge {
  display: inline-flex; align-items: center;
  background: var(--dc-blurple); color: #fff;
  font-size: .6rem; font-weight: 700; letter-spacing: .02em;
  padding: .08rem .28rem; border-radius: 3px;
  text-transform: uppercase;
}
.bot-badge.sm { font-size: .55rem; padding: .05rem .22rem; }
.msg-ts {
  font-size: .73rem; color: var(--dc-text-muted); cursor: default;
}

/* continuation message row */
.msg-row {
  display: flex; gap: 0; align-items: flex-start;
  margin: .05rem 0;
}
.hover-ts {
  width: 40px; /* lines up with avatar width */
  margin-left: -1rem;
  text-align: right;
  font-size: .65rem; color: transparent;
  padding-top: .2rem; padding-right: .5rem;
  flex-shrink: 0; transition: color .1s;
  white-space: nowrap;
}
.msg-row:hover .hover-ts { color: var(--dc-text-muted); }
.msg-text { flex: 1; min-width: 0; padding-top: .05rem; }

.msg-content {
  font-size: .9375rem; color: var(--dc-text-normal);
  word-break: break-word; white-space: pre-wrap; line-height: 1.375;
}
.msg-content br + br { display: none; } /* collapse double newlines */

/* inline code */
.inline-code {
  background: #1e1f22; border-radius: 3px;
  padding: .05em .3em; font-family: 'Consolas','Courier New',monospace;
  font-size: .875em; color: #c9d1d9;
}
/* code blocks */
.code-block {
  background: #1e1f22; border: 1px solid var(--dc-bg-tertiary);
  border-radius: 4px; margin: .3rem 0; overflow: hidden; max-width: 90%;
}
.code-lang {
  background: var(--dc-bg-tertiary); padding: .25rem .75rem;
  font-size: .7rem; color: var(--dc-text-muted); font-family: 'Consolas',monospace;
  text-transform: lowercase;
}
.code-block pre { padding: .75rem 1rem; overflow-x: auto; }
.code-block pre code {
  font-family: 'Consolas','Courier New',monospace;
  font-size: .8125rem; color: #c9d1d9; white-space: pre;
}

/* spoiler */
.spoiler {
  background: #202225; border-radius: 3px; padding: 0 .2rem;
  color: transparent; cursor: pointer; transition: color .15s, background .15s;
}
.spoiler:hover, .spoiler.revealed { background: var(--dc-bg-tertiary); color: var(--dc-text-normal); }

/* blockquote */
blockquote {
  border-left: 4px solid var(--dc-text-muted);
  padding-left: .75rem; margin: .1rem 0;
  color: var(--dc-text-normal);
}

/* mentions */
.mention {
  border-radius: 3px; padding: 0 .2rem;
  font-size: .875em; font-weight: 500; cursor: pointer;
}
.user-mention  { background: var(--dc-mention-bg); color: var(--dc-mention); }
.user-mention:hover  { background: var(--dc-blurple); color: #fff; }
.role-mention  { background: rgba(227,145,232,.15); color: #e391e8; }
.role-mention:hover  { background: #e391e8; color: #fff; }
.chan-mention  { background: rgba(88,101,242,.15); color: var(--dc-mention); }
.chan-mention:hover  { background: var(--dc-blurple); color: #fff; }
.custom-emoji { font-style: normal; }
.timestamp {
  background: var(--dc-bg-secondary); border-radius: 3px;
  padding: 0 .3rem; font-size: .8em; color: var(--dc-text-muted);
  border: 1px solid var(--dc-border);
}

/* ── Embeds ─────────────────────────────────────────── */
.embed {
  --ec: #4f545c;
  background: var(--dc-bg-embed);
  border-left: 4px solid var(--ec);
  border-radius: 4px;
  padding: .6rem .75rem .75rem .7rem;
  margin: .3rem 0;
  max-width: 520px;
  display: grid;
}
.embed-inner { display: flex; gap: .75rem; min-width: 0; }
.embed-body  { flex: 1; min-width: 0; }
.e-provider  { font-size: .73rem; color: var(--dc-text-muted); margin-bottom: .15rem; }
.e-author    { display: flex; align-items: center; gap: .4rem; font-size: .8125rem; font-weight: 600; color: var(--dc-text-header); margin-bottom: .25rem; }
.e-author a  { color: inherit; }
.e-author-icon { width: 20px; height: 20px; border-radius: 50%; }
.e-title     { font-size: .9375rem; font-weight: 700; color: var(--dc-text-header); margin-bottom: .2rem; }
.e-title a   { color: var(--dc-text-link); }
.e-title a:hover { text-decoration: underline; }
.e-desc      { font-size: .875rem; color: var(--dc-text-normal); line-height: 1.4; white-space: pre-wrap; margin-bottom: .15rem; }
.e-fields    { display: flex; flex-wrap: wrap; gap: .35rem .5rem; margin-top: .4rem; }
.e-field     { min-width: 100%; }
.e-inline    { flex: 1 1 120px; max-width: 200px; min-width: unset; }
.e-fname     { font-size: .8125rem; font-weight: 700; color: var(--dc-text-header); margin-bottom: .1rem; }
.e-fval      { font-size: .875rem; color: var(--dc-text-normal); }
.e-image     { max-width: 400px; max-height: 300px; border-radius: 4px; margin-top: .5rem; display: block; }
.e-thumb     { width: 80px; height: 80px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
.e-footer    { display: flex; align-items: center; flex-wrap: wrap; gap: .35rem; font-size: .73rem; color: var(--dc-text-muted); margin-top: .5rem; }
.e-footer-icon { width: 16px; height: 16px; border-radius: 50%; }
.e-sep       { opacity: .5; }

/* ── Attachments ─────────────────────────────────────── */
.att-wrap { margin: .3rem 0; cursor: pointer; }
.att-img {
  max-width: min(400px, 100%); max-height: 300px;
  border-radius: 4px; display: block;
  transition: max-height .2s, max-width .2s;
}
.att-img.zoomed { max-width: 100%; max-height: 80vh; }
.att-file {
  display: inline-flex; align-items: center; gap: .4rem;
  background: var(--dc-bg-secondary); border: 1px solid var(--dc-border);
  border-radius: 4px; padding: .6rem .75rem;
  font-size: .875rem; color: var(--dc-text-normal); margin: .3rem 0;
}
.att-file a { color: var(--dc-text-link); }
.att-file svg { color: var(--dc-text-muted); flex-shrink: 0; }
.att-size { color: var(--dc-text-muted); font-size: .78rem; margin-left: .25rem; }

/* ── Fake message box at bottom ──────────────────────── */
.msg-box-bar {
  padding: 0 1.125rem .875rem;
  flex-shrink: 0;
}
.msg-box {
  background: var(--dc-bg-accent);
  border-radius: 8px;
  padding: .6875rem 1rem;
  display: flex; align-items: center; gap: .5rem;
  color: var(--dc-text-muted); font-size: .9375rem;
  border: none; cursor: not-allowed; width: 100%;
}
.msg-box-icon { font-size: 1.1rem; flex-shrink: 0; }
.msg-box-text { opacity: .5; }
.msg-box-right { margin-left: auto; display: flex; gap: .5rem; color: var(--dc-text-muted); opacity: .5; font-size: 1rem; }

/* ── Members sidebar ─────────────────────────────────── */
.members-bar {
  width: var(--dc-members-w);
  min-width: var(--dc-members-w);
  background: var(--dc-bg-secondary);
  overflow-y: auto; overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--dc-bg-tertiary) transparent;
  flex-shrink: 0;
  padding-top: 1rem;
}
.members-bar::-webkit-scrollbar { width: 4px; }
.members-bar::-webkit-scrollbar-thumb { background: var(--dc-bg-tertiary); border-radius: 2px; }

.members-section-hd {
  padding: .5rem .5rem .25rem .75rem;
  font-size: .6875rem; font-weight: 700; letter-spacing: .03em;
  text-transform: uppercase; color: var(--dc-text-muted);
}
.member-row {
  display: flex; align-items: center; gap: .65rem;
  padding: .35rem .5rem .35rem .75rem;
  border-radius: 4px; margin: 0 .5rem 1px;
  cursor: pointer; transition: background .07s;
}
.member-row:hover { background: var(--dc-bg-hover); }
.member-av-wrap { position: relative; flex-shrink: 0; }
.member-av {
  width: 32px; height: 32px; border-radius: 50%; object-fit: cover;
}
.member-status {
  position: absolute; bottom: -1px; right: -1px;
  width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid var(--dc-bg-secondary);
}
.member-status.online { background: var(--dc-green); }
.member-status.idle   { background: var(--dc-yellow); }
.member-status.offline{ background: #80848e; }
.member-info { flex: 1; min-width: 0; }
.member-name {
  font-size: .875rem; font-weight: 500; color: var(--dc-text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.member-row:hover .member-name { color: var(--dc-text-header); }
.member-name.is-bot { color: #7289da; }
.member-sub {
  font-size: .7rem; color: var(--dc-text-muted); opacity: .7;
}
.bot-sub { color: var(--dc-blurple); opacity: .8; }

/* ── Transcript info panel (replaces fake message input on mobile) */
.info-panel {
  padding: .75rem;
  border-top: 1px solid var(--dc-border);
}
.info-panel-title {
  font-size: .6875rem; font-weight: 700; letter-spacing: .04em;
  text-transform: uppercase; color: var(--dc-text-muted);
  margin-bottom: .5rem; padding: 0 .25rem;
}
.info-row {
  display: flex; flex-direction: column;
  padding: .3rem .25rem; border-radius: 4px;
  margin-bottom: .15rem; cursor: default;
}
.info-row:hover { background: var(--dc-bg-hover); }
.info-key   { font-size: .7rem; color: var(--dc-text-muted); text-transform: uppercase; letter-spacing: .03em; font-weight: 600; }
.info-val   { font-size: .8125rem; color: var(--dc-text-header); font-weight: 500; word-break: break-all; }

/* opener card */
.opener-card {
  display: flex; align-items: center; gap: .5rem;
  padding: .4rem .25rem; margin-bottom: .5rem;
  border-radius: 4px;
}
.opener-card:hover { background: var(--dc-bg-hover); }
.opener-card-av { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
.opener-card-name { font-size: .875rem; font-weight: 600; color: var(--dc-text-header); }
.opener-card-id   { font-size: .7rem; color: var(--dc-text-muted); }

/* ── Responsive hide panels ──────────────────────────── */
@media (max-width: 900px) {
  .server-bar  { display: none; }
  .members-bar { display: none; }
}
@media (max-width: 640px) {
  .channel-bar { display: none; }
}

/* ── Transcript banner ───────────────────────────────── */
.transcript-banner {
  background: var(--dc-bg-tertiary);
  border-bottom: 1px solid var(--dc-border);
  padding: .35rem 1rem;
  font-size: .75rem; color: var(--dc-text-muted);
  display: flex; align-items: center; gap: .5rem;
  flex-shrink: 0;
}
.transcript-banner strong { color: var(--dc-text-normal); }
</style>
</head>
<body>

<!-- ── Server icon bar ── -->
<!-- Only the ticket's own server is shown, this transcript represents one
     server, not a real multi-server client, so no other icons belong here. -->
<nav class="server-bar" aria-label="Servers">
  <div class="server-icon active" title="${_e(guildName)}" style="padding:0">
    <img src="${guildIconUrl ?? defaultAvatarUrl}" alt="${_e(guildName)}"
      style="width:100%;height:100%;border-radius:inherit;object-fit:cover"
      onerror="this.src='${defaultAvatarUrl}'">
  </div>
</nav>

<!-- ── Channel sidebar ── -->
<aside class="channel-bar" aria-label="Channels">
  <div class="guild-header">${_e(guildName)} <span class="guild-chevron">▾</span></div>
  <div class="ch-list">
    <div class="ch-section">▾ &nbsp;Tickets</div>
    <div class="ch-item" style="color:var(--dc-text-muted);padding-left:.75rem;font-size:.82rem">
      <span class="ch-icon">🔒</span> support-archive
    </div>
    <div class="ch-item" style="color:var(--dc-text-muted);padding-left:.75rem;font-size:.82rem">
      <span class="ch-icon">🔒</span> ticket-log
    </div>
    <div class="ch-item active" style="padding-left:.75rem;font-size:.82rem">
      <span class="ch-icon">🎫</span> ${_e(caseIdDisplay)}
      ${isClosed ? '' : '<span class="ch-badge">1</span>'}
    </div>
    <div class="ch-section" style="margin-top:.5rem">▾ &nbsp;Staff</div>
    <div class="ch-item" style="color:var(--dc-text-muted);padding-left:.75rem;font-size:.82rem">
      <span class="ch-icon">📢</span> staff-announcements
    </div>
    <div class="ch-item" style="color:var(--dc-text-muted);padding-left:.75rem;font-size:.82rem">
      <span class="ch-icon">💬</span> staff-chat
    </div>
    <div class="ch-section" style="margin-top:.5rem">▾ &nbsp;General</div>
    <div class="ch-item" style="color:var(--dc-text-muted);padding-left:.75rem;font-size:.82rem">
      <span class="ch-icon">#</span> general
    </div>
    <div class="ch-item" style="color:var(--dc-text-muted);padding-left:.75rem;font-size:.82rem">
      <span class="ch-icon">#</span> off-topic
    </div>
  </div>
  <!-- user panel -->
  <div class="user-panel">
    <img class="user-panel-av" src="${defaultAvatarUrl}" alt="You">
    <div>
      <div class="user-panel-name">Viewer</div>
      <div class="user-panel-sub">Transcript mode</div>
    </div>
    <div class="user-panel-icons">🎙️ 🎧 ⚙️</div>
  </div>
</aside>

<!-- ── Main content ── -->
<main class="main">
  <!-- transcript read-only banner -->
  <div class="transcript-banner">
    📄 This is a <strong>read-only ticket transcript</strong>, ${_e(caseIdDisplay)} · ${msgCount} message${msgCount!==1?'s':''} · Generated ${_fmtDate(Date.now())}
  </div>

  <!-- channel header -->
  <header class="ch-header">
    <span class="ch-header-hash">🎫</span>
    <span class="ch-header-name">${_e(caseIdDisplay)}</span>
    <div class="ch-header-sep"></div>
    <span class="ch-header-topic">${_e(category)} · Opened by ${_e(opener)}</span>
    <div class="ch-header-right">
      <span class="status-pill ${isClosed?'pill-closed':'pill-open'}">${isClosed?'Closed':'Open'}</span>
      <span class="ch-header-btn" title="Members">👥</span>
      <span class="ch-header-btn" title="Search">🔍</span>
      <span class="ch-header-btn" title="Inbox">📥</span>
    </div>
  </header>

  <!-- messages -->
  <div class="messages-wrap" id="msgWrap">
    <!-- channel intro -->
    <div class="ch-intro">
      <div class="ch-intro-icon">🎫</div>
      <h2>#${_e(caseIdDisplay)}</h2>
      <p>This is the start of the <strong>#${_e(caseIdDisplay)}</strong> support ticket, <em>${_e(category)}</em><br>
      Opened by <strong>${_e(opener)}</strong> on ${openedAt}${closedAt ? `. Closed ${closedAt}${closeReason&&closeReason!=='No reason provided'?`, ${_e(closeReason)}`:''}` : '.'}</p>
    </div>

    ${messages.length === 0
      ? `<div style="text-align:center;color:var(--dc-text-muted);padding:3rem 1rem;font-size:.9rem">
          <div style="font-size:3rem;margin-bottom:.75rem">🔇</div>
          No messages were captured for this ticket.<br>
          <span style="font-size:.8rem">The bot may not have been running when this ticket was active.</span>
         </div>`
      : msgRowsHTML}
  </div>

  <!-- fake message box -->
  <div class="msg-box-bar">
    <div class="msg-box">
      <span class="msg-box-icon">➕</span>
      <span class="msg-box-text">This transcript is read-only, #${_e(caseIdDisplay)} ${isClosed?'is closed':'is archived'}</span>
      <div class="msg-box-right">😊 🎁 📷</div>
    </div>
  </div>
</main>

<!-- ── Members sidebar ── -->
<aside class="members-bar" aria-label="Members">
  <div class="members-section-hd">Participants, ${memberList.length}</div>
  ${memberListHTML}

  <!-- ticket info panel -->
  <div class="info-panel">
    <div class="info-panel-title">Ticket Info</div>
    <div class="opener-card">
      <img class="opener-card-av" src="${openerAv}" alt="${_e(opener)}"
        onerror="this.src='${defaultAvatarUrl}'">
      <div>
        <div class="opener-card-name">${_e(opener)}</div>
        <div class="opener-card-id">${openerId ? `ID: ${_e(openerId)}` : 'Ticket opener'}</div>
      </div>
    </div>
    <div class="info-row"><span class="info-key">Case ID</span><span class="info-val">${_e(caseIdDisplay)}</span></div>
    <div class="info-row"><span class="info-key">Category</span><span class="info-val">${_e(category)}</span></div>
    <div class="info-row"><span class="info-key">Status</span><span class="info-val">${_e(status)}</span></div>
    <div class="info-row"><span class="info-key">Opened</span><span class="info-val">${openedAt}</span></div>
    ${closedAt ? `<div class="info-row"><span class="info-key">Closed</span><span class="info-val">${closedAt}</span></div>` : ''}
    ${closeBy  ? `<div class="info-row"><span class="info-key">Closed By</span><span class="info-val">${_e(closeBy)}</span></div>` : ''}
    ${closeReason && closeReason !== 'No reason provided' ? `<div class="info-row"><span class="info-key">Reason</span><span class="info-val">${_e(closeReason)}</span></div>` : ''}
    <div class="info-row"><span class="info-key">Messages</span><span class="info-val">${msgCount}</span></div>
  </div>
</aside>

<script>
// spoiler reveal
document.querySelectorAll('.spoiler').forEach(el => {
  el.addEventListener('click', () => el.classList.toggle('revealed'));
});
// scroll to bottom on load
const wrap = document.getElementById('msgWrap');
if (wrap) wrap.scrollTop = wrap.scrollHeight;
</script>
</body>
</html>`;
}

export { renderTranscriptHTML };
