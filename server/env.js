// Loads <project root>/.env into process.env (no dependency). Imported first by the entry points
// (server/index.js and scripts/db.js) so `npm start`, `npm run db:init` and `npm run db:seed` all see
// DATABASE_URL, DB_USERNAME, DB_PASSWORD, ... without the shell having to export them.
//   * variables already set in the real environment always win (so CI / production settings are never overridden)
//   * handles Windows CRLF line endings, a UTF-8 BOM, comments, blank lines and optional quotes
//   * never prints values
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, ''); // trailing " # comment" on unquoted values
    out[m[1]] = v;
  }
  return out;
}

/** Returns the names of the variables it set (never the values). */
export function loadEnv(file = ENV_FILE, env = process.env) {
  if (!fs.existsSync(file)) return [];
  const set = [];
  for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) {
    if (env[k] === undefined && v !== '') { env[k] = v; set.push(k); }
  }
  return set;
}

loadEnv();
