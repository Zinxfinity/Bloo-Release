// ============================================================
//  commands/debug/eval.js
//  Category : Debug  |  Access 4 (Bot Owner)  |  Gate 2: N/A
//
//  ⚠️  DANGEROUS, evaluates arbitrary JavaScript in the bot process.
//  Uses AsyncFunction instead of eval() so the injected context
//  variables (message, client, db, etc.) are visible to the code.
// ============================================================

import { EmbedBuilder, Routes } from '@fluxerjs/core';
import db                       from '../../db.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function replacer() {
  const seen = new WeakSet();
  return (_, val) => {
    if (typeof val === 'bigint') return val.toString();
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    return val;
  };
}

function serialise(value) {
  if (value === undefined || value === null) return String(value);
  if (typeof value === 'string')  return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value?.toJSON === 'function') return JSON.stringify(value.toJSON(), null, 2);
  try { return JSON.stringify(value, replacer(), 2); } catch { return String(value); }
}

function isSilent(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object') return false;
  return 'id' in value && 'channelId' in value && 'author' in value && 'content' in value;
}

export default {
  name: 'eval',
  aliases: ['ev'],
  description: '⚠️  Evaluate JavaScript in the bot process. Bot owners only, never lower this.',
  usage: '{prefix}eval <code>',
  category: 'debug',

  requiredPermission: 'BOT_OWNER', // Bot Owner
  cooldown: 2,

  async execute({ message, args, client, prefix }) {
    const PREFIX = prefix ?? process.env.PREFIX ?? 'b!';
    const code   = args.join(' ');

    if (!code) {
      await message.reply(`❌ Provide code to evaluate. Usage: \`${PREFIX}eval <code>\``).catch(() => {});
      return;
    }

    let output;
    let errored = false;

    try {
      const fn = new AsyncFunction(
        'message', 'args', 'client', 'prefix',
        'EmbedBuilder', 'Routes', 'db',
        code
      );
      const result = await fn(message, args, client, prefix, EmbedBuilder, Routes, db);
      if (isSilent(result)) return;
      output = serialise(result);
    } catch (err) {
      output  = err.message;
      errored = true;
    }

    await message.reply(
      `\`\`\`${errored ? 'diff' : 'js'}\n${errored ? '- ' : ''}${String(output).slice(0, 1900)}\n\`\`\``
    );
  },
};
