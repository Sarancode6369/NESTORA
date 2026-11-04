import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMonthlyBill, computeLateFee, generateBills, applyLateFees, postPayment, statement } from '../server/billing.js';
import { processBankCsv } from '../server/matching.js';
import { makeCtx } from './helpers.js';

test('monthly bill = area x 6.50 (brief sample data)', () => {
  assert.equal(computeMonthlyBill(1150, 6.5), 7475);
  assert.equal(computeMonthlyBill(980, 6.5), 6370);
  assert.equal(computeMonthlyBill(1640, 6.5), 10660);
});
test('invalid area or rate is rejected', () => {
  assert.throws(() => computeMonthlyBill(0, 6.5));
  assert.throws(() => computeMonthlyBill(1000, -1));
  assert.throws(() => computeMonthlyBill(NaN, 6.5));
});
test('late fee is zero unless configured (nothing invented)', () => {
  assert.equal(computeLateFee(6370, 47, { mode: 'none' }), 0);
  assert.equal(computeLateFee(6370, 47, undefined), 0);
});
test('late fee modes follow configuration and grace days', () => {
  assert.equal(computeLateFee(1000, 10, { mode: 'flat', graceDays: 15, value: 100 }), 0);
  assert.equal(computeLateFee(1000, 20, { mode: 'flat', graceDays: 15, value: 100 }), 100);
  assert.equal(computeLateFee(10000, 45, { mode: 'percent_per_month', graceDays: 0, value: 1 }), 200); // 2 started months
  assert.equal(computeLateFee(10000, 73, { mode: 'percent_per_annum', graceDays: 0, value: 18 }), 360);
  assert.throws(() => computeLateFee(100, 50, { mode: 'bogus' }));
});
test('statement reproduces brief from database rows: T12 47 days overdue unpaid; T21 part paid', async () => {
  const ctx = await makeCtx(); const { r } = ctx; const t = ctx.today();
  const a = await statement(r, 'T12-0408', t); assert.equal(a.outstanding, 6370); assert.equal(a.maxOverdueDays, 47);
  const b = await statement(r, 'T21-1601', t); assert.equal(b.outstanding, 5660); assert.equal(b.maxOverdueDays, 18);
  const c = await statement(r, 'T07-1203', t); assert.equal(c.outstanding, 0); assert.equal(c.maxOverdueDays, 0);
  await ctx.close();
});
test('bill generation persists rows, is idempotent per flat and period', async () => {
  const ctx = await makeCtx(); const { r } = ctx;
  const r1 = await generateBills(r, '2027-01', ctx.today(), await ctx.user('9000000001')); assert.equal(r1.created.length, 5);
  const r2 = await generateBills(r, '2027-01', ctx.today(), await ctx.user('9000000001')); assert.equal(r2.created.length, 0); assert.equal(r2.skipped.length, 5);
  await assert.rejects(generateBills(r, '2027-13', ctx.today()));
  assert.equal((await r.billing.allBills()).filter((b) => b.period === '2027-01').length, 5);
  // the unique (flat, period) constraint holds even if application code is bypassed
  await assert.rejects(ctx.db.query("INSERT INTO maintenance_bills (id, flat_no, bill_period, area_sqft, rate, amount, issue_date, due_date) VALUES ('X1','T07-1203','2027-01',1,1,1,'2027-01-01','2027-01-11')"), /UNIQUE|Duplicate/i);
  await ctx.close();
});
test('late fees apply only when configured, once per bill', async () => {
  const ctx = await makeCtx(); const { r } = ctx; const t = ctx.today();
  assert.equal((await applyLateFees(r, t, null)).posted.length, 0);
  await r.core.setSetting('lateFee.mode', 'flat'); await r.core.setSetting('lateFee.value', 100);
  const first = (await applyLateFees(r, t, null)).posted;
  assert.ok(first.length >= 2 && first.every((e) => e.amount === 100));
  assert.equal((await applyLateFees(r, t, null)).posted.length, 0);
  await ctx.close();
});
test('payment persistence: a posted payment survives and lowers the outstanding balance', async () => {
  const ctx = await makeCtx(); const { r } = ctx;
  const before = (await statement(r, 'T12-0408', ctx.today())).outstanding;
  const e = await postPayment(r, { flatNo: 'T12-0408', amount: 1000, date: ctx.today(), method: 'upi-test', ref: 'PS-90001', actor: await ctx.user('9000000002') });
  assert.match(e.receiptNo, /^RCP-2026-/);
  assert.equal((await statement(r, 'T12-0408', ctx.today())).outstanding, before - 1000);
  const audit = await r.core.recentAudit(5); assert.ok(audit.some((a) => a.action === 'payment.post' && a.detail.receiptNo === e.receiptNo));
  await ctx.close();
});
test('duplicate payment reference is rejected by the database (409), ledger unchanged', async () => {
  const ctx = await makeCtx(); const { r } = ctx;
  await postPayment(r, { flatNo: 'T12-0408', amount: 100, date: ctx.today(), method: 'upi-test', ref: 'UTR-ABC-123' });
  const n = (await r.billing.allLedger()).length;
  await assert.rejects(postPayment(r, { flatNo: 'T21-1601', amount: 100, date: ctx.today(), method: 'upi-test', ref: 'utr abc 123' }), (e) => e.status === 409 && /reference/i.test(e.message)); // normalised: case/space insensitive
  assert.equal((await r.billing.allLedger()).length, n);
  await ctx.close();
});
test('a financial operation is atomic: failure after the first write rolls everything back', async () => {
  const ctx = await makeCtx();
  const n = (await ctx.r.billing.allLedger()).length; const audits = (await ctx.r.core.recentAudit(500)).length;
  await assert.rejects(ctx.db.transaction(async (tx) => {
    const { createRepos } = await import('../server/repos/index.js');
    const rr = createRepos(tx, ctx.clock);
    await postPayment(rr, { flatNo: 'T12-0408', amount: 500, date: ctx.today(), method: 'bank-transfer', ref: 'UTR-ATOMIC-1' });
    await postPayment(rr, { flatNo: 'T12-0408', amount: 500, date: ctx.today(), method: 'bank-transfer', ref: 'UTR-ATOMIC-1' }); // duplicate -> throws
  }), /reference/i);
  assert.equal((await ctx.r.billing.allLedger()).length, n); // first insert rolled back too
  assert.equal((await ctx.r.core.recentAudit(500)).length, audits);
  await ctx.close();
});
test('concurrent postings of the same reference: exactly one commits', async () => {
  const ctx = await makeCtx();
  const attempt = () => ctx.db.transaction(async (tx) => { const { createRepos } = await import('../server/repos/index.js'); return postPayment(createRepos(tx, ctx.clock), { flatNo: 'T21-1601', amount: 50, date: ctx.today(), method: 'bank-transfer', ref: 'UTR-RACE-9' }); });
  const res = await Promise.allSettled([attempt(), attempt(), attempt()]);
  assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(res.filter((x) => x.status === 'rejected' && x.reason.status === 409).length, 2);
  await ctx.close();
});
test('same bank transaction cannot be posted to a ledger twice', async () => {
  const ctx = await makeCtx(); const { r } = ctx;
  const { txns } = await processBankCsv(r, 'Date,Description,Reference,Credit\n2026-11-03,NST-T12-0408,UTRONCE1,6370\n', 'a.csv', await ctx.user('9000000010'), ctx.today());
  await postPayment(r, { flatNo: 'T12-0408', amount: 100, date: ctx.today(), method: 'bank', ref: 'ONE', txnId: txns[0].id });
  await assert.rejects(postPayment(r, { flatNo: 'T12-0408', amount: 100, date: ctx.today(), method: 'bank', ref: 'TWO', txnId: txns[0].id }), /already been posted/);
  await ctx.close();
});
