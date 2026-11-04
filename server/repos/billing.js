import { toDb, fromDb, ymdOut, jsonOut, jsonIn, bool, num, normRef, isDuplicateError, HttpError } from './util.js';

const billMap = (b) => ({ id: b.id, flatNo: b.flat_no, period: b.bill_period, area: Number(b.area_sqft), rate: Number(b.rate), amount: Number(b.amount), issueDate: ymdOut(b.issue_date), dueDate: ymdOut(b.due_date) });
const entryMap = (e) => ({
  id: e.id, flatNo: e.flat_no, kind: e.kind, date: ymdOut(e.entry_date), dueDate: ymdOut(e.due_date), amount: Number(e.amount), billId: e.bill_id, period: e.bill_period,
  method: e.method, ref: e.reference || '', receiptNo: e.receipt_no, txnId: e.bank_txn_id, note: e.note || '',
});

export function billingRepo(tx, clock) {
  const nowDb = () => toDb(clock());
  return {
    async billsForFlat(flatNo) { return (await tx.query('SELECT * FROM maintenance_bills WHERE flat_no = ? ORDER BY bill_period DESC', [flatNo])).map(billMap); },
    async allBills() { return (await tx.query('SELECT * FROM maintenance_bills ORDER BY bill_period, flat_no')).map(billMap); },
    async billExists(flatNo, period) { return (await tx.query('SELECT id FROM maintenance_bills WHERE flat_no = ? AND bill_period = ?', [flatNo, period])).length > 0; },
    async insertBill(b) {
      await tx.query('INSERT INTO maintenance_bills (id, flat_no, bill_period, area_sqft, rate, amount, issue_date, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [b.id, b.flatNo, b.period, b.area, b.rate, b.amount, b.issueDate, b.dueDate]);
    },
    async ledgerForFlat(flatNo) { return (await tx.query('SELECT * FROM flat_ledger WHERE flat_no = ? ORDER BY entry_date, id', [flatNo])).map(entryMap); },
    async allLedger() { return (await tx.query('SELECT * FROM flat_ledger ORDER BY entry_date, id')).map(entryMap); },
    async lateFeeExists(billId) { return (await tx.query("SELECT id FROM flat_ledger WHERE kind = 'late_fee' AND bill_id = ?", [billId])).length > 0; },
    // Inserts one ledger row. A duplicate payment reference, receipt number or bank transaction is rejected by the database itself.
    async insertEntry(e) {
      try {
        await tx.query(
          'INSERT INTO flat_ledger (id, flat_no, kind, entry_date, due_date, amount, bill_id, bill_period, method, reference, payment_ref, receipt_no, bank_txn_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [e.id, e.flatNo, e.kind, e.date, e.dueDate || null, e.amount, e.billId || null, e.period || null, e.method || null, e.ref || null, e.kind === 'payment' ? normRef(e.ref) : null, e.receiptNo || null, e.txnId || null, e.note || null, nowDb()],
        );
      } catch (err) {
        if (isDuplicateError(err)) {
          if (/bank_txn/i.test(err.message)) throw new HttpError(409, 'This bank transaction has already been posted to a ledger');
          throw new HttpError(409, 'A payment with this reference has already been posted - duplicate reference rejected');
        }
        throw err;
      }
    },
    async sessionInsert(s) {
      await tx.query('INSERT INTO payment_sessions (id, flat_no, user_id, amount, status, mode, receipt_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [s.id, s.flatNo, s.userId, s.amount, s.status, s.mode, s.receiptNo || null, toDb(s.createdAt)]);
    },
    async sessionGet(id) {
      const [s] = await tx.query('SELECT * FROM payment_sessions WHERE id = ?', [id]);
      return s ? { id: s.id, flatNo: s.flat_no, userId: s.user_id, amount: Number(s.amount), status: s.status, mode: s.mode, receiptNo: s.receipt_no, createdAt: fromDb(s.created_at) } : null;
    },
    async sessionUpdate(s) { await tx.query('UPDATE payment_sessions SET status = ?, receipt_no = ? WHERE id = ?', [s.status, s.receiptNo || null, s.id]); },
    // Compare-and-set so two concurrent "complete" calls cannot both succeed.
    async sessionClaim(id, from, to) { const u = await tx.query('UPDATE payment_sessions SET status = ? WHERE id = ? AND status = ?', [to, id, from]); return u.affectedRows === 1; },
  };
}

export function bankRepo(tx, clock) {
  const nowDb = () => toDb(clock());
  const txnMap = (t) => ({
    id: t.id, fileId: t.statement_id, line: t.line_no, date: ymdOut(t.txn_date), description: t.description, reference: t.reference || '', upi: t.upi_id || '', amount: Number(t.amount),
    status: t.status, flatNo: t.flat_no, confidence: Number(t.confidence), reasons: jsonIn(t.reasons, []), suggested: jsonIn(t.suggested, undefined), fingerprint: t.fingerprint,
    postedReceipt: t.posted_receipt, postedFlat: t.posted_flat, rejected: !!t.rejected, rejectReason: t.reject_reason, reviewedBy: t.reviewed_by, reviewedAt: fromDb(t.reviewed_at),
  });
  const fileMap = (f) => ({ id: f.id, filename: f.filename, uploadedAt: fromDb(f.uploaded_at), uploadedBy: f.uploaded_by, total: Number(f.total_rows), ignoredDebits: Number(f.ignored_debits), errors: jsonIn(f.parse_errors, []), counts: jsonIn(f.status_counts, {}) });
  return {
    async fingerprints() { return new Set((await tx.query('SELECT fingerprint FROM bank_transactions')).map((x) => x.fingerprint)); },
    async utrExists(utrKey) { return utrKey ? (await tx.query('SELECT id FROM bank_transactions WHERE utr_key = ?', [utrKey])).length > 0 : false; },
    async insertStatement(f) {
      await tx.query('INSERT INTO bank_statements (id, filename, uploaded_at, uploaded_by, total_rows, ignored_debits, parse_errors, status_counts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [f.id, f.filename.slice(0, 200), nowDb(), f.uploadedBy || null, f.total || 0, f.ignoredDebits || 0, jsonOut(f.errors || []), jsonOut(f.counts || {})]);
    },
    async updateStatement(f) { await tx.query('UPDATE bank_statements SET total_rows = ?, ignored_debits = ?, status_counts = ? WHERE id = ?', [f.total, f.ignoredDebits, jsonOut(f.counts), f.id]); },
    async statements() { return (await tx.query('SELECT * FROM bank_statements ORDER BY uploaded_at, id')).map(fileMap); },
    // utr_key is set only for the canonical (non-duplicate) row, so the database rejects a second live row for one UTR.
    async insertTxn(t) {
      const utrKey = t.status === 'duplicate' ? null : normRef(t.reference);
      try {
        await tx.query(
          'INSERT INTO bank_transactions (id, statement_id, line_no, txn_date, description, reference, utr_key, upi_id, amount, status, flat_no, confidence, reasons, suggested, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [t.id, t.fileId, t.line ?? null, t.date, String(t.description || '').slice(0, 500), String(t.reference || '').slice(0, 120), utrKey, t.upi || null, t.amount, t.status, t.flatNo || null, t.confidence, jsonOut(t.reasons || []), jsonOut(t.suggested), t.fingerprint, nowDb()],
        );
      } catch (e) { if (isDuplicateError(e)) throw new HttpError(409, `UTR ${t.reference} was already imported - duplicate entry rejected`); throw e; }
    },
    async txns(status) {
      const rows = status ? await tx.query('SELECT * FROM bank_transactions WHERE status = ? ORDER BY created_at, id', [status]) : await tx.query('SELECT * FROM bank_transactions ORDER BY created_at, id');
      return rows.map(txnMap);
    },
    async txn(id) { const [t] = await tx.query('SELECT * FROM bank_transactions WHERE id = ?', [id]); return t ? txnMap(t) : null; },
    async updateTxnReview(t) {
      await tx.query('UPDATE bank_transactions SET posted_receipt = ?, posted_flat = ?, rejected = ?, reject_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?', [t.postedReceipt || null, t.postedFlat || null, bool(t.rejected), t.rejectReason || null, t.reviewedBy || null, toDb(t.reviewedAt), t.id]);
    },
  };
}
