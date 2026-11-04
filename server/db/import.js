// Imports a legacy NESTORA JSON snapshot (the old data/nestora.json shape, or the frozen fixture in
// database/fixtures/) into the relational schema. JSON is import/export only - it is never read at runtime.
// Legacy values are mapped to the current taxonomy: Housekeeping -> Cleaning, Critical -> Emergency.
import { toDb, jsonOut, bool, normRef } from '../repos/util.js';

const CAT = { Housekeeping: 'Cleaning' };
const PRI = { Critical: 'Emergency' };
const cat = (v) => (v == null ? null : CAT[v] || v);
const pri = (v) => (v == null ? null : PRI[v] || v);
const ROLES = [['resident', 'Owner, tenant or family member of a flat'], ['helpdesk', 'Help desk / accounts staff'], ['committee', 'Federation committee member'], ['guard', 'Gate guard']];
const day = (iso) => String(iso).slice(0, 10);

export async function importLegacy(tx, d, { importedAt = new Date().toISOString() } = {}) {
  const ins = (table, row) => {
    const cols = Object.keys(row);
    return tx.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
  };
  const at = toDb(importedAt);
  for (const [code, description] of ROLES) await ins('roles', { code, description });

  const c = d.config;
  const settings = { rate_per_sqft: c.ratePerSqft, due_days: c.dueDays, late_fee_mode: c.lateFee.mode, late_fee_grace_days: c.lateFee.graceDays, late_fee_value: c.lateFee.value, duty_manager: c.dutyManager, demo_otp: c.demoOtp, visitor_photo_retention_days: c.visitorPhotoRetentionDays };
  for (const [setting_key, v] of Object.entries(settings)) await ins('app_settings', { setting_key, setting_value: String(v), updated_at: at });

  for (const f of d.flats) await ins('flats', { flat_no: f.flatNo, tower: f.tower, area_sqft: f.area, payment_ref: f.paymentRef || null, is_demo: bool(f.demo) });
  for (const f of d.flats) for (const upi of f.upiIds || []) await ins('flat_upi_ids', { upi_id: String(upi).toLowerCase(), flat_no: f.flatNo });
  for (const u of d.users) await ins('users', { id: u.id, name: u.name, phone: u.phone, role: u.role, flat_no: u.flatNo || null, relation: u.relation || null, is_demo: bool(u.demo), created_at: at });
  for (const s of d.staff) await ins('staff', { id: s.id, name: s.name, team: cat(s.team), phone: s.phone, on_duty: bool(s.onDuty), is_demo: bool(s.demo) });

  for (const b of d.bills) await ins('maintenance_bills', { id: b.id, flat_no: b.flatNo, bill_period: b.period, area_sqft: b.area, rate: b.rate, amount: b.amount, issue_date: b.issueDate, due_date: b.dueDate });

  // Bank statements / transactions (empty in the sample, supported for real exports) before ledger rows that reference them.
  for (const f of d.bankFiles || []) await ins('bank_statements', { id: f.id, filename: f.filename, uploaded_at: toDb(f.uploadedAt), uploaded_by: f.uploadedBy || null, total_rows: f.total || 0, ignored_debits: f.ignoredDebits || 0, parse_errors: jsonOut(f.errors || []), status_counts: jsonOut(f.counts || {}) });
  for (const t of d.bankTxns || []) await ins('bank_transactions', { id: t.id, statement_id: t.fileId, line_no: t.line ?? null, txn_date: t.date, description: String(t.description || '').slice(0, 500), reference: t.reference || '', utr_key: t.status === 'duplicate' ? null : normRef(t.reference), upi_id: t.upi || null, amount: t.amount, status: t.status, flat_no: t.flatNo || null, confidence: t.confidence ?? 0, reasons: jsonOut(t.reasons || []), suggested: jsonOut(t.suggested), fingerprint: t.fingerprint, posted_receipt: t.postedReceipt || null, posted_flat: t.postedFlat || null, rejected: bool(t.rejected), reject_reason: t.rejectReason || null, reviewed_by: t.reviewedBy || null, reviewed_at: toDb(t.reviewedAt), created_at: at });

  for (const e of d.ledger) {
    await ins('flat_ledger', { id: e.id, flat_no: e.flatNo, kind: e.kind, entry_date: e.date, due_date: e.dueDate || null, amount: e.amount, bill_id: e.billId || null, bill_period: e.period || null, method: e.method || null, reference: e.ref || null, payment_ref: e.kind === 'payment' ? normRef(e.ref) : null, receipt_no: e.receiptNo || null, bank_txn_id: e.txnId || null, note: e.note || null, created_at: toDb(`${e.date}T00:00:00Z`) });
  }
  for (const s of d.paySessions || []) await ins('payment_sessions', { id: s.id, flat_no: s.flatNo, user_id: s.userId, amount: s.amount, status: s.status, mode: s.mode || 'TEST', receipt_no: s.receiptNo || null, created_at: toDb(s.createdAt) });

  // Complaints: insert first, link duplicates afterwards so insertion order can never violate the self-reference.
  for (const x of d.complaints) {
    const manual = !!x.categoryConfirmedBy;
    await ins('complaints', {
      id: x.id, flat_no: x.flatNo, tower: x.tower, title: x.title, description: x.description, resident_category: cat(x.residentCategory), category: cat(x.category), priority: pri(x.urgency), status: x.status,
      summary: x.summary || null, suggested_department: cat(x.category), ai_category: cat(x.aiCategory), ai_priority: pri(x.aiUrgency), ai_confidence: x.confidence ?? null, ai_explanation: (x.reasons || []).join(' | ').slice(0, 1000) || null,
      classification_method: manual ? 'manual' : 'keyword_fallback', classification_model: null, needs_review: bool(x.needsReview), review_reasons: jsonOut(x.reviewReasons || []), safety_rules: jsonOut(x.safety || { triggered: false, rules: [] }),
      category_confirmed_by: x.categoryConfirmedBy || null, assignee_id: x.assigneeId || null, escalated_to: x.escalatedTo || null, created_at: toDb(x.createdAt), created_by: x.createdBy || null, respond_by: toDb(x.respondBy),
      first_response_at: toDb(x.firstResponseAt), resolved_at: toDb(x.resolvedAt), linked_to: null, linked_similarity: null, reopen_count: x.reopenCount || 0, is_demo: bool(x.demo),
    });
    let seq = 0;
    for (const h of x.history || []) await ins('complaint_history', { complaint_id: x.id, seq: ++seq, event_at: toDb(h.at), actor: h.actor || 'system', action: h.action, detail: String(h.detail || '').slice(0, 600) });
    seq = 0;
    for (const p of x.photos || []) await ins('complaint_photos', { complaint_id: x.id, seq: ++seq, data_uri: p });
    if (x.rating) await ins('complaint_ratings', { complaint_id: x.id, rating: x.rating, comment_text: x.ratingComment || null, rated_at: toDb(x.resolvedAt || x.createdAt) });
  }
  for (const x of d.complaints) if (x.linkedTo) await tx.query('UPDATE complaints SET linked_to = ? WHERE id = ?', [x.linkedTo, x.id]);

  for (const n of d.notices) await ins('notices', { id: n.id, title: n.title, body: n.body, posted_at: toDb(n.postedAt), posted_by: n.by });
  for (const a of d.amenities) await ins('amenities', { id: a.id, name: a.name, open_hour: a.openHour, close_hour: a.closeHour, slot_hours: a.slotHours, fee: a.fee, rules: a.rules || null });
  for (const v of d.visitors) await ins('visitors', { id: v.id, flat_no: v.flatNo, name: v.name, phone: v.phone || null, purpose: v.purpose || null, photo_uri: v.photo || null, photo_deleted: bool(v.photoDeleted), status: v.status, client_id: v.clientId || null, guest_code: v.guestCode || null, created_at: toDb(v.createdAt), created_by: null, decided_at: toDb(v.decidedAt), decided_by: null, entry_at: toDb(v.entryAt), exit_at: toDb(v.exitAt), is_demo: bool(v.demo) });
  for (const g of d.guestCodes || []) await ins('guest_codes', { code: g.code, flat_no: g.flatNo, guest_name: g.guestName, valid_date: g.date, used: bool(g.used), created_at: toDb(g.createdAt), created_by: g.createdBy });
  for (const b of d.bookings || []) await ins('bookings', { id: b.id, amenity_id: b.amenityId, flat_no: b.flatNo, booking_date: b.date, start_hour: b.startHour, end_hour: b.endHour, fee: b.fee, fee_status: b.feeStatus || 'payable', status: b.status, slot_key: b.status === 'booked' ? `${b.amenityId}|${b.date}|${b.startHour}` : null, created_at: toDb(b.createdAt) });
  for (const a of d.audit || []) await ins('audit_logs', { id: a.id, created_at: toDb(a.at), actor: String(a.actor || 'system').slice(0, 20), action: a.action, detail: jsonOut(a.detail) });
  for (const n of d.notifications || []) await ins('notifications', { id: n.id, created_at: toDb(n.at), channel: n.channel, recipient: String(n.to).slice(0, 40), message: n.message, is_mock: bool(n.mock !== false) });
  for (const e of d.enquiries || []) await ins('enquiries', { id: e.id, created_at: toDb(e.at), name: e.name, phone: e.phone || null, message: e.message });

  const names = { user: 'user', staff: 'staff', bill: 'bill', ledger: 'ledger', receipt: 'receipt', complaint: 'complaint', notice: 'notice', visitor: 'visitor' };
  for (const [name, v] of Object.entries({ audit: 0, notif: 0, booking: 0, enquiry: 0, paysession: 0, bankfile: 0, banktxn: 0, correction: 0, ...Object.fromEntries(Object.entries(d.counters || {}).map(([k, v]) => [names[k] || k, v])) })) {
    await ins('counters', { name, current_value: v });
  }
  return { flats: d.flats.length, users: d.users.length, bills: d.bills.length, ledger: d.ledger.length, complaints: d.complaints.length, staff: d.staff.length };
}

// ---- SQL script export (database/seed.sql) ----
const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`);
export function recordingExecutor() {
  const lines = [];
  return { lines, query: async (sql, params = []) => { let i = 0; lines.push(sql.replace(/\?/g, () => lit(params[i++])) + ';'); return { affectedRows: 1 }; } };
}
