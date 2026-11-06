import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setupApi } from './helpers.js';
import { verifyToken, signToken } from '../server/app.js';
import { createLimiter } from '../server/ratelimit.js';

const ROLE_PHONES = { resident: '9000000001', helpdesk: '9000000010', committee: '9000000020', guard: '9000000030' };
const csv = 'Date,Description,Reference,Credit\n2026-11-03,x,R1,10\n';
// [method, path, body, roles that must be allowed]
const MATRIX = [
  ['GET', '/api/flats', null, ['helpdesk', 'committee']],
  ['GET', '/api/flats/T07-1203/dashboard', null, ['resident', 'helpdesk']],
  ['PUT', '/api/config', {}, ['helpdesk']],
  ['POST', '/api/bills/generate', { period: '2030-01' }, ['helpdesk']],
  ['POST', '/api/bank/upload', { csv }, ['helpdesk']],
  ['GET', '/api/bank/transactions', null, ['helpdesk']],
  ['POST', '/api/bank/auto-post', {}, ['helpdesk']],
  ['PATCH', '/api/complaints/CMP-0001/category', { category: 'Plumbing' }, ['helpdesk']],
  ['PATCH', '/api/complaints/CMP-0001/priority', { priority: 'High' }, ['helpdesk']],
  ['PATCH', '/api/complaints/CMP-0001/assign', { staffId: 'S-001' }, ['helpdesk']],
  ['GET', '/api/staff', null, ['helpdesk']],
  ['GET', '/api/analytics', null, ['committee', 'helpdesk']],
  ['GET', '/api/audit', null, ['committee', 'helpdesk']],
  ['GET', '/api/notifications', null, ['helpdesk']],
  ['GET', '/api/ai/status', null, ['helpdesk', 'committee']],
  ['POST', '/api/complaints/analyze', { description: 'Water leaking in bathroom ceiling' }, ['resident', 'helpdesk']],
  ['POST', '/api/complaints/duplicates/suggest', { description: 'Water leaking' }, ['resident', 'helpdesk']],
  ['POST', '/api/complaints/CMP-0001/link', { targetId: 'CMP-0002' }, ['helpdesk']],
  ['POST', '/api/chat', { message: 'Hello' }, ['resident']],
  ['POST', '/api/payments/checkout', {}, ['resident']],
  ['POST', '/api/guest-codes', { guestName: 'Guest', date: '2026-11-03' }, ['resident']],
  ['GET', '/api/visitors', null, ['resident', 'helpdesk', 'guard']],
  ['POST', '/api/guest-codes/redeem', { code: '000000' }, ['guard', 'helpdesk']],
  ['POST', '/api/notices', { title: 'T', body: 'B' }, ['helpdesk']],
  ['POST', '/api/demo/reset', {}, ['helpdesk']],
];

