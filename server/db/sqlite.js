// Test / zero-install engine built on node:sqlite. It executes the SAME database/schema.sql as MySQL
// (only the "ENGINE=InnoDB ..." table suffix is stripped), so schema, constraints and repositories are
// genuinely exercised by the test-suite. Production uses the MySQL adapter (see mysql.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', 'schema.sql');

export function sqliteSchema() {
  return fs.readFileSync(SCHEMA, 'utf8').replace(/\)\s*ENGINE=InnoDB[^;]*;/g, ');');
}

export async function openSqlite(file = ':memory:') {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON');
  let chain = Promise.resolve(); // one connection => serialise transactions
  const run = (sql, params = []) => {
    const stmt = raw.prepare(sql);
    if (/^\s*(select|pragma|with)/i.test(sql)) return stmt.all(...params).map((r) => ({ ...r }));
    const info = stmt.run(...params);
    return { affectedRows: Number(info.changes) };
  };
  const exec = { query: async (sql, params) => run(sql, params) };
  const adapter = {
    engine: 'sqlite',
    ...exec,
    exec: async (sql) => raw.exec(sql),
    async transaction(fn) {
      const prev = chain; let release; chain = new Promise((r) => { release = r; });
      await prev;
      try {
        raw.exec('BEGIN IMMEDIATE');
        try { const out = await fn(exec); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
      } finally { release(); }
    },
    async close() { raw.close(); },
  };
  return adapter;
}
