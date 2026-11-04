// Committee analytics. Every number is computed from ledger / complaint records; nothing is hardcoded.
import { statementFrom, groupByFlat, round2 } from './billing.js';

const pct = (a, b) => (b > 0 ? round2((a / b) * 100) : 0);
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

// Everything below is computed from rows read out of the database (ledger, bills, complaints, bank transactions).
async function snapshot(r) {
  return { flats: await r.core.flats(), ledger: await r.billing.allLedger(), bills: await r.billing.allBills(), complaints: await r.complaints.list(), bankTxns: await r.bank.txns() };
}

export async function analytics(r, today, nowMs, period) {
  const db = await snapshot(r);
  const month = period && /^\d{4}-\d{2}$/.test(period) ? period : today.slice(0, 7);
  // ---- Billing / collections ----
  const billedTotal = round2(db.ledger.filter((e) => e.kind !== 'payment').reduce((s, e) => s + e.amount, 0));
  const collectedTotal = round2(db.ledger.filter((e) => e.kind === 'payment').reduce((s, e) => s + e.amount, 0));
  const byFlat = groupByFlat(db.ledger);
  const statements = db.flats.map((f) => statementFrom(byFlat.get(f.flatNo) || [], f.flatNo, today));
  const outstanding = round2(statements.reduce((s, st) => s + st.outstanding, 0));
  const ageing = { current: { amount: 0, flats: 0 }, d1_30: { amount: 0, flats: 0 }, d31_60: { amount: 0, flats: 0 }, d60plus: { amount: 0, flats: 0 } };
  for (const st of statements) {
    const touched = new Set();
    for (const it of st.items) {
      if (it.due <= 0) continue;
      const k = it.daysOverdue <= 0 ? 'current' : it.daysOverdue <= 30 ? 'd1_30' : it.daysOverdue <= 60 ? 'd31_60' : 'd60plus';
      ageing[k].amount = round2(ageing[k].amount + it.due);
      if (!touched.has(k)) { ageing[k].flats++; touched.add(k); }
    }
  }
  // Monthly series: billed in a period vs. collected (payments dated in that month)
  const months = [...new Set(db.ledger.map((e) => e.date.slice(0, 7)))].sort().slice(-6);
  const monthly = months.map((m) => {
    const billed = round2(db.ledger.filter((e) => e.kind !== 'payment' && e.date.slice(0, 7) === m).reduce((s, e) => s + e.amount, 0));
    const collected = round2(db.ledger.filter((e) => e.kind === 'payment' && e.date.slice(0, 7) === m).reduce((s, e) => s + e.amount, 0));
    return { month: m, billed, collected, pct: pct(collected, billed) };
  });
  // On-time payments: bills fully paid on or before due date (by payment date allocation)
  const monthBills = db.bills.filter((b) => b.period === month);
  const monthBilled = round2(monthBills.reduce((s, b) => s + b.amount, 0));
  const monthCollected = round2(db.ledger.filter((e) => e.kind === 'payment' && e.date.slice(0, 7) === month).reduce((s, e) => s + e.amount, 0));
  // ---- Complaints ----
  const cs = db.complaints;
  const open = cs.filter((c) => c.status !== 'resolved');
  const resolved = cs.filter((c) => c.status === 'resolved' && c.resolvedAt);
  const resHours = resolved.map((c) => (Date.parse(c.resolvedAt) - Date.parse(c.createdAt)) / 3600000);
  const responded = cs.filter((c) => c.firstResponseAt);
  const respMin = responded.map((c) => (Date.parse(c.firstResponseAt) - Date.parse(c.createdAt)) / 60000);
  const reopenedCount = cs.filter((c) => c.reopenCount > 0).length;
  const rated = cs.filter((c) => c.rating);
  const byCategory = {};
  for (const c of cs) {
    const k = (byCategory[c.category] ||= { category: c.category, total: 0, open: 0, resolved: 0, avgResolutionHours: 0, _h: [] });
    k.total++; if (c.status === 'resolved') { k.resolved++; if (c.resolvedAt) k._h.push((Date.parse(c.resolvedAt) - Date.parse(c.createdAt)) / 3600000); } else k.open++;
  }
  const categories = Object.values(byCategory).map(({ _h, ...k }) => ({ ...k, avgResolutionHours: round2(avg(_h)) }));
  const overdueResponse = open.filter((c) => !c.firstResponseAt && Date.parse(c.respondBy) < nowMs).length;
  // ---- Bank reconciliation ----
  const tx = db.bankTxns;
  const posted = tx.filter((t) => t.postedReceipt);
  const rec = {
    total: tx.length, matched: tx.filter((t) => t.status === 'matched').length, partial: tx.filter((t) => t.status === 'partial').length,
    unmatched: tx.filter((t) => t.status === 'unmatched').length, needsReview: tx.filter((t) => t.status === 'needs_review').length, duplicate: tx.filter((t) => t.status === 'duplicate').length,
    posted: posted.length, postedAmount: round2(posted.reduce((s, t) => s + t.amount, 0)),
    pendingReview: tx.filter((t) => !t.postedReceipt && !t.rejected && t.status !== 'duplicate').length,
    exactMatchRate: pct(tx.filter((t) => t.status === 'matched').length, tx.length),
  };
  return {
    period: month, asOf: today,
    finance: { billedTotal, collectedTotal, outstanding, collectionPct: pct(collectedTotal, billedTotal), monthBilled, monthCollected, monthCollectionPct: pct(monthCollected, monthBilled), flatsWithDues: statements.filter((s) => s.outstanding > 0).length, totalFlats: db.flats.length },
    ageing, monthly,
    complaints: {
      total: cs.length, open: open.length, emergency: open.filter((c) => c.urgency === 'Emergency').length, needsReview: open.filter((c) => c.needsReview).length, overdueResponse,
      avgResolutionHours: round2(avg(resHours)), avgFirstResponseMinutes: round2(avg(respMin)),
      reopenedPct: pct(reopenedCount, cs.length), reopened: reopenedCount, avgRating: round2(avg(rated.map((c) => c.rating))), ratedCount: rated.length, categories,
    },
    reconciliation: rec,
    note: db.flats.some((f) => f.demo) || cs.some((c) => c.demo) ? 'Figures are computed from the demo dataset (5 flats). Records marked demo are fictional.' : null,
  };
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export async function monthlyReport(r, today, period, nowMs = Date.now()) {
  const a = await analytics(r, today, nowMs, period);
  const flats = await r.core.flats();
  const byFlat = groupByFlat(await r.billing.allLedger());
  const rows = [['NESTORA monthly report', period], ['Generated for date', today], [],
    ['Finance', 'Value'],
    ['Total billed (all time, INR)', a.finance.billedTotal], ['Total collected (all time, INR)', a.finance.collectedTotal], ['Outstanding dues (INR)', a.finance.outstanding], ['Collection %', a.finance.collectionPct],
    [`Billed in ${period} (INR)`, a.finance.monthBilled], [`Collected in ${period} (INR)`, a.finance.monthCollected], [],
    ['Dues ageing', 'Amount INR', 'Flats'],
    ['Not yet due', a.ageing.current.amount, a.ageing.current.flats], ['1-30 days overdue', a.ageing.d1_30.amount, a.ageing.d1_30.flats], ['31-60 days overdue', a.ageing.d31_60.amount, a.ageing.d31_60.flats], ['60+ days overdue', a.ageing.d60plus.amount, a.ageing.d60plus.flats], [],
    ['Complaints', 'Value'],
    ['Total', a.complaints.total], ['Open', a.complaints.open], ['Average resolution (hours)', a.complaints.avgResolutionHours], ['Average first response (minutes)', a.complaints.avgFirstResponseMinutes], ['Reopened %', a.complaints.reopenedPct], ['Average rating', a.complaints.avgRating], [],
    ['Bank reconciliation', 'Value'],
    ['Transactions imported', a.reconciliation.total], ['Matched', a.reconciliation.matched], ['Partial', a.reconciliation.partial], ['Needs review', a.reconciliation.needsReview], ['Unmatched', a.reconciliation.unmatched], ['Duplicates', a.reconciliation.duplicate], ['Posted to ledgers', a.reconciliation.posted], [],
    ['Flat', 'Billed INR', 'Paid INR', 'Outstanding INR', 'Max days overdue']];
  for (const f of flats) { const st = statementFrom(byFlat.get(f.flatNo) || [], f.flatNo, today); rows.push([f.flatNo, st.billed, st.paidTotal, st.outstanding, st.maxOverdueDays]); }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
