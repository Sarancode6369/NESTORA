import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeCtx } from './helpers.js';
import { applySchema, openDatabase } from '../server/db/index.js';
import { importLegacy } from '../server/db/import.js';
import { importJsonSnapshot, resetDemo, wipeAll, initDatabase } from '../server/db/bootstrap.js';
import { dbConfigFromEnv, safeDescribe } from '../server/db/config.js';
import { createRepos } from '../server/repos/index.js';

test('database connectivity: query round-trip, engine reported, schema migration recorded', async () => {
  const ctx = await makeCtx();
  const [one] = await ctx.db.query('SELECT 1 AS ok'); assert.equal(Number(one.ok), 1);
  assert.ok(['mysql', 'sqlite'].includes(ctx.db.engine));
  const mig = await ctx.db.query('SELECT version FROM schema_migrations'); assert.deepEqual(mig.map((m) => m.version), ['001_initial']);
  await applySchema(ctx.db); // idempotent: running it again changes nothing and does not throw
  assert.equal((await ctx.db.query('SELECT version FROM schema_migrations')).length, 1);
  await ctx.close();
});
test('all expected tables exist with their key indexes and constraints', async () => {
  const ctx = await makeCtx();
  for (const t of ['users', 'roles', 'flats', 'flat_upi_ids', 'staff', 'maintenance_bills', 'flat_ledger', 'payment_sessions', 'bank_statements', 'bank_transactions', 'complaints', 'complaint_history', 'complaint_photos', 'complaint_corrections', 'complaint_ratings', 'visitors', 'guest_codes', 'notices', 'amenities', 'bookings', 'enquiries', 'notifications', 'audit_logs', 'counters', 'app_settings']) {
    await ctx.db.query(`SELECT COUNT(*) AS n FROM ${t}`);
  }
  if (ctx.db.engine === 'sqlite') {
    const idx = (await ctx.db.query("SELECT name FROM sqlite_master WHERE type = 'index'")).map((x) => x.name).join(' ');
    for (const n of ['ix_ledger_flat_date', 'ix_ledger_kind_date', 'ix_cmp_status', 'ix_cmp_category', 'ix_cmp_assignee', 'ix_bt_status', 'ix_bt_fingerprint', 'ix_vis_flat_created', 'ix_audit_created']) assert.match(idx, new RegExp(n));
    assert.ok(idx.split(' ').filter((n) => n.startsWith('sqlite_autoindex')).length >= 20, 'unique constraints are present'); // uniqueness itself is exercised by the duplicate-rejection tests
  }
  await ctx.close();
});
test('seeded sample data matches the client brief exactly (resident, flat, billing, ledger)', async () => {
  const ctx = await makeCtx(); const { r } = ctx;
  const flats = await r.core.flats();
  assert.deepEqual(flats.filter((f) => !f.demo).map((f) => [f.flatNo, f.area]), [['T07-1203', 1150], ['T12-0408', 980], ['T21-1601', 1640]]);
  const bills = await r.billing.allBills();
  const t12 = bills.filter((b) => b.flatNo === 'T12-0408'); assert.ok(t12.length >= 1 && t12.every((b) => b.amount === 6370 && b.area === 980 && b.rate === 6.5));
  assert.ok(bills.every((b) => Math.abs(b.amount - b.area * b.rate) < 0.005));
  const swati = await ctx.user('9000000002'); assert.equal(swati.name, 'Swati Joshi'); assert.equal(swati.relation, 'tenant'); assert.equal(swati.flatNo, 'T12-0408');
  const cmp = await r.complaints.get('CMP-0001'); assert.equal(cmp.title, 'Water leak'); assert.equal(cmp.flatNo, 'T12-0408'); assert.equal(cmp.status, 'assigned');
  assert.ok(cmp.history.length >= 3);
  assert.equal((await r.core.staffList()).length, 9);
  assert.equal((await r.core.getConfig()).ratePerSqft, 6.5);
  await ctx.close();
});
test('resident / billing CRUD persists across independent repository instances', async () => {
  const ctx = await makeCtx();
  const other = createRepos(ctx.db, ctx.clock); // a different "session" over the same database
  await ctx.db.query("INSERT INTO flats (flat_no, tower, area_sqft, payment_ref, is_demo) VALUES ('T28-1001', 28, 1000, 'NST-T28-1001', 1)");
  await ctx.db.query("INSERT INTO users (id, name, phone, role, flat_no, relation, is_demo, created_at) VALUES ('U-900', 'New Resident', '9111111111', 'resident', 'T28-1001', 'owner', 1, '2026-11-03 10:00:00.000')");
  assert.equal((await other.core.userByPhone('9111111111')).name, 'New Resident');
  await ctx.db.query("UPDATE users SET name = 'Renamed Resident' WHERE id = 'U-900'");
  assert.equal((await other.core.userById('U-900')).name, 'Renamed Resident');
  await assert.rejects(ctx.db.query("DELETE FROM flats WHERE flat_no = 'T28-1001'"), /FOREIGN KEY|foreign key/i); // child row blocks deletion
  await ctx.db.query("DELETE FROM users WHERE id = 'U-900'");
  assert.equal(await other.core.userById('U-900'), null);
  await ctx.close();
});
test('constraints: unknown flat, duplicate phone, bad category, bad status are all rejected', async () => {
  const ctx = await makeCtx();
  await assert.rejects(ctx.db.query("INSERT INTO users (id, name, phone, role, flat_no, relation, is_demo, created_at) VALUES ('U-901','x','9222222222','resident','T99-9999','owner',0,'2026-11-03 10:00:00.000')"), /FOREIGN KEY|foreign key/i);
  await assert.rejects(ctx.db.query("INSERT INTO users (id, name, phone, role, flat_no, relation, is_demo, created_at) VALUES ('U-902','dup','9000000001','resident','T07-1203','owner',0,'2026-11-03 10:00:00.000')"), /UNIQUE|Duplicate/i);
  await assert.rejects(ctx.db.query("UPDATE complaints SET category = 'Housekeeping' WHERE id = 'CMP-0001'"), /CHECK|constraint/i);
  await assert.rejects(ctx.db.query("UPDATE complaints SET priority = 'Critical' WHERE id = 'CMP-0001'"), /CHECK|constraint/i);
  await assert.rejects(ctx.db.query("UPDATE complaints SET status = 'deleted' WHERE id = 'CMP-0001'"), /CHECK|constraint/i);
  await assert.rejects(ctx.db.query("UPDATE complaints SET classification_method = 'magic' WHERE id = 'CMP-0001'"), /CHECK|constraint/i);
  await ctx.close();
});
test('database rejects duplicate payment references, receipts and bank transactions', async () => {
  const ctx = await makeCtx();
  const ins = (id, receipt, ref, txn = null) => ctx.db.query("INSERT INTO flat_ledger (id, flat_no, kind, entry_date, amount, receipt_no, payment_ref, bank_txn_id, created_at) VALUES (?, 'T07-1203', 'payment', '2026-11-03', 10, ?, ?, ?, '2026-11-03 10:00:00.000')", [id, receipt, ref, txn]);
  await ins('L-T1', 'RCP-T-1', 'REF1');
  await assert.rejects(ins('L-T2', 'RCP-T-2', 'REF1'), /UNIQUE|Duplicate/i);   // same payment reference
  await assert.rejects(ins('L-T3', 'RCP-T-1', 'REF3'), /UNIQUE|Duplicate/i);   // same receipt number
  await assert.rejects(ctx.db.query("INSERT INTO flat_ledger (id, flat_no, kind, entry_date, amount, created_at) VALUES ('L-T4','T07-1203','payment','2026-11-03',10,'2026-11-03 10:00:00.000')"), /CHECK|constraint/i); // payment needs a receipt
  await assert.rejects(ctx.db.query("INSERT INTO flat_ledger (id, flat_no, kind, entry_date, amount, created_at) VALUES ('L-T5','T07-1203','bill','2026-11-03',-5,'2026-11-03 10:00:00.000')"), /CHECK|constraint/i); // no negative amounts
  await ctx.close();
});
test('transaction rollback leaves no partial rows; commit persists', async () => {
  const ctx = await makeCtx();
  await assert.rejects(ctx.db.transaction(async (tx) => { await tx.query("INSERT INTO notices (id, title, body, posted_at, posted_by) VALUES ('NT-T1','t','b','2026-11-03 10:00:00.000','x')"); throw new Error('boom'); }), /boom/);
  assert.equal((await ctx.db.query("SELECT id FROM notices WHERE id = 'NT-T1'")).length, 0);
  await ctx.db.transaction((tx) => tx.query("INSERT INTO notices (id, title, body, posted_at, posted_by) VALUES ('NT-T2','t','b','2026-11-03 10:00:00.000','x')"));
  assert.equal((await ctx.db.query("SELECT id FROM notices WHERE id = 'NT-T2'")).length, 1);
  await ctx.close();
});
test('ids come from the counters table and never repeat, even for concurrent transactions', async () => {
  const ctx = await makeCtx();
  const ids = await Promise.all(Array.from({ length: 8 }, () => ctx.db.transaction((tx) => createRepos(tx, ctx.clock).core.nextId('notice', 'NT-', 3))));
  assert.equal(new Set(ids).size, 8);
  await ctx.close();
});
test('legacy JSON importer maps the old taxonomy and refuses to merge into a non-empty database', async () => {
  const snapshot = JSON.parse(fs.readFileSync(new URL('../database/fixtures/legacy-sample.json', import.meta.url), 'utf8'));
  assert.ok(snapshot.staff.some((s) => s.team === 'Housekeeping') && snapshot.complaints.some((c) => c.urgency === 'Critical' || c.category === 'Housekeeping'), 'fixture is genuinely legacy');
  const db = await openDatabase({ engine: 'sqlite' });
  const summary = await importJsonSnapshot(db, snapshot);
  assert.deepEqual([summary.flats, summary.users, summary.bills, summary.ledger, summary.complaints, summary.staff], [5, 9, 30, 57, 11, 8]);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM staff WHERE team = 'Housekeeping'"))[0].n, 0);
  assert.ok((await db.query("SELECT COUNT(*) AS n FROM staff WHERE team = 'Cleaning'"))[0].n >= 1);
  await assert.rejects(importJsonSnapshot(db, snapshot), /not empty/);
  // money survives the migration to the paisa
  const [t] = await db.query("SELECT SUM(amount) AS s FROM flat_ledger WHERE kind = 'payment'");
  assert.equal(Math.round(Number(t.s) * 100), Math.round(snapshot.ledger.filter((e) => e.kind === 'payment').reduce((s, e) => s + e.amount, 0) * 100));
  await db.close();
});
test('demo reset wipes and reloads; wipeAll empties every table', async () => {
  const ctx = await makeCtx();
  await ctx.db.query("INSERT INTO notices (id, title, body, posted_at, posted_by) VALUES ('NT-X','t','b','2026-11-03 10:00:00.000','x')");
  await resetDemo(ctx.db, ctx.now);
  assert.equal((await ctx.db.query("SELECT id FROM notices WHERE id = 'NT-X'")).length, 0);
  assert.equal((await ctx.db.query('SELECT COUNT(*) AS n FROM users'))[0].n, 9);
  await wipeAll(ctx.db); assert.equal(Number((await ctx.db.query('SELECT COUNT(*) AS n FROM users'))[0].n), 0);
  await ctx.close();
});
test('JSON files are not the persistence layer: no JSON store module, no DATA_FILE, data lives in the database', async () => {
  assert.equal(fs.existsSync(new URL('../server/store.js', import.meta.url)), false);
  for (const f of ['../server/app.js', '../server/index.js', '../server/db/index.js']) assert.doesNotMatch(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), /DATA_FILE|nestora\.json|writeFileSync\(.*\.json/);
  const ctx = await makeCtx();
  const before = (await ctx.r.core.userByPhone('9000000001')).name;
  assert.equal(before, 'Neeraj Kulkarni'); // read from the database, not a fixture file
  await ctx.close();
});
test('database configuration comes from the environment and never prints the password', () => {
  assert.equal(dbConfigFromEnv({}), null);
  const cfg = dbConfigFromEnv({ DATABASE_URL: 'mysql://db.example.com:3307/nestora', DB_USERNAME: 'app_user', DB_PASSWORD: 's3cret!' });
  assert.deepEqual([cfg.host, cfg.port, cfg.database, cfg.user, cfg.password], ['db.example.com', 3307, 'nestora', 'app_user', 's3cret!']);
  assert.ok(!safeDescribe(cfg).includes('s3cret!'));
  assert.throws(() => dbConfigFromEnv({ DATABASE_URL: 'postgres://x/y' }), /mysql/);
  assert.throws(() => dbConfigFromEnv({ DATABASE_URL: 'not a url' }), /valid URL/);
  const src = fs.readdirSync(new URL('../server/db/', import.meta.url)).map((f) => fs.readFileSync(new URL(`../server/db/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(src, /password\s*[:=]\s*['"][^'"]+['"]/i, 'no hardcoded password');
});
test('opening without DATABASE_URL fails loudly instead of silently using a file', async () => {
  await assert.rejects(openDatabase({ env: {} }), /DATABASE_URL is not set/);
});
