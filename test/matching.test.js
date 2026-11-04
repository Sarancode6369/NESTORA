import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseBankStatement, parseAmount, parseDate, parseCsv } from '../shared/csv.js';
import { processBankCsv } from '../server/matching.js';
import { makeCtx } from './helpers.js';

const sample = fs.readFileSync(new URL('../samples/bank-statement-sample.csv', import.meta.url), 'utf8');
const run = async (ctx, csv = sample) => processBankCsv(ctx.r, csv, 't.csv', await ctx.user('9000000010'), ctx.today());

test('csv parser handles quotes, commas and BOM', () => {
  const rows = parseCsv('﻿a,b\n"x, y","he said ""hi"""\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"']]);
});
test('amount and date parsing', () => {
  assert.equal(parseAmount('₹1,234.50'), 1234.5); assert.equal(parseAmount(''), 0); assert.ok(Number.isNaN(parseAmount('12abc')));
  assert.equal(parseDate('03/11/2026'), '2026-11-03'); assert.equal(parseDate('2026-02-30'), null); assert.equal(parseDate('3-Nov-2026'), '2026-11-03');
});
test('missing required columns are reported', async () => {
  const r = parseBankStatement('Date,Narration\n2026-11-03,x\n');
  assert.equal(r.ok, false); assert.deepEqual(r.missing, ['credit']);
  const s = await makeCtx(); const out = await run(s, 'Date,Narration\n2026-11-03,x\n'); assert.equal(out.ok, false); await s.close();
});
test('bad rows are collected as errors, not thrown', () => {
  const r = parseBankStatement('Date,Description,Credit\nnot-a-date,x,100\n2026-11-03,y,abc\n2026-11-03,ok,100\n');
  assert.equal(r.rows.length, 1); assert.equal(r.errors.length, 2);
});
test('matching outcomes on the sample file', async () => {
  const s = await makeCtx(); const { txns, file } = await run(s);
  const by = (utr, i = 0) => txns.filter((t) => t.reference === utr)[i];
  assert.equal(by('UTR100000001', 0).status, 'matched');
  assert.equal(by('UTR100000001', 0).flatNo, 'T12-0408');
  assert.equal(by('UTR100000002').status, 'matched');       // exact remaining balance 5660
  assert.equal(by('UTR100000001', 1).status, 'duplicate');   // same row repeated
  assert.equal(by('UTR100000004').status, 'partial');        // 2000 vs 5525 due
  assert.equal(by('UTR100000006').status, 'unmatched');
  assert.equal(by('UTR100000007').status, 'needs_review');   // reference T03 but UPI belongs to T12
  assert.equal(by('CHQ554433').status, 'unmatched');         // reference to a flat that does not exist
  assert.equal(file.ignoredDebits, 1);
  await s.close();
});
test('UPI + amount without a reference is NOT auto-matched, goes to review', async () => {
  const s = await makeCtx(); const { txns } = await run(s);
  const t = txns.find((x) => x.reference === 'UTR100000003');
  assert.equal(t.status, 'needs_review'); assert.equal(t.flatNo, 'T03-0502');
  await s.close();
});
test('importing never posts anything to a ledger (rows persisted, ledger untouched)', async () => {
  const s = await makeCtx(); const before = (await s.r.billing.allLedger()).length; await run(s);
  assert.equal((await s.r.billing.allLedger()).length, before);
  const stored = await s.r.bank.txns();
  assert.ok(stored.length > 5 && stored.every((t) => !t.postedReceipt));
  await s.close();
});
test('re-uploading the same file marks every row duplicate', async () => {
  const s = await makeCtx(); await run(s); const { txns } = await run(s);
  assert.ok(txns.length > 0 && txns.every((t) => t.status === 'duplicate'));
  await s.close();
});
test('overpayment goes to review', async () => {
  const s = await makeCtx();
  const { txns } = await run(s, 'Date,Description,Reference,Credit\n2026-11-03,NST-T12-0408,R1,99999\n');
  assert.equal(txns[0].status, 'needs_review');
  await s.close();
});
test('duplicate UTR is blocked even when date, amount and narration differ', async () => {
  const s = await makeCtx();
  await run(s, 'Date,Description,Reference,Credit\n2026-11-03,NST-T12-0408 rent,UTR777000111,6370\n');
  const { txns } = await run(s, 'Date,Description,Reference,Credit\n2026-11-04,"Different narration, same UTR",utr-777000111,6370\n');
  assert.equal(txns[0].status, 'duplicate'); assert.match(txns[0].reasons[0], /UTR/);
  const all = await s.r.bank.txns();
  assert.equal(all.length, 2);
  assert.equal(all.filter((t) => t.status !== 'duplicate').length, 1); // exactly one live row for the UTR
  await s.close();
});
test('database itself refuses a second live row for one UTR (unique utr_key)', async () => {
  const s = await makeCtx(); await run(s, 'Date,Description,Reference,Credit\n2026-11-03,NST-T12-0408,UTR888000222,6370\n');
  const [fileRow] = await s.db.query('SELECT id FROM bank_statements LIMIT 1');
  const insert = () => s.db.query("INSERT INTO bank_transactions (id, statement_id, txn_date, amount, status, fingerprint, utr_key, created_at) VALUES (?, ?, '2026-11-03', 10, 'unmatched', ?, 'UTR888000222', '2026-11-03 10:00:00.000')", ['BT-RAW1', fileRow.id, 'fp-raw-1']);
  await assert.rejects(insert(), /UNIQUE|Duplicate/i);
  await s.close();
});