test('role-based authorization matrix: every route only admits its declared roles (403 otherwise, 401 anonymous)', async () => {
  const { call, login, close } = await setupApi();
  const tokens = {}; for (const [role, phone] of Object.entries(ROLE_PHONES)) tokens[role] = await login(phone);
  for (const [method, p, body, allowed] of MATRIX) {
    assert.equal((await call(method, p, { body: body || undefined })).status, 401, `anonymous ${method} ${p}`);
    for (const role of Object.keys(ROLE_PHONES)) {
      if (allowed.includes(role)) continue;
      const res = await call(method, p, { token: tokens[role], body: body || undefined });
      assert.equal(res.status, 403, `${role} must be forbidden from ${method} ${p} (got ${res.status})`);
    }
  }
  await close();
});
test('residents cannot read or act on another flat\'s complaints, payments, visitors or bookings', async () => {
  const { call, login, close } = await setupApi();
  const a = await login('9000000001'); const b = await login('9000000002');
  assert.equal((await call('GET', '/api/complaints/CMP-0001', { token: a })).status, 404);
  assert.equal((await call('GET', '/api/complaints/CMP-0001', { token: b })).status, 200);
  assert.equal((await call('POST', '/api/complaints/CMP-0001/reopen', { token: a, body: { reason: 'x' } })).status, 404);
  const co = await call('POST', '/api/payments/checkout', { token: b, body: { amount: 100 } });
  assert.equal((await call('POST', `/api/payments/${co.body.sessionId}/complete`, { token: a, body: { method: 'upi' } })).status, 404);
  assert.equal((await call('GET', '/api/flats/T12-0408/receipts', { token: a })).status, 403);
  await close();
});
test('resident-facing complaint payloads hide AI internals; help desk sees them', async () => {
  const { call, login, close } = await setupApi();
  const res = await login('9000000002'); const desk = await login('9000000010');
  const r = (await call('GET', '/api/complaints/CMP-0001', { token: res })).body.complaint;
  assert.equal(r.reasons, undefined); assert.equal(r.explanation, undefined); assert.equal(r.classificationModel, undefined);
  const d = (await call('GET', '/api/complaints/CMP-0001', { token: desk })).body.complaint;
  assert.ok(Array.isArray(d.reasons)); assert.ok(d.classificationMethod); assert.ok(Array.isArray(d.corrections));
  await close();
});
test('JWT: tampered, expired and wrong-secret tokens are rejected', async () => {
  const { call, close } = await setupApi();
  const good = signToken({ sub: 'U-001' }, 'test-secret');
  assert.equal((await call('GET', '/api/me', { token: good })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: good.slice(0, -2) + 'xx' })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: signToken({ sub: 'U-001' }, 'other-secret') })).status, 401);
  assert.equal(verifyToken(signToken({ sub: 'U-001' }, 'test-secret', -10), 'test-secret'), null);
  assert.equal((await call('GET', '/api/me', { token: signToken({ sub: 'U-999' }, 'test-secret') })).status, 401); // valid signature, unknown user
  await close();
});
test('rate limiting: OTP requests, complaint creation and the global limit answer 429 with Retry-After', async () => {
  const { call, login, close } = await setupApi({ limits: { api: 1e9, auth: 4, complaints: 2, publicForm: 2 } });
  const codes = []; for (let i = 0; i < 6; i++) codes.push((await call('POST', '/api/auth/request-otp', { body: { phone: '9000000001' } })).status);
  assert.deepEqual(codes.slice(0, 4), [200, 200, 200, 200]); assert.equal(codes[5], 429);
  await close();
  const t = await setupApi({ limits: { api: 1e9, auth: 1e9, complaints: 2, publicForm: 2 } });
  const tok = await t.login('9000000001');
  const s = []; for (let i = 0; i < 3; i++) s.push((await t.call('POST', '/api/complaints', { token: tok, body: { title: `Issue ${i}`, description: 'Some description here' } })).status);
  assert.deepEqual(s, [200, 200, 429]);
  const rr = await t.call('POST', '/api/complaints', { token: tok, body: { title: 'Another', description: 'Some description here' } });
  assert.ok(Number(rr.headers.get('retry-after')) >= 1);
  const c = []; for (let i = 0; i < 3; i++) c.push((await t.call('POST', '/api/contact', { body: { name: 'Test', message: 'Hello there' } })).status);
  assert.deepEqual(c, [200, 200, 429]);
  await t.close();
  const g = await setupApi({ limits: { api: 3, auth: 1e9 } });
  const gs = []; for (let i = 0; i < 5; i++) gs.push((await g.call('GET', '/api/health')).status);
  assert.deepEqual(gs, [200, 200, 200, 429, 429]);
  await g.close();
});
test('limiter unit: window slides and keys are independent', () => {
  const l = createLimiter({ windowMs: 1000, max: 2 });
  assert.equal(l.hit('a', 0).ok, true); assert.equal(l.hit('a', 10).ok, true); assert.equal(l.hit('a', 20).ok, false);
  assert.equal(l.hit('b', 20).ok, true); assert.equal(l.hit('a', 1100).ok, true);
});
test('input validation: malformed JSON, oversize fields, bad enums and bad dates are 400 (never 500)', async () => {
  const { call, login, close, server } = await setupApi();
  const tok = await login('9000000001'); const desk = await login('9000000010');
  assert.equal((await call('POST', '/api/complaints', { token: tok, body: { title: 'x'.repeat(500), description: 'valid description' } })).status, 400);
  assert.equal((await call('POST', '/api/complaints', { token: tok, body: { title: 'Valid', description: 'valid description', category: 'Astrology' } })).status, 400);
  assert.equal((await call('POST', '/api/complaints', { token: tok, body: { title: 'Valid', description: 'valid description', priority: 'Urgent' } })).status, 400);
  assert.equal((await call('POST', '/api/complaints/analyze', { token: tok, body: { description: 'hi' } })).status, 400);
  assert.equal((await call('PATCH', '/api/complaints/CMP-0001/category', { token: desk, body: { category: 'Housekeeping' } })).status, 400);
  assert.equal((await call('PATCH', '/api/complaints/CMP-0001/priority', { token: desk, body: { priority: 'Critical' } })).status, 400);
  assert.equal((await call('GET', '/api/amenities?date=not-a-date', { token: tok })).status, 400);
  assert.equal((await call('POST', '/api/bookings', { token: tok, body: { amenityId: 'AM-1', date: '2026/11/10', startHour: 10 } })).status, 400);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/complaints`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: '{not json' });
  assert.equal(res.status, 400);
  assert.equal((await call('POST', '/api/complaints/CMP-0001/../x', { token: tok })).status < 500, true);
  await close();
});
test('SQL injection strings are treated as data (parameterised queries)', async () => {
  const { call, login, close, ctx } = await setupApi();
  const tok = await login('9000000001');
  const evil = "x'); DROP TABLE users;--";
  const r = await call('POST', '/api/complaints', { token: tok, body: { title: evil, description: "Robert'); DROP TABLE complaints;-- leaking tap" } });
  assert.equal(r.status, 200); assert.equal(r.body.complaint.title, evil);
  assert.equal((await ctx.r.core.countUsers()), 9);
  assert.equal((await call('POST', '/api/auth/request-otp', { body: { phone: "9000000001' OR '1'='1" } })).status, 400);
  assert.equal((await call('GET', "/api/complaints?status=open' OR 1=1--", { token: await login('9000000010') })).body.complaints.length, 0);
  await close();
});
test('health endpoint reports the database engine; demo reset can be disabled for production', async () => {
  const { call, login, close } = await setupApi({ allowDemoReset: false });
  const h = await call('GET', '/api/health'); assert.equal(h.status, 200); assert.ok(['mysql', 'sqlite'].includes(h.body.database));
  assert.equal((await call('POST', '/api/demo/reset', { token: await login('9000000010') })).status, 403);
  await close();
});
test('repository hygiene: no real secrets committed, .env ignored, key never referenced in the browser bundle', () => {
  const root = fileURLToPath(new URL('..', import.meta.url)); // not .pathname: that yields /C:/... on Windows
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === 'node_modules' || e.name === '.git' || e.name === 'frames' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = walk(root).filter((f) => /\.(js|json|md|html|css|sql|yml|yaml|example)$/.test(f) || f.endsWith('.env.example'));
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /gsk_[A-Za-z0-9]{20,}/, `Groq-style key in ${f}`);
    assert.doesNotMatch(t, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, `private key in ${f}`);
  }
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.env$/m);
  for (const f of walk(path.join(root, 'public')).filter((x) => /\.(js|html)$/.test(x))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /GROQ_API_KEY|api\.groq\.com/, `AI key/endpoint referenced in browser file ${f}`);
  const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.doesNotMatch(env, /=\s*\S*(gsk_|password123|secret123)/i);
});

test('.env loader: parses CRLF/BOM/quotes/comments, never overrides real environment variables, reports names only', async () => {
  const { parseEnv, loadEnv } = await import('../server/env.js');
  const p = parseEnv('﻿# comment\r\nDATABASE_URL=mysql://localhost:3306/nestora_db\r\nDB_PASSWORD="p@ss word#1"\r\nPORT=3000 # trailing\r\n\r\nexport JWT_SECRET=\'abc\'\r\nBAD LINE\r\n');
  assert.deepEqual(p, { DATABASE_URL: 'mysql://localhost:3306/nestora_db', DB_PASSWORD: 'p@ss word#1', PORT: '3000', JWT_SECRET: 'abc' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nestora-env-'));
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, 'DATABASE_URL=mysql://x:3306/y\r\nDB_USERNAME=fromfile\r\nGROQ_API_KEY=\r\n');
  const env = { DB_USERNAME: 'from-shell' };
  assert.deepEqual(loadEnv(f, env), ['DATABASE_URL']);            // names only; empty values are skipped
  assert.equal(env.DB_USERNAME, 'from-shell');                     // the real environment wins
  assert.equal(env.DATABASE_URL, 'mysql://x:3306/y');
  assert.deepEqual(loadEnv(path.join(dir, 'missing.env'), {}), []); // no file is fine
  fs.rmSync(dir, { recursive: true, force: true });
});
test('database config: .env.example placeholders are rejected with a clear message; MySQL is the only default engine', async () => {
  const { dbConfigFromEnv } = await import('../server/db/config.js');
  const { openDatabase } = await import('../server/db/index.js');
  assert.throws(() => dbConfigFromEnv({ DATABASE_URL: 'mysql://localhost:3306/nestora_db', DB_USERNAME: 'root', DB_PASSWORD: 'your_mysql_password' }), /placeholder/);
  assert.throws(() => dbConfigFromEnv({ DATABASE_URL: 'mysql://localhost:3306/nestora_db', DB_USERNAME: 'your_mysql_username', DB_PASSWORD: 'x' }), /placeholder/);
  const ok = dbConfigFromEnv({ DATABASE_URL: 'mysql://localhost:3306/nestora_db', DB_USERNAME: 'root', DB_PASSWORD: 'real#pass' });
  assert.deepEqual([ok.host, ok.port, ok.database, ok.user], ['localhost', 3306, 'nestora_db', 'root']);
  await assert.rejects(openDatabase({ env: {} }), /DATABASE_URL is not set/); // no silent fallback to SQLite
  const example = parseExample();
  assert.equal(example.DATABASE_URL, 'mysql://localhost:3306/nestora_db');
  assert.doesNotThrow(() => new URL(example.DATABASE_URL));
  for (const k of ['DATABASE_URL', 'DB_USERNAME', 'DB_PASSWORD', 'JWT_SECRET', 'PORT', 'GROQ_API_KEY']) assert.ok(k in example, `${k} missing from .env.example`);
  assert.equal(example.GROQ_API_KEY, '');
});
function parseExample() {
  const text = fs.readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

test('database errors are explained in one actionable line without leaking the password', async () => {
  const { explainDbError } = await import('../server/db/config.js');
  const cfg = { host: 'localhost', port: 3306, database: 'nestora_db', user: 'root', password: 'sup3r-secret' };
  const agg = Object.assign(new Error(''), { errors: [Object.assign(new Error('connect ECONNREFUSED ::1:3306'), { code: 'ECONNREFUSED' })] }); // what mysql2 throws for a stopped server
  assert.match(explainDbError(agg, cfg), /Cannot reach MySQL at localhost:3306.*MySQL80/);
  assert.match(explainDbError(Object.assign(new Error('x'), { code: 'ER_ACCESS_DENIED_ERROR' }), cfg), /DB_USERNAME \/ DB_PASSWORD.*"root"/);
  assert.match(explainDbError(Object.assign(new Error('x'), { code: 'ER_BAD_DB_ERROR' }), cfg), /CREATE DATABASE nestora_db/);
  for (const e of [agg, new Error('boom')]) assert.ok(!explainDbError(e, cfg).includes('sup3r-secret'));
});
