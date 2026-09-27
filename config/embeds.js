import { EmbedBuilder } from '@fluxerjs/core';

// ─── Color palette ────────────────────────────────────────────────────────────
export const COLORS = {
  SUCCESS:  0x4ade80,   // --s1 brand green
  WARNING:  0xfbbf24,   // yellow
  DANGER:   0xf87171,   // red
  INFO:     0x60a5fa,   // blue
  PURPLE:   0xa78bfa,
  MUTED:    0x5a7a5a,
};

// ─── Embed factories ──────────────────────────────────────────────────────────

// Over 200 call sites write `Embed.danger('Heading').setDescription('body')`,
// treating the first argument as a heading. It's really the description, so
// the chained setDescription used to overwrite it and the heading vanished.
// Support that style: if a helper-made embed with no title gets a new
// description, the helper's text becomes the title.
function make(color, description, title) {
  const e = new EmbedBuilder().setColor(color).setDescription(description);
  if (title) { e.setTitle(title); return e; }
  const setDescription = e.setDescription.bind(e);
  const setTitle = e.setTitle.bind(e);
  let pending = description, titled = false;
  e.setTitle = t => { titled = true; return setTitle(t); };
  e.setDescription = d => {
    if (pending && !titled && String(pending).length <= 256) { setTitle(pending); titled = true; }
    pending = null;
    return setDescription(d);
  };
  return e;
}

/**
 * Green success embed.
 * @param {string} description
 * @param {string} [title]
 */
export function success(description, title) {
  return make(COLORS.SUCCESS, description, title);
}

/**
 * Yellow warning embed.
 * @param {string} description
 * @param {string} [title]
 */
export function warning(description, title) {
  return make(COLORS.WARNING, description, title);
}

/**
 * Red danger/error embed.
 * @param {string} description
 * @param {string} [title]
 */
export function danger(description, title) {
  return make(COLORS.DANGER, description, title);
}

/**
 * Blue info embed.
 * @param {string} description
 * @param {string} [title]
 */
export function info(description, title) {
  return make(COLORS.INFO, description, title);
}

/**
 * Red permission-denied embed.
 * @param {string} [reason]
 */
export function denied(reason = 'You do not have permission to use this command.') {
  return new EmbedBuilder()
    .setColor(COLORS.DANGER)
    .setTitle('Access Denied')
    .setDescription(reason);
}

// Named export object for convenience: Embed.success(), Embed.danger(), etc.
export const Embed = { success, warning, danger, info, denied };
export default Embed;
