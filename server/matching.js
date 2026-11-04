// Bank statement reconciliation. Matches credits to flats by reference, UPI ID and amount.
// Safety rule: this module never posts anything. It only classifies; a human approves posting.

import crypto from 'node:crypto';
import { parseBankStatement } from '../shared/csv.js';
import { statementFrom, groupByFlat, eq, round2 } from './billing.js';
import { normRef } from './repos/util.js';

export const STATUSES = ['matched', 'partial', 'unmatched', 'needs_review', 'duplicate'];

const FLAT_RE = /T\s?(\d{2})\s?[-_/ ]?\s?(\d{4})/i;
const UPI_RE = /[a-z0-9._-]{2,}@[a-z]{2,}/i;

export function extractFlatNo(text) {
  const m = FLAT_RE.exec(String(text || ''));
  return m ? `T${m[1]}-${m[2]}` : null;
}
export const normUpi = (s) => String(s || '').trim().toLowerCase();
export function extractUpi(...texts) {
  for (const t of texts) {
    const m = UPI_RE.exec(String(t || ''));
    if (m) return normUpi(m[0]);
  }
  return '';
}

export function fingerprint(r) {
  const key = [r.date, r.credit.toFixed(2), String(r.reference).toUpperCase().replace(/[^A-Z0-9]/g, ''), String(r.description).toUpperCase().replace(/\s+/g, ' ').trim()].join('|');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}

// ctx: { flats, workingDue: Map(flatNo -> outstanding), openCharges: Map(flatNo -> [due amounts]), seen:Set }
export function matchRow(row, ctx) {
  const fp = fingerprint(row);
  if (ctx.seen.has(fp)) {
    return { status: 'duplicate', flatNo: null, confidence: 1, reasons: ['Same date, amount, reference and narration was already imported'], fingerprint: fp };
  }
  // A UTR identifies exactly one bank transfer. A second row carrying the same UTR is never live.
  const utr = normRef(row.reference);
  if (utr && ctx.seenUtr?.has(utr)) {
    return { status: 'duplicate', flatNo: null, confidence: 1, reasons: [`UTR ${row.reference} was already imported - duplicate entry blocked`], fingerprint: fp };
  }
  const flatSet = new Set(ctx.flats.map((f) => f.flatNo));
  let refFlat = null;
  const fromRef = extractFlatNo(row.reference) || extractFlatNo(row.description);
  if (fromRef && flatSet.has(fromRef)) refFlat = fromRef;
  if (!refFlat) {
    const refNorm = String(row.reference).toUpperCase();
    const byPaymentRef = ctx.flats.find((f) => f.paymentRef && (refNorm.includes(f.paymentRef.toUpperCase()) || String(row.description).toUpperCase().includes(f.paymentRef.toUpperCase())));
    if (byPaymentRef) refFlat = byPaymentRef.flatNo;
  }
  const upi = normUpi(row.upi) || extractUpi(row.description, row.reference);
  const upiFlatObj = upi ? ctx.flats.find((f) => (f.upiIds || []).map(normUpi).includes(upi)) : null;
  const upiFlat = upiFlatObj ? upiFlatObj.flatNo : null;
  const base = { fingerprint: fp };

  if (!refFlat && !upiFlat) {
    const hint = fromRef && !flatSet.has(fromRef) ? ` (reference mentions ${fromRef}, which is not a known flat)` : '';
    return { ...base, status: 'unmatched', flatNo: null, confidence: 0, reasons: [`No known flat reference or UPI ID found${hint}`] };
  }
  if (refFlat && upiFlat && refFlat !== upiFlat) {
    return { ...base, status: 'needs_review', flatNo: refFlat, confidence: 0.3, suggested: [refFlat, upiFlat], reasons: [`Reference points to ${refFlat} but the UPI ID is registered to ${upiFlat}`] };
  }
  const flatNo = refFlat || upiFlat;
  const reasons = [];
  let score = 0;
  if (refFlat) { score += 0.5; reasons.push(`Payment reference identifies ${flatNo}`); }
  if (upiFlat) { score += 0.3; reasons.push(`UPI ID ${upi} is registered to ${flatNo}`); }

  const due = ctx.workingDue.get(flatNo) ?? 0;
  const singleCharges = ctx.openCharges.get(flatNo) || [];
  if (due <= 0) {
    return { ...base, status: 'needs_review', flatNo, confidence: round2(Math.min(score, 0.4)), reasons: [...reasons, 'Flat has no outstanding dues - possible advance payment or wrong flat'] };
  }
  const exactTotal = eq(row.credit, due);
  const exactOne = !exactTotal && singleCharges.some((c) => eq(c, row.credit));
  if (exactTotal || exactOne) {
    score += 0.3;
    reasons.push(exactTotal ? `Amount equals the outstanding balance (₹${due})` : 'Amount equals one open bill for this flat');
    if (refFlat) {
      ctx.workingDue.set(flatNo, round2(due - row.credit));
      return { ...base, status: 'matched', flatNo, confidence: round2(Math.min(1, score)), reasons };
    }
    return { ...base, status: 'needs_review', flatNo, confidence: round2(Math.min(1, score)), reasons: [...reasons, 'Matched on UPI ID and amount only - no payment reference, so a person must confirm'] };
  }
  if (row.credit < due) {
    ctx.workingDue.set(flatNo, round2(due - row.credit));
    return { ...base, status: 'partial', flatNo, confidence: round2(Math.min(1, score)), reasons: [...reasons, `Amount ₹${row.credit} is less than the outstanding ₹${due} (balance ₹${round2(due - row.credit)})`] };
  }
  return { ...base, status: 'needs_review', flatNo, confidence: round2(Math.min(1, score)), reasons: [...reasons, `Amount ₹${row.credit} is more than the outstanding ₹${due}`] };
}

