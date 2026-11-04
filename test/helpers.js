// Test harness. By default every test file gets its own in-memory SQLite database that is built from the very
// same database/schema.sql as production MySQL. Set TEST_DATABASE_URL (+ TEST_DB_USERNAME / TEST_DB_PASSWORD) to run the
// identical suite against a real MySQL server: the tables are wiped and re-seeded before each context.
import { openDatabase, applySchema } from '../server/db/index.js';
import { initDatabase, wipeAll } from '../server/db/bootstrap.js';
import { createRepos } from '../server/repos/index.js';
import { createApp } from '../server/app.js';

export const FIXED_NOW = new Date('2026-11-03T10:00:00Z');
const NO_LIMITS = { api: 1e9, auth: 1e9, complaints: 1e9, publicForm: 1e9 };

export async function makeCtx(now = FIXED_NOW) {
  const ctx = { now };
  ctx.clock = () => ctx.now;
  ctx.today = () => ctx.now.toISOString().slice(0, 10);
  ctx.setNow = (d) => { ctx.now = d; };
  if (process.env.TEST_DATABASE_URL) {
    ctx.db = await openDatabase({ env: { DATABASE_URL: process.env.TEST_DATABASE_URL, DB_USERNAME: process.env.TEST_DB_USERNAME, DB_PASSWORD: process.env.TEST_DB_PASSWORD } });
    await applySchema(ctx.db); await wipeAll(ctx.db);
  } else ctx.db = await openDatabase({ engine: 'sqlite' });
  await initDatabase(ctx.db, { now });
  ctx.r = createRepos(ctx.db, ctx.clock);
  ctx.user = (phone) => ctx.r.core.userByPhone(phone);
  ctx.close = () => ctx.db.close();
  return ctx;
}

export async function startApp(ctx, opts = {}) {
  const { server } = createApp({ db: ctx.db, secret: 'test-secret', clock: ctx.clock, limits: NO_LIMITS, ...opts });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body, raw } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: raw ? text : (text ? JSON.parse(text) : null), headers: res.headers };
  };
  const login = async (phone) => { await call('POST', '/api/auth/request-otp', { body: { phone } }); const r = await call('POST', '/api/auth/verify-otp', { body: { phone, otp: '123456' } }); return r.body.token; };
  return { server, call, login, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// Convenience for API tests: a fresh database + running app; close() tears both down.
export async function setupApi(opts) {
  const ctx = await makeCtx(); const app = await startApp(ctx, opts);
  return { ctx, ...app, close: async () => { await app.close(); await ctx.close(); } };
}
