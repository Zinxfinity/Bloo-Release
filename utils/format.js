// Shared timestamp/size formatting for status embeds (the bot's own
// lifecycle alerts in handlers/startupAlert.js, and watchdog.js's technical
// reports). Centralized so the wording stays consistent between the two.

export function fullTimestamp(ms) {
  return new Date(ms).toLocaleString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    timeZone: 'UTC',
  }) + ' UTC';
}

// Unix seconds for a <t:...> tag. Some older rows (mod cases, watchlist,
// role persist rules) were saved in milliseconds while today's code saves
// seconds; a millisecond value in a <t:> tag shows a date thousands of years
// away, so anything past year 5000 in seconds is taken as milliseconds.
export function unixSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n > 1e11 ? n / 1000 : n);
}

export function humanizeGap(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60)    return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24)   return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(1)} ${units[i]}`;
}

// Joins lines for an embed description (4096 characters at most) without
// cutting one in half. If they don't all fit, it stops on a whole line and
// says how many were left out.
export function fitLines(lines, { sep = '\n', max = 3900, more = n => `…and ${n} more.` } = {}) {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const next = out ? out + sep + lines[i] : lines[i];
    const tail = i + 1 < lines.length ? sep + more(lines.length - i - 1) : '';
    if (next.length + tail.length > max) return out + (out ? sep : '') + more(lines.length - i);
    out = next;
  }
  return out;
}

// One page of a list. `page` is 1-based and clamped to what exists.
export function paginate(list, page, perPage) {
  const pages = Math.max(1, Math.ceil(list.length / perPage));
  const p = Math.min(pages, Math.max(1, parseInt(page, 10) || 1));
  return { rows: list.slice((p - 1) * perPage, p * perPage), page: p, pages };
}
