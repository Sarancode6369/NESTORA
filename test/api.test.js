import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupApi } from './helpers.js';

const csv = fs.readFileSync(new URL('../samples/bank-statement-sample.csv', import.meta.url), 'utf8');
const setup = () => setupApi();

test('auth: wrong OTP rejected, unknown number rejected, no token rejected', async () => {
  const { call, close } = await setup();
  assert.equal((await call('POST', '/api/auth/request-otp', { body: { phone: '9999999999' } })).status, 404);
  await call('POST', '/api/auth/request-otp', { body: { phone: '9000000001' } });
  assert.equal((await call('POST', '/api/auth/verify-otp', { body: { phone: '9000000001', otp: '000000' } })).status, 401);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', { token: 'a.b.c' })).status, 401);
  const r = await call('POST', '/api/auth/request-otp', { body: { phone: '9000000001' } }); assert.equal(r.body.demo, true);
  await close();
});
test('RBAC: residents cannot see other flats, staff screens or committee data', async () => {
  const { call, login, close } = await setup();
  const tok = await login('9000000001');
  assert.equal((await call('GET', '/api/flats/T07-1203/dashboard', { token: tok })).status, 200);
  assert.equal((await call('GET', '/api/flats/T12-0408/dashboard', { token: tok })).status, 403);
  assert.equal((await call('GET', '/api/flats/T12-0408/ledger', { token: tok })).status, 403);
  assert.equal((await call('POST', '/api/bank/upload', { token: tok, body: { csv } })).status, 403);
  assert.equal((await call('GET', '/api/analytics', { token: tok })).status, 403);
  assert.equal((await call('GET', '/api/complaints', { token: tok })).body.complaints.every((c) => c.flatNo === 'T07-1203'), true);
  assert.equal((await call('GET', '/api/complaints/CMP-0001', { token: tok })).status, 404); // belongs to T12
  await close();
});
test('RBAC: committee cannot upload bank files; guard cannot read ledgers', async () => {
  const { call, login, close } = await setup();
  const com = await login('9000000020'); const guard = await login('9000000030');
  assert.equal((await call('POST', '/api/bank/upload', { token: com, body: { csv } })).status, 403);
  assert.equal((await call('GET', '/api/analytics', { token: com })).status, 200);
  assert.equal((await call('GET', '/api/flats/T07-1203/ledger', { token: guard })).status, 403);
  await close();
});
test('test payment flow: pays the outstanding balance and issues a receipt', async () => {
  const { call, login, close } = await setup();
  const tok = await login('9000000003');
  const co = await call('POST', '/api/payments/checkout', { token: tok, body: {} });
  assert.equal(co.body.amount, 5660); assert.equal(co.body.mode, 'TEST');
  assert.equal((await call('POST', `/api/payments/${co.body.sessionId}/complete`, { token: tok, body: { outcome: 'fail' } })).body.status, 'failed');
  const co2 = await call('POST', '/api/payments/checkout', { token: tok, body: { amount: 1000 } });
  const done = await call('POST', `/api/payments/${co2.body.sessionId}/complete`, { token: tok, body: { method: 'upi' } });
  assert.equal(done.body.status, 'paid'); assert.match(done.body.receipt.receiptNo, /^RCP-/);
  assert.equal((await call('POST', `/api/payments/${co2.body.sessionId}/complete`, { token: tok, body: { method: 'upi' } })).status, 409); // no double completion
  assert.equal((await call('GET', '/api/flats/T21-1601/dashboard', { token: tok })).body.maintenance.outstanding, 4660);
  assert.equal((await call('POST', '/api/payments/checkout', { token: tok, body: { amount: 999999 } })).status, 400);
  await close();
});
test('reconciliation workflow: upload, review queue, approve once, no double posting', async () => {
  const { call, login, close } = await setup();
  const staff = await login('9000000010');
  const up = await call('POST', '/api/bank/upload', { token: staff, body: { csv, filename: 's.csv' } });
  assert.equal(up.status, 200);
  const ledgerBefore = (await call('GET', '/api/flats/T12-0408/ledger', { token: staff })).body.outstanding;
  assert.equal(ledgerBefore, 6370); // upload alone posted nothing
  const matched = up.body.txns.find((t) => t.reference === 'UTR100000001' && t.status === 'matched');
  const ok = await call('POST', `/api/bank/transactions/${matched.id}/approve`, { token: staff, body: {} });
  assert.equal(ok.status, 200);
  assert.equal((await call('POST', `/api/bank/transactions/${matched.id}/approve`, { token: staff, body: {} })).status, 409);
  assert.equal((await call('GET', '/api/flats/T12-0408/ledger', { token: staff })).body.outstanding, 0);
  const dup = up.body.txns.find((t) => t.status === 'duplicate');
  assert.equal((await call('POST', `/api/bank/transactions/${dup.id}/approve`, { token: staff, body: {} })).status, 409);
  const unmatched = up.body.txns.find((t) => t.status === 'unmatched');
  assert.equal((await call('POST', `/api/bank/transactions/${unmatched.id}/approve`, { token: staff, body: {} })).status, 400); // needs a flat chosen
  assert.equal((await call('POST', `/api/bank/transactions/${unmatched.id}/approve`, { token: staff, body: { flatNo: 'T03-0502' } })).status, 200);
  const bad = await call('POST', '/api/bank/upload', { token: staff, body: { csv: 'Date,Foo\n1,2' } });
  assert.equal(bad.status, 400); assert.deepEqual(bad.body.details.missing, ['date', 'description', 'credit'].filter((x) => bad.body.details.missing.includes(x)));
  assert.ok(bad.body.details.missing.includes('credit'));
  await close();
});
test('auto-post only posts exact reference matches and never review-queue items', async () => {
  const { call, login, close, ctx } = await setup();
  const staff = await login('9000000010');
  await call('POST', '/api/bank/upload', { token: staff, body: { csv } });
  const r = await call('POST', '/api/bank/auto-post', { token: staff });
  const all = await ctx.r.bank.txns();
  const posted = all.filter((t) => t.postedReceipt);
  assert.equal(r.body.posted, posted.length); assert.ok(posted.length > 0);
  assert.ok(posted.every((t) => t.status === 'matched'));
  assert.ok(all.filter((t) => t.status !== 'matched').every((t) => !t.postedReceipt));
  await close();
});
test('complaint API: resident raises lift-stuck complaint, escalates; helpdesk changes category', async () => {
  const { call, login, close } = await setup();
  const res = await login('9000000003'); const staff = await login('9000000010');
  const r = await call('POST', '/api/complaints', { token: res, body: { title: 'Lift stuck', description: 'People stuck in lift tower 21', category: 'Cleaning' } });
  assert.equal(r.status, 200); assert.equal(r.body.complaint.urgency, 'Emergency'); assert.equal(r.body.complaint.status, 'escalated');
  assert.equal((await call('PATCH', `/api/complaints/${r.body.complaint.id}/category`, { token: res, body: { category: 'Lift' } })).status, 403);
  const ch = await call('PATCH', `/api/complaints/${r.body.complaint.id}/category`, { token: staff, body: { category: 'Lift' } });
  assert.equal(ch.body.complaint.category, 'Lift');
  assert.equal((await call('POST', '/api/complaints', { token: res, body: { title: 'x', description: 'y' } })).status, 400);
  await close();
});
test('rating only after resolution; reopening works', async () => {
  const { call, login, close } = await setup();
  const res = await login('9000000002'); const staff = await login('9000000010');
  assert.equal((await call('POST', '/api/complaints/CMP-0001/rate', { token: res, body: { rating: 5 } })).status, 409);
  await call('PATCH', '/api/complaints/CMP-0001/status', { token: staff, body: { status: 'resolved' } });
  assert.equal((await call('POST', '/api/complaints/CMP-0001/rate', { token: res, body: { rating: 4 } })).status, 200);
  assert.equal((await call('POST', '/api/complaints/CMP-0001/rate', { token: res, body: { rating: 4 } })).status, 409);
  assert.equal((await call('POST', '/api/complaints/CMP-0001/reopen', { token: res, body: { reason: 'Leak is back' } })).body.complaint.status, 'reopened');
  await close();
});
test('visitors: approval required before entry; offline replay is idempotent; photo purge after 90 days', async () => {
  const { call, login, close, ctx } = await setup();
  const guard = await login('9000000030'); const res = await login('9000000001');
  const photo = 'data:image/jpeg;base64,AAAA';
  const a = await call('POST', '/api/visitors', { token: guard, body: { name: 'Test Guest', phone: '9876543210', flatNo: 'T07-1203', photo, clientId: 'c-1' } });
  const b = await call('POST', '/api/visitors', { token: guard, body: { name: 'Test Guest', phone: '9876543210', flatNo: 'T07-1203', photo, clientId: 'c-1' } });
  assert.equal(a.body.visitor.id, b.body.visitor.id); assert.equal(b.body.deduplicated, true);
  const id = a.body.visitor.id;
  assert.equal((await call('POST', `/api/visitors/${id}/entry`, { token: guard })).status, 409);
  assert.equal((await call('POST', `/api/visitors/${id}/decision`, { token: await login('9000000002'), body: { decision: 'approve' } })).status, 404); // other flat
  assert.equal((await call('POST', `/api/visitors/${id}/decision`, { token: res, body: { decision: 'approve' } })).status, 200);
  assert.equal((await call('POST', `/api/visitors/${id}/entry`, { token: guard })).body.visitor.status, 'inside');
  assert.equal((await call('POST', `/api/visitors/${id}/exit`, { token: guard })).body.visitor.status, 'exited');
  ctx.setNow(new Date('2027-03-01T10:00:00Z')); // > 90 days later
  const purge = await call('POST', '/api/visitors/purge', { token: await login('9000000010') });
  assert.ok(purge.body.deleted >= 1);
  const stored = await ctx.r.community.visitor(id);
  assert.equal(stored.photo, null); assert.equal(stored.photoDeleted, true); assert.equal(stored.name, 'Test Guest'); // photo erased, visit record kept
  await close();
});
test('pre-approved guest code works once and only on its date', async () => {
  const { call, login, close } = await setup();
  const res = await login('9000000001'); const guard = await login('9000000030');
  const g = await call('POST', '/api/guest-codes', { token: res, body: { guestName: 'Aunt', date: '2026-11-03' } });
  assert.match(g.body.guestCode.code, /^\d{6}$/);
  assert.equal((await call('POST', '/api/guest-codes/redeem', { token: guard, body: { code: g.body.guestCode.code } })).status, 200);
  assert.equal((await call('POST', '/api/guest-codes/redeem', { token: guard, body: { code: g.body.guestCode.code } })).status, 409);
  const future = await call('POST', '/api/guest-codes', { token: res, body: { guestName: 'Uncle', date: '2026-11-20' } });
  assert.equal((await call('POST', '/api/guest-codes/redeem', { token: guard, body: { code: future.body.guestCode.code } })).status, 409);
  await close();
});
test('analytics are computed from records and report exports CSV', async () => {
  const { call, login, close } = await setup();
  const com = await login('9000000020');
  const a = (await call('GET', '/api/analytics', { token: com })).body;
  assert.ok(a.finance.billedTotal > 0 && a.finance.outstanding > 0);
  assert.ok(a.finance.outstanding >= 6370 + 5660); // at least the two sample overdue flats
  const staff = await login('9000000010'); await call('POST', '/api/bank/upload', { token: staff, body: { csv } });
  const a2 = (await call('GET', '/api/analytics', { token: com })).body; assert.ok(a2.reconciliation.total > 0);
  const rep = await call('GET', '/api/reports/monthly.csv', { token: com, raw: true });
  assert.equal(rep.status, 200); assert.match(rep.body, /Outstanding dues/);
  await close();
});
test('amenity booking blocks double booking and past dates', async () => {
  const { call, login, close } = await setup();
  const a = await login('9000000001'); const b = await login('9000000002');
  assert.equal((await call('POST', '/api/bookings', { token: a, body: { amenityId: 'AM-1', date: '2026-11-10', startHour: 10 } })).status, 200);
  assert.equal((await call('POST', '/api/bookings', { token: b, body: { amenityId: 'AM-1', date: '2026-11-10', startHour: 10 } })).status, 409);
  assert.equal((await call('POST', '/api/bookings', { token: b, body: { amenityId: 'AM-1', date: '2026-10-01', startHour: 10 } })).status, 400);
  await close();
});

test('public landing data exposes notices and amenities without sign-in and no personal data', async () => {
  const { call, close } = await setup();
  const n = await call('GET', '/api/public/notices'); const a = await call('GET', '/api/public/amenities');
  assert.equal(n.status, 200); assert.ok(n.body.notices.length > 0); assert.equal(a.status, 200); assert.ok(a.body.amenities.length >= 3);
  assert.ok(n.body.notices.every((x) => !('by' in x)));
  const c = await call('POST', '/api/contact', { body: { name: 'Test', phone: '9876543210', message: 'Hello there' } }); assert.equal(c.status, 200);
  assert.equal((await call('POST', '/api/contact', { body: { name: 'T', message: 'x' } })).status, 400);
  await close();
});
