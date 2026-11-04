import { openMysql } from './mysql.js';
import { openSqlite, sqliteSchema } from './sqlite.js';
import { dbConfigFromEnv } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MYSQL_SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', 'schema.sql');

// Opens MySQL when DATABASE_URL is set. SQLite is only used when explicitly requested (tests).
export async function openDatabase({ env = process.env, engine } = {}) {
  if (engine === 'sqlite') return openSqlite(':memory:');
  const cfg = dbConfigFromEnv(env);
  if (!cfg) throw new Error('DATABASE_URL is not set. NESTORA stores all data in MySQL - see .env.example and deployment.md.');
  return openMysql(cfg);
}

// Splits the schema into statements and applies them. Idempotent (CREATE TABLE IF NOT EXISTS,
// and indexes are skipped when they already exist).
export async function applySchema(db) {
  const raw = db.engine === 'sqlite' ? sqliteSchema() : fs.readFileSync(MYSQL_SCHEMA, 'utf8');
  const stmts = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
  for (const s of stmts) {
    try { await db.exec(s); }
    catch (e) { if (/duplicate key name|already exists/i.test(e.message) && /^CREATE INDEX/i.test(s)) continue; throw e; }
  }
  const seen = await db.query('SELECT version FROM schema_migrations WHERE version = ?', ['001_initial']);
  if (!seen.length) await db.query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', ['001_initial', new Date().toISOString().slice(0, 23).replace('T', ' ')]);
}

export const isDuplicateError = (e) => e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062 || /UNIQUE constraint failed/i.test(e.message || ''));
