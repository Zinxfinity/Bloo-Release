// ─── Optional features ────────────────────────────────────────────────────────
// Bloo ships in two builds from this one folder:
//   live-production     everything, including the economy game
//   release-production  the same bot without the economy; built by
//                       scripts/export-release.mjs, which leaves out
//                       handlers/economy/, commands/economy/ and the other
//                       economy-only files
//
// Code outside the economy never imports it directly. It asks here instead,
// so it keeps working when the economy files aren't there at all. The bot
// and the dashboard both use this module.
//
// The economy is on when its code is present and ECONOMY_ENABLED isn't
// "false" (a live-production server can still switch it off that way).
import { existsSync } from 'fs';

const ECONOMY_CODE = existsSync(new URL('../handlers/economy/economyAdmins.js', import.meta.url));

export function economyEnabled() {
  return ECONOMY_CODE && process.env.ECONOMY_ENABLED !== 'false';
}

// Release state and economy admins, answered "no" when there's no economy.
// Loaded on first use rather than at import time, so importing this module
// never delays anything else (no top-level await).
let admins;
const loadAdmins = () => (admins ??= economyEnabled()
  ? import('../handlers/economy/economyAdmins.js').catch(() => null)
  : Promise.resolve(null));

export async function isEconomyReleased() {
  return (await loadAdmins())?.isEconomyReleased() ?? false;
}
export async function isEconomyAdmin(userId) {
  return (await loadAdmins())?.isEconomyAdmin(userId) ?? false;
}
