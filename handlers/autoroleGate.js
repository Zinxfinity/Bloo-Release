// ─── Auto-role and verification ───────────────────────────────────────────────
// While a server has anti-raid verification on, the auto-role waits until the
// member passes the captcha. Otherwise an auto-role that can see channels
// would let people skip verification entirely. Bots don't verify, so a bot
// auto-role (autorole_bot) is still given on join.
//
// Takes a db handle so the bot process and the dashboard process (web
// captcha completion in dashboard/routes/verify.js) decide the same way on
// their own connections.

// True when the auto-role should be held back at join for this member.
export function autoroleWaitsForVerification(db, guildId, isBot = false) {
  if (isBot) return false;
  try {
    const cfg = db.prepare('SELECT captcha_enabled, verified_role_id FROM antiraid_config WHERE guild_id = ?').get(guildId);
    return !!(cfg?.captcha_enabled && cfg.verified_role_id);
  } catch { return false; }
}

// The auto-role to give once a member is verified, or null when there isn't one.
export function autoroleAfterVerification(db, guildId) {
  try {
    const cfg = db.prepare('SELECT autorole_enabled, autorole_id FROM welcome_config WHERE guild_id = ?').get(guildId);
    return cfg?.autorole_enabled && cfg.autorole_id ? cfg.autorole_id : null;
  } catch { return null; }
}

// Gives the held auto-role through the bot's REST client. Never fails the
// verification itself if the role can't be given (e.g. it's above Bloo's role).
export async function giveHeldAutorole(client, db, guildId, userId) {
  const roleId = autoroleAfterVerification(db, guildId);
  if (!roleId) return;
  try { await client.rest.put(`/guilds/${guildId}/members/${userId}/roles/${roleId}`); }
  catch { /* the member is still verified; a missing auto-role shows up in their roles */ }
}
