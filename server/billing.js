// Billing, ledger and late-fee logic. Pure calculations plus repository-backed operations.
// Every function that writes is expected to run inside a database transaction (the HTTP layer wraps all
// non-GET requests in one), so a failed step rolls the whole financial operation back.

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const eq = (a, b) => Math.abs(a - b) < 0.005;

export function computeMonthlyBill(area, rate) {
  if (!Number.isFinite(area) || area <= 0) throw new Error('Flat area must be a positive number');
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Maintenance rate must be a positive number');
  return round2(area * rate);
}

export const LATE_FEE_MODES = ['none', 'flat', 'percent_per_month', 'percent_per_annum'];

// Late fee is entirely driven by configuration (society bye-laws). Nothing is assumed.
//  none               -> 0
//  flat               -> fixed amount once the grace period has passed
//  percent_per_month  -> value% of the unpaid amount per started month after grace
//  percent_per_annum  -> simple interest, value% a year, per day after grace
export function computeLateFee(unpaid, daysOverdue, cfg) {
  if (!cfg || cfg.mode === 'none') return 0;
  if (!LATE_FEE_MODES.includes(cfg.mode)) throw new Error(`Unknown late fee mode: ${cfg.mode}`);
  const days = daysOverdue - (cfg.graceDays || 0);
  if (days <= 0 || unpaid <= 0) return 0;
  const v = Number(cfg.value) || 0;
  switch (cfg.mode) {
    case 'flat': return round2(v);
    case 'percent_per_month': return round2((unpaid * v / 100) * Math.ceil(days / 30));
    case 'percent_per_annum': return round2(unpaid * (v / 100) * (days / 365));
    default: return 0;
  }
}

export const ymd = (d) => new Date(d).toISOString().slice(0, 10);
export function dayDiff(laterYmd, earlierYmd) {
  const a = Date.parse(laterYmd.slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(earlierYmd.slice(0, 10) + 'T00:00:00Z');
  return Math.round((a - b) / 86400000);
}
export function addDays(ymdStr, n) {
  return new Date(Date.parse(ymdStr.slice(0, 10) + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

// Pure statement for one flat from its ledger rows: charges are settled oldest-first by payments.
export function statementFrom(entries, flatNo, today) {
  const charges = entries.filter((e) => e.kind === 'bill' || e.kind === 'late_fee').sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const payments = entries.filter((e) => e.kind === 'payment');
  let remaining = round2(payments.reduce((s, p) => s + p.amount, 0));
  const items = charges.map((c) => {
    const paid = round2(Math.min(remaining, c.amount));
    remaining = round2(remaining - paid);
    const due = round2(c.amount - paid);
    const dueDate = c.dueDate || c.date;
    const daysOverdue = due > 0 && today > dueDate ? dayDiff(today, dueDate) : 0;
    return { entryId: c.id, kind: c.kind, billId: c.billId, period: c.period, amount: c.amount, paid, due, dueDate, daysOverdue, date: c.date };
  });
  const outstanding = round2(items.reduce((s, i) => s + i.due, 0));
  const maxOverdueDays = items.reduce((m, i) => Math.max(m, i.due > 0 ? i.daysOverdue : 0), 0);
  const billed = round2(charges.reduce((s, c) => s + c.amount, 0));
  const paidTotal = round2(payments.reduce((s, p) => s + p.amount, 0));
  return { flatNo, items, outstanding, maxOverdueDays, billed, paidTotal, advanceCredit: remaining, payments };
}
export const groupByFlat = (ledger) => { const m = new Map(); for (const e of ledger) { if (!m.has(e.flatNo)) m.set(e.flatNo, []); m.get(e.flatNo).push(e); } return m; };

export async function statement(r, flatNo, today) { return statementFrom(await r.billing.ledgerForFlat(flatNo), flatNo, today); }
export async function allStatements(r, today) {
  const by = groupByFlat(await r.billing.allLedger());
  return (await r.core.flats()).map((f) => statementFrom(by.get(f.flatNo) || [], f.flatNo, today));
}

export async function generateBills(r, period, today, actor) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('Period must look like 2026-11');
  const cfg = await r.core.getConfig();
  const created = []; const skipped = [];
  for (const flat of await r.core.flats()) {
    if (await r.billing.billExists(flat.flatNo, period)) { skipped.push(flat.flatNo); continue; }
    const amount = computeMonthlyBill(flat.area, cfg.ratePerSqft);
    const issueDate = `${period}-01`;
    const bill = { id: await r.core.nextId('bill', 'BILL-'), flatNo: flat.flatNo, period, area: flat.area, rate: cfg.ratePerSqft, amount, issueDate, dueDate: addDays(issueDate, cfg.dueDays) };
    await r.billing.insertBill(bill);
    await r.billing.insertEntry({ id: await r.core.nextId('ledger', 'L-', 5), flatNo: flat.flatNo, kind: 'bill', date: issueDate, dueDate: bill.dueDate, amount, billId: bill.id, period });
    created.push(bill);
  }
  await r.core.audit(actor || 'system', 'bills.generate', { period, created: created.length, skipped: skipped.length, rate: cfg.ratePerSqft });
  return { created, skipped };
}

// One late-fee charge per overdue bill (idempotent), computed from configuration only.
export async function applyLateFees(r, today, actor) {
  const cfg = (await r.core.getConfig()).lateFee;
  const posted = [];
  if (!cfg || cfg.mode === 'none') return { posted, note: 'Late fee mode is "none" - configure it per society bye-laws first.' };
  const by = groupByFlat(await r.billing.allLedger());
  for (const flat of await r.core.flats()) {
    const st = statementFrom(by.get(flat.flatNo) || [], flat.flatNo, today);
    for (const it of st.items) {
      if (it.kind !== 'bill' || it.due <= 0) continue;
      if (await r.billing.lateFeeExists(it.billId)) continue;
      const fee = computeLateFee(it.due, it.daysOverdue, cfg);
      if (fee <= 0) continue;
      const e = { id: await r.core.nextId('ledger', 'L-', 5), flatNo: flat.flatNo, kind: 'late_fee', date: today, dueDate: today, amount: fee, billId: it.billId, period: it.period, note: `Late fee for ${it.period} (${it.daysOverdue} days overdue, mode ${cfg.mode})` };
      await r.billing.insertEntry(e);
      posted.push(e);
    }
  }
  await r.core.audit(actor || 'system', 'latefee.apply', { count: posted.length, cfg });
  return { posted };
}

// Post a payment to a flat ledger. The payment reference, receipt number and bank transaction are
// unique in the database, so a duplicate can never be committed even under concurrent requests.
export async function postPayment(r, { flatNo, amount, date, method, ref, txnId, actor, note }) {
  if (!(await r.core.flat(flatNo))) throw Object.assign(new Error('Unknown flat'), { status: 404 });
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('Amount must be positive'), { status: 400 });
  const entry = {
    id: await r.core.nextId('ledger', 'L-', 5), flatNo, kind: 'payment', date, amount: round2(amount), method, ref: ref || '',
    receiptNo: await r.core.nextId('receipt', `RCP-${date.slice(0, 4)}-`, 6), txnId: txnId || null, note: note || '',
  };
  await r.billing.insertEntry(entry);
  await r.core.audit(actor || 'system', 'payment.post', { flatNo, amount: entry.amount, method, receiptNo: entry.receiptNo, txnId: txnId || null, ref: ref || null });
  return entry;
}
