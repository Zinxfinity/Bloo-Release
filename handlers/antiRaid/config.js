// ─── Anti-raid config CRUD ──────────────────────────────────────────────────────

import { stmts } from './schema.js';

export function getAntiRaidConfig(guildId) {
  stmts.ensureConfig.run(guildId);
  return stmts.getConfig.get(guildId);
}

export function setAntiRaidField(guildId, field, value) {
  const allowed = ['enabled','mode','verified_role_id','log_channel_id'];
  if (!allowed.includes(field)) throw new Error(`Unknown antiraid field: ${field}`);
  stmts.ensureConfig.run(guildId);
  stmts.setField(field).run(value, guildId);
}