export async function processBankCsv(r, csvText, filename, actor, today) {
  const parsed = parseBankStatement(csvText);
  if (!parsed.ok) {
    return { ok: false, missing: parsed.missing, error: `Missing required column(s): ${parsed.missing.join(', ')}`, headers: parsed.headers };
  }
  const flats = await r.core.flats();
  const by = groupByFlat(await r.billing.allLedger());
  const workingDue = new Map();
  const openCharges = new Map();
  for (const f of flats) {
    const st = statementFrom(by.get(f.flatNo) || [], f.flatNo, today);
    workingDue.set(f.flatNo, st.outstanding);
    openCharges.set(f.flatNo, st.items.filter((i) => i.due > 0 && i.kind === 'bill').map((i) => i.due));
  }
  const existing = await r.bank.txns();
  const seen = new Set(existing.map((t) => t.fingerprint));
  const seenUtr = new Set(existing.filter((t) => t.status !== 'duplicate').map((t) => normRef(t.reference)).filter(Boolean));
  const ctx = { flats, workingDue, openCharges, seen, seenUtr };
  const file = { id: await r.core.nextId('bankfile', 'BF-', 4), filename: filename || 'statement.csv', uploadedBy: actor?.id, errors: parsed.errors, ignoredDebits: 0, counts: {}, total: 0 };
  await r.bank.insertStatement(file);
  const txns = [];
  for (const row of parsed.rows) {
    if (row.credit <= 0) { file.ignoredDebits += 1; continue; }
    const m = matchRow(row, ctx);
    seen.add(m.fingerprint);
    const u = normRef(row.reference); if (u && m.status !== 'duplicate') seenUtr.add(u);
    const t = { id: await r.core.nextId('banktxn', 'BT-', 5), fileId: file.id, line: row.line, date: row.date, description: row.description, reference: row.reference, upi: row.upi, amount: row.credit, ...m, postedReceipt: null, reviewedBy: null };
    await r.bank.insertTxn(t);
    txns.push(t);
  }
  for (const st of STATUSES) file.counts[st] = txns.filter((t) => t.status === st).length;
  file.total = txns.length;
  await r.bank.updateStatement(file);
  await r.core.audit(actor || 'system', 'bank.upload', { fileId: file.id, filename: file.filename, total: txns.length, counts: file.counts });
  return { ok: true, file, txns };
}
