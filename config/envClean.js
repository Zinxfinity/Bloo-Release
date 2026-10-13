// ─── Inline comments in .env ──────────────────────────────────────────────────
// The services load .env through systemd's EnvironmentFile, which keeps
// everything after "=", comments included. So a line like
//   FLUXER_API= # Fluxer API base URL override
// gave FLUXER_API the comment as its value, and the dashboard tried to call
// "# Fluxer API base URL override.../guilds/.../roles" (seen live 2026-10-07).
// dotenv strips these, systemd doesn't; this strips them for both.
//
// Imported straight after dotenv in every entry point, before anything reads
// a setting. Only touches Bloo's own settings (the names in .env.example).

const OURS = /^(FLUXER|FLUXERLIST|BOT_|BLOO_|PREFIX|DB_PATH|SESSION_|DASHBOARD_|PANEL_|HCAPTCHA_|OWNER_|ERROR_|STARTUP_|CHANGELOG_|SITE_|TWITTERAPI_|ARCHIVE_ORG_|ECONOMY_|ECO_|INVITE_|REPORT_|DEBUG|WS_|WATCHDOG_|VOTE_|SUGGESTIONS_|FEEDBACK_|BETA_|STATUS_)/;

export const cleaned = [];
for (const [key, value] of Object.entries(process.env)) {
  if (!OURS.test(key) || typeof value !== 'string') continue;
  // A value that is only a comment means "not set"; otherwise drop a
  // trailing " # comment". A real value never contains " #".
  const v = /^\s*#/.test(value) ? '' : value.replace(/\s+#.*$/, '').trim();
  if (v !== value) { process.env[key] = v; cleaned.push(key); }
}
if (cleaned.length) {
  console.warn(`[env] Ignored inline comments in: ${cleaned.join(', ')}. Put comments on their own line in .env.`);
}
