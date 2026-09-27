// ─── Structured logger ────────────────────────────────────────────────────────
// Thin wrapper that prefixes output with level tags and timestamps.
// Set DEBUG=true in env to enable verbose debug output.

const DEBUG = process.env.DEBUG === 'true';

function timestamp() {
  return new Date().toISOString();
}

export const logger = {
  info(...args)  { console.log( `[${timestamp()}] [INFO] `, ...args); },
  warn(...args)  { console.warn(`[${timestamp()}] [WARN] `, ...args); },
  error(...args) { console.error(`[${timestamp()}] [ERROR]`, ...args); },
  debug(...args) { if (DEBUG) console.log(`[${timestamp()}] [DEBUG]`, ...args); },
};

export default logger;
