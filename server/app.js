import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { statement, statementFrom, groupByFlat, generateBills, applyLateFees, postPayment, computeLateFee, LATE_FEE_MODES, round2, dayDiff } from './billing.js';
import { processBankCsv } from './matching.js';
import { createComplaint, changeCategory, changePriority, confirmReview, changeStatus, assign, rate, reopen, unlink, linkComplaint, responseState, keywordClassifier } from './complaints.js';
import { CATEGORIES, URGENCIES } from './triage.js';
import { suggestDuplicateComplaints } from './ai/duplicates.js';
import { runChatbot } from './ai/chatbot.js';
import { createAiFromEnv } from './ai/index.js';
import { analytics, monthlyReport } from './analytics.js';
import { createRepos } from './repos/index.js';
import { HttpError } from './repos/util.js';
import { createLimiter } from './ratelimit.js';
import { resetDemo } from './db/bootstrap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const SHARED = path.join(__dirname, '..', 'shared');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.csv': 'text/csv', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

const bad = (m) => new HttpError(400, m);

// ---- tiny JWT (HS256) ----
const b64 = (b) => Buffer.from(b).toString('base64url');
export function signToken(payload, secret, ttlSec = 8 * 3600) {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const s = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
export function verifyToken(token, secret) {
  const [h, p, s] = String(token || '').split('.');
  if (!h || !p || !s) return null;
  const exp = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  const a = Buffer.from(s); const b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body; try { body = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
  if (body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

const PHONE_RE = /^[6-9]\d{9}$/;
const str = (v, name, { min = 1, max = 500 } = {}) => {
  if (typeof v !== 'string') throw bad(`${name} is required`);
  const t = v.trim();
  if (t.length < min) throw bad(`${name} is required`);
  if (t.length > max) throw bad(`${name} is too long`);
  return t;
};

// db: an adapter from server/db (MySQL in production). clock / classifier / limits are injectable for tests.
export function createApp({
  db, secret = process.env.JWT_SECRET || 'dev-only-secret-change-me', clock = () => new Date(), classifier = keywordClassifier,
  aiStatus = () => ({ mode: 'keyword', provider: null, model: null }), otpAttempts = new Map(),
  limits = {}, allowDemoReset = process.env.NODE_ENV !== 'production',
  groq = null,
}) {
  const groqClient = groq ?? createAiFromEnv().groq;
  const routes = [];
  const route = (method, pattern, roles, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, roles, handler, ...opts });
  };
  const today = () => clock().toISOString().slice(0, 10);
  const apiLimiter = createLimiter({ windowMs: 60000, max: limits.api ?? 600 });
  const authLimiter = createLimiter({ windowMs: 60000, max: limits.auth ?? 20 });
  const aiLimiter = createLimiter({ windowMs: 60000, max: limits.complaints ?? 10 });
  const analyzeLimiter = createLimiter({ windowMs: 60000, max: limits.analyze ?? 60 });
  const chatLimiter = createLimiter({ windowMs: 60000, max: limits.chat ?? 30 });
  const publicLimiter = createLimiter({ windowMs: 60000, max: limits.publicForm ?? 10 });
  const tooMany = (hit) => { if (!hit.ok) throw Object.assign(new HttpError(429, `Too many requests. Try again in ${hit.retryAfterSec}s.`), { retryAfter: hit.retryAfterSec }); };

  const ownFlat = async (r, user, flatNo) => {
    if (user.role === 'resident' && user.flatNo !== flatNo) throw new HttpError(403, 'You can only access your own flat');
    if (!(await r.core.flat(flatNo))) throw new HttpError(404, 'Unknown flat');
  };
  const staffRoles = ['helpdesk'];
  const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, flatNo: u.flatNo, relation: u.relation, phone: u.phone });

  // ================= Auth (DEMO OTP) =================
  route('POST', '/api/auth/request-otp', null, async ({ body, now, r, ip }) => {
    tooMany(authLimiter.hit(`otp:${ip}`));
    const phone = str(body.phone, 'Mobile number', { min: 10, max: 10 });
    if (!PHONE_RE.test(phone)) throw bad('Enter a valid 10-digit Indian mobile number');
    const user = await r.core.userByPhone(phone);
    if (!user) throw new HttpError(404, 'This number is not linked to any flat or staff account');
    otpAttempts.set(phone, { n: 0, at: now.getTime() });
    return { sent: true, demo: true, message: 'DEMO MODE: no SMS is sent. Use the demo OTP shown on this screen.', demoOtp: (await r.core.getConfig()).demoOtp };
  });
  route('POST', '/api/auth/verify-otp', null, async ({ body, now, r, ip }) => {
    tooMany(authLimiter.hit(`verify:${ip}`));
    const phone = str(body.phone, 'Mobile number', { min: 10, max: 10 });
    const otp = str(body.otp, 'OTP', { min: 4, max: 8 });
    const st = otpAttempts.get(phone);
    if (!st) throw bad('Request an OTP first');
    if (st.n >= 5) throw new HttpError(429, 'Too many attempts. Request a new OTP.');
    if (now.getTime() - st.at > 10 * 60000) throw bad('OTP expired. Request a new one.');
    if (otp !== (await r.core.getConfig()).demoOtp) { st.n++; throw new HttpError(401, 'Incorrect OTP'); }
    otpAttempts.delete(phone);
    const user = await r.core.userByPhone(phone);
    return { token: signToken({ sub: user.id }, secret), user: publicUser(user), demo: true };
  });
  route('GET', '/api/me', ['resident', 'helpdesk', 'committee', 'guard'], async ({ user, r }) => ({ user: publicUser(user), flat: user.flatNo ? await r.core.flat(user.flatNo) : null, config: { demo: true, ratePerSqft: (await r.core.getConfig()).ratePerSqft } }));

  // ================= Flats / dashboard =================
  route('GET', '/api/flats', staffRoles.concat(['committee']), async ({ r }) => {
    const day = today();
    const flats = await r.core.flats();
    const by = groupByFlat(await r.billing.allLedger());
    const latest = new Map();
    for (const b of await r.billing.allBills()) { const cur = latest.get(b.flatNo); if (!cur || b.period > cur.period) latest.set(b.flatNo, b); }
    return {
      flats: flats.map((f) => {
        const st = statementFrom(by.get(f.flatNo) || [], f.flatNo, day);
        return { ...f, outstanding: st.outstanding, daysOverdue: st.maxOverdueDays, currentBill: latest.get(f.flatNo) || null, currentMonth: day.slice(0, 7) };
      }),
    };
  });
  route('GET', '/api/flats/:flatNo/dashboard', ['resident', 'helpdesk'], async ({ params, user, r }) => {
    await ownFlat(r, user, params.flatNo);
    const flatNo = params.flatNo; const day = today();
    const cfg = await r.core.getConfig();
    const flat = await r.core.flat(flatNo);
    const st = await statement(r, flatNo, day);
    const residents = (await r.core.usersOfFlat(flatNo)).map(publicUser);
    const resident = residents.find((u) => u.relation !== 'family') || residents[0];
    const open = (await r.complaints.list({ flatNo })).filter((c) => c.status !== 'resolved');
    const visitors = (await r.community.visitors({ flatNo })).filter((v) => v.createdAt.slice(0, 10) === day);
    const dueBill = st.items.filter((i) => i.due > 0 && i.kind === 'bill').sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    const lateFee = computeLateFee(st.outstanding, st.maxOverdueDays, cfg.lateFee);
    return {
      resident, residents, flat: { flatNo, tower: flat.tower, area: flat.area },
      maintenance: { outstanding: st.outstanding, daysOverdue: st.maxOverdueDays, oldestDueDate: dueBill?.dueDate || null, status: st.outstanding <= 0 ? 'paid' : st.maxOverdueDays > 0 ? 'overdue' : 'due', advanceCredit: st.advanceCredit, lateFeeEstimate: lateFee, lateFeeMode: cfg.lateFee.mode },
      openComplaints: open.length, openComplaintList: open.map((c) => ({ id: c.id, title: c.title, status: c.status })), visitorsToday: visitors.length,
      pendingApprovals: visitors.filter((v) => v.status === 'pending').length,
      notices: await r.community.notices(5),
    };
  });
  route('GET', '/api/flats/:flatNo/ledger', ['resident', 'helpdesk'], async ({ params, user, r }) => {
    await ownFlat(r, user, params.flatNo);
    const entries = await r.billing.ledgerForFlat(params.flatNo);
    const st = statementFrom(entries, params.flatNo, today());
    let bal = 0;
    const rows = entries.map((e) => { bal = round2(bal + (e.kind === 'payment' ? -e.amount : e.amount)); return { ...e, balance: bal }; });
    return { flatNo: params.flatNo, rows, outstanding: st.outstanding, items: st.items, advanceCredit: st.advanceCredit };
  });
  route('GET', '/api/flats/:flatNo/bills', ['resident', 'helpdesk'], async ({ params, user, r }) => {
    await ownFlat(r, user, params.flatNo);
    const st = await statement(r, params.flatNo, today());
    const bills = (await r.billing.billsForFlat(params.flatNo)).map((b) => {
      const item = st.items.find((i) => i.billId === b.id && i.kind === 'bill');
      const fee = st.items.find((i) => i.billId === b.id && i.kind === 'late_fee');
      return { ...b, paid: item?.paid ?? 0, due: item?.due ?? 0, daysOverdue: item?.daysOverdue ?? 0, lateFee: fee?.amount || 0, lateFeeDue: fee?.due || 0, status: (item?.due ?? 0) <= 0 ? 'paid' : (item.paid > 0 ? 'partial' : 'unpaid') };
    });
    return { bills, outstanding: st.outstanding };
  });
  route('GET', '/api/flats/:flatNo/receipts', ['resident', 'helpdesk'], async ({ params, user, r }) => {
    await ownFlat(r, user, params.flatNo);
    const rows = (await r.billing.ledgerForFlat(params.flatNo)).filter((e) => e.kind === 'payment');
    return { receipts: rows.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)) };
  });

  // ================= Billing admin =================
  route('GET', '/api/config', ['helpdesk', 'committee'], async ({ r }) => ({ config: { ...(await r.core.getConfig()), demoOtp: undefined }, lateFeeModes: LATE_FEE_MODES }));
  route('PUT', '/api/config', ['helpdesk'], async ({ body, user, r }) => {
    if (body.ratePerSqft !== undefined) { const v = Number(body.ratePerSqft); if (!(v > 0 && v < 1000)) throw bad('Rate must be between 0 and 1000'); await r.core.setSetting('ratePerSqft', v); }
    if (body.dueDays !== undefined) { const d = Number(body.dueDays); if (!Number.isInteger(d) || d < 0 || d > 60) throw bad('Due days must be 0 to 60'); await r.core.setSetting('dueDays', d); }
    if (body.lateFee) {
      const { mode, graceDays = 0, value = 0 } = body.lateFee;
      if (!LATE_FEE_MODES.includes(mode)) throw bad('Unknown late fee mode');
      if (!(Number(value) >= 0) || !(Number(graceDays) >= 0)) throw bad('Late fee values must not be negative');
      await r.core.setSetting('lateFee.mode', mode); await r.core.setSetting('lateFee.graceDays', Number(graceDays)); await r.core.setSetting('lateFee.value', Number(value));
    }
    const c = await r.core.getConfig();
    await r.core.audit(user, 'config.update', { ratePerSqft: c.ratePerSqft, dueDays: c.dueDays, lateFee: c.lateFee });
    return { config: { ...c, demoOtp: undefined } };
  });
  route('POST', '/api/bills/generate', ['helpdesk'], async ({ body, user, r }) => {
    const period = str(body.period, 'Period', { max: 7 });
    let out; try { out = await generateBills(r, period, today(), user); } catch (e) { if (e.status) throw e; throw bad(e.message); }
    return { created: out.created.length, skipped: out.skipped.length };
  });
  route('POST', '/api/latefees/apply', ['helpdesk'], async ({ user, r }) => {
    const out = await applyLateFees(r, today(), user);
    return { posted: out.posted.length, note: out.note || null };
  });

  // ================= Test-mode payments (no real money, no card data) =================
  route('POST', '/api/payments/checkout', ['resident'], async ({ body, user, r, now }) => {
    const flatNo = user.flatNo;
    const cfg = await r.core.getConfig();
    const st = await statement(r, flatNo, today());
    const fee = computeLateFee(st.outstanding, st.maxOverdueDays, cfg.lateFee);
    const lateDue = st.items.filter((i) => i.kind === 'late_fee').reduce((s, i) => s + i.due, 0);
    const payable = st.outstanding; // late fees already posted are in outstanding
    if (payable <= 0) throw new HttpError(409, 'Nothing is due on this flat');
    const amount = body.amount === undefined ? payable : Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw bad('Enter a valid amount');
    if (amount > payable + 0.005) throw bad(`Amount cannot exceed the outstanding balance of ₹${payable}`);
    const sess = { id: await r.core.nextId('paysession', 'PS-', 5), flatNo, userId: user.id, amount: round2(amount), status: 'created', createdAt: now.toISOString(), mode: 'TEST' };
    await r.billing.sessionInsert(sess);
    return { sessionId: sess.id, amount: sess.amount, mode: 'TEST', note: 'Test mode: no real payment. Never enter real card or bank details.', pendingLateFeeNotPosted: lateDue === 0 ? fee : 0 };
  });
  route('POST', '/api/payments/:sessionId/complete', ['resident'], async ({ params, body, user, r }) => {
    const s = await r.billing.sessionGet(params.sessionId);
    if (!s || s.userId !== user.id) throw new HttpError(404, 'Payment session not found');
    if (s.status === 'paid') throw new HttpError(409, 'This payment was already completed');
    if (body.outcome === 'fail') { await r.billing.sessionClaim(s.id, 'created', 'failed'); return { status: 'failed', message: 'Test payment declined. Nothing was charged.' }; }
    if (!['upi', 'card', 'netbanking'].includes(body.method)) throw bad('Choose a test payment method');
    // Compare-and-set: of two concurrent completions only one flips created -> paid.
    if (!(await r.billing.sessionClaim(s.id, 'created', 'paid'))) throw new HttpError(409, 'This payment session is no longer open');
    const e = await postPayment(r, { flatNo: s.flatNo, amount: s.amount, date: today(), method: `${body.method}-test`, ref: s.id, actor: user });
    await r.billing.sessionUpdate({ ...s, status: 'paid', receiptNo: e.receiptNo });
    return { status: 'paid', receipt: e };
  });

  // ================= Bank reconciliation =================
  route('POST', '/api/bank/upload', staffRoles, async ({ body, user, r }) => {
    const csv = str(body.csv, 'CSV content', { max: 3_000_000 });
    const out = await processBankCsv(r, csv, body.filename, user, today());
    if (!out.ok) throw Object.assign(bad(out.error), { details: { missing: out.missing } });
    return { file: out.file, txns: out.txns };
  });
  route('GET', '/api/bank/transactions', staffRoles, async ({ query, r }) => {
    const all = await r.bank.txns();
    const counts = {}; all.forEach((x) => { const k = x.postedReceipt ? 'posted' : x.rejected ? 'rejected' : x.status; counts[k] = (counts[k] || 0) + 1; });
    const t = query.status ? all.filter((x) => x.status === query.status) : all;
    return { txns: t.slice().reverse(), counts, files: await r.bank.statements() };
  });
  const getTxn = async (r, id) => { const t = await r.bank.txn(id); if (!t) throw new HttpError(404, 'Transaction not found'); return t; };
  route('POST', '/api/bank/transactions/:id/approve', staffRoles, async ({ params, body, user, r, now }) => {
    const t = await getTxn(r, params.id);
    if (t.postedReceipt) throw new HttpError(409, 'Already posted - duplicate posting is blocked');
    if (t.rejected) throw new HttpError(409, 'This transaction was rejected');
    if (t.status === 'duplicate') throw new HttpError(409, 'Duplicate transactions cannot be posted');
    const confident = t.status === 'matched' || t.status === 'partial';
    const flatNo = confident ? t.flatNo : str(body.flatNo, 'Flat number', { max: 12 });
    if (body.flatNo && body.flatNo !== flatNo && confident) throw bad('Matched transactions cannot be redirected; reject and re-review instead');
    if (!(await r.core.flat(flatNo))) throw bad('Unknown flat number');
    const e = await postPayment(r, { flatNo, amount: t.amount, date: t.date, method: 'bank-transfer', ref: t.reference, txnId: t.id, actor: user, note: `Bank txn ${t.id}; ${t.status}${body.note ? '; ' + String(body.note).slice(0, 120) : ''}` });
    Object.assign(t, { postedReceipt: e.receiptNo, postedFlat: flatNo, reviewedBy: user.id, reviewedAt: now.toISOString() });
    await r.bank.updateTxnReview(t);
    await r.core.audit(user, 'bank.approve', { txnId: t.id, flatNo, amount: t.amount, receiptNo: e.receiptNo, status: t.status });
    return { txn: t, receipt: e };
  });
  route('POST', '/api/bank/transactions/:id/reject', staffRoles, async ({ params, body, user, r, now }) => {
    const t = await getTxn(r, params.id);
    if (t.postedReceipt) throw new HttpError(409, 'Already posted');
    Object.assign(t, { rejected: true, rejectReason: String(body.reason || '').slice(0, 200), reviewedBy: user.id, reviewedAt: now.toISOString() });
    await r.bank.updateTxnReview(t);
    await r.core.audit(user, 'bank.reject', { txnId: t.id, reason: t.rejectReason });
    return { txn: t };
  });
  // Auto-post: only status === matched (reference identified AND amount exact). Everything else stays in the queue.
  route('POST', '/api/bank/auto-post', staffRoles, async ({ user, r, now }) => {
    let n = 0;
    for (const t of await r.bank.txns('matched')) {
      if (t.postedReceipt || t.rejected || t.confidence < 0.9) continue;
      const e = await postPayment(r, { flatNo: t.flatNo, amount: t.amount, date: t.date, method: 'bank-transfer', ref: t.reference, txnId: t.id, actor: user, note: `Auto-posted exact match ${t.id}` });
      Object.assign(t, { postedReceipt: e.receiptNo, postedFlat: t.flatNo, reviewedBy: user.id, reviewedAt: now.toISOString() });
      await r.bank.updateTxnReview(t); n++;
    }
    await r.core.audit(user, 'bank.autopost', { posted: n });
    return { posted: n };
  });

  // ================= Complaints =================
  const viewComplaint = (c, staff, nowMs) => ({ ...c, assignee: staff.find((s) => s.id === c.assigneeId) || null, response: responseState(c, nowMs), linkedPrimary: c.linkedTo, priority: c.urgency });
  const getC = async (r, id) => { const c = await r.complaints.get(id); if (!c) throw new HttpError(404, 'Complaint not found'); return c; };
  const ownComplaint = async (r, id, user) => { const c = await getC(r, id); if (user.role === 'resident' && c.flatNo !== user.flatNo) throw new HttpError(404, 'Complaint not found'); return c; };
  const out = async (r, c, nowMs) => ({ complaint: viewComplaint(await r.complaints.get(c.id), await r.core.staffList(), nowMs) });

  // AI Complaint Analysis endpoint (before submission). Calls Groq with safety net & keyword fallback.
  const analyzeComplaint = async ({ body, user, r }) => {
    tooMany(analyzeLimiter.hit(`analyze:${user.id}`));
    const desc = body.description || body.text || '';
    const description = str(desc, 'Description', { min: 3, max: 2000 });
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : '';
    const residentCategory = body.category && CATEGORIES.includes(body.category) ? body.category : null;
    const cls = await classifier({ title, description, residentCategory, staff: await r.core.staffList(), load: await r.complaints.openLoad() });
    return {
      category: cls.category || cls.aiCategory || 'Other',
      priority: cls.urgency || cls.aiUrgency || 'Medium',
      urgency: cls.urgency || cls.aiUrgency || 'Medium',
      summary: cls.summary || (title ? `${title} - ${description.slice(0, 100)}` : description.slice(0, 100)),
      confidence: cls.confidence ?? 0,
      safety: cls.safety || { triggered: false, rules: [], labels: [] },
      needsReview: !!cls.needsReview,
      reviewReasons: cls.reviewReasons || [],
      method: cls.method || 'keyword_fallback',
      model: cls.model || null,
      explanation: cls.explanation || '',
      fallbackReason: cls.fallbackReason || null,
      categories: CATEGORIES,
      priorities: URGENCIES,
    };
  };
  route('POST', '/api/complaints/analyze', ['resident', 'helpdesk'], analyzeComplaint);
  route('POST', '/api/ai/analyze', ['resident', 'helpdesk'], analyzeComplaint);

  // AI Duplicate Complaint Suggestions (before submission or during triage)
  route('POST', '/api/complaints/duplicates/suggest', ['resident', 'helpdesk'], async ({ body, user, r, now }) => {
    tooMany(analyzeLimiter.hit(`suggest:${user.id}`));
    let title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    let desc = body.description || body.text || '';
    let category = body.category && CATEGORIES.includes(body.category) ? body.category : null;
    let flatNo = user.flatNo;
    let tower = null;

    if (body.id) {
      const existing = await r.complaints.get(body.id, { photos: false });
      if (existing) {
        if (!desc || desc.trim().length === 0) desc = existing.description;
        if (!title) title = existing.title;
        if (!category) category = existing.category;
        if (!flatNo || user.role === 'helpdesk') flatNo = existing.flatNo;
      }
    }

    if (user.role === 'helpdesk' && body.flatNo) {
      flatNo = str(body.flatNo, 'Flat number', { max: 12 });
    }
    if (flatNo) {
      const fl = await r.core.flat(flatNo);
      if (fl) tower = fl.tower;
    }
    const description = str(desc, 'Description', { min: 3, max: 2000 });
    const open = await r.complaints.list({ openOnly: true });
    const candidates = await suggestDuplicateComplaints(open, { title, description, category, flatNo, tower, id: body.id || null }, { groq, nowMs: now.getTime() });

    // Resident privacy protection: never expose other residents' flat details or personal info
    const outCandidates = candidates.map((c) => {
      const isOwn = user.role === 'resident' && c.flatNo === user.flatNo;
      return {
        id: c.id,
        title: c.title,
        category: c.category,
        status: c.status,
        urgency: c.urgency,
        createdAt: c.createdAt,
        similarity: c.similarity,
        explanation: c.explanation,
        needsReview: c.needsReview,
        flatNo: (user.role === 'helpdesk' || isOwn) ? c.flatNo : undefined,
        tower: user.role === 'helpdesk' ? c.tower : undefined,
      };
    });
    return { candidates: outCandidates };
  });

  // Classification (possibly a network call to Groq) happens BEFORE the database transaction opens, so no row
  // locks are held while we wait for the model.
  route('POST', '/api/complaints', ['resident', 'helpdesk'], async ({ body, user, now, r }) => {
    tooMany(aiLimiter.hit(`complaint:${user.id}`));
    const title = str(body.title, 'Title', { min: 3, max: 120 });
    const description = str(body.description, 'Description', { min: 5, max: 2000 });
    const category = body.category && body.category !== '' ? body.category : null;
    if (category && !CATEGORIES.includes(category)) throw bad('Invalid category');
    const priority = body.priority && body.priority !== '' ? body.priority : null;
    if (priority && !URGENCIES.includes(priority)) throw bad('Invalid priority');
    const summary = typeof body.summary === 'string' && body.summary.trim() ? body.summary.trim().slice(0, 300) : null;
    const photos = Array.isArray(body.photos) ? body.photos.slice(0, 3).filter((p) => typeof p === 'string' && p.startsWith('data:image/') && p.length < 900_000) : [];
    const flatNo = user.flatNo || (body.flatNo ? str(body.flatNo, 'Flat number', { max: 12 }) : null);
    if (!flatNo) throw bad('Flat number is required');
    const cls = await classifier({ title, description, residentCategory: category, staff: await r.core.staffList(), load: await r.complaints.openLoad() });
    const created = await db.transaction((tx) => createComplaint(createRepos(tx, clock), { flatNo, title, description, category, priority, summary, photos }, user, now, { classifier: async () => cls }));
    return { complaint: viewComplaint(created, await r.core.staffList(), now.getTime()) };
  }, { ownTx: true });
  route('GET', '/api/complaints', ['resident', 'helpdesk'], async ({ user, query, r, now }) => {
    const list = await r.complaints.list({ flatNo: user.role === 'resident' ? user.flatNo : undefined, status: query.status, category: query.category, urgency: query.urgency, review: query.review === '1' });
    const staff = await r.core.staffList();
    const outList = list.map((c) => {
      const v = viewComplaint(c, staff, now.getTime());
      if (user.role === 'resident') { delete v.reasons; delete v.explanation; delete v.classificationModel; delete v.reviewReasons; }
      return { ...v, photos: c.photoCount };
    });
    return { complaints: outList, staff: user.role === 'helpdesk' ? staff : undefined };
  });
  route('GET', '/api/complaints/:id', ['resident', 'helpdesk'], async ({ params, user, r, now }) => {
    const c = await ownComplaint(r, params.id, user);
    const staff = await r.core.staffList();
    const v = viewComplaint(c, staff, now.getTime());
    if (user.role === 'helpdesk') { v.linkedFrom = await r.complaints.linkedFrom(c.id); v.corrections = await r.complaints.corrections(c.id); }
    else { delete v.reasons; delete v.explanation; delete v.classificationModel; delete v.reviewReasons; }
    return { complaint: v, staff: user.role === 'helpdesk' ? staff : undefined };
  });
  route('PATCH', '/api/complaints/:id/category', ['helpdesk'], async ({ params, body, user, now, r }) => { await changeCategory(r, await getC(r, params.id), body.category, user, now); return out(r, params, now.getTime()); });
  route('PATCH', '/api/complaints/:id/priority', ['helpdesk'], async ({ params, body, user, now, r }) => { await changePriority(r, await getC(r, params.id), body.priority, user, now); return out(r, params, now.getTime()); });
  route('POST', '/api/complaints/:id/confirm', ['helpdesk'], async ({ params, user, now, r }) => { await confirmReview(r, await getC(r, params.id), user, now); return out(r, params, now.getTime()); });
  route('PATCH', '/api/complaints/:id/status', ['helpdesk'], async ({ params, body, user, now, r }) => { await changeStatus(r, await getC(r, params.id), body.status, user, now); return out(r, params, now.getTime()); });
  route('PATCH', '/api/complaints/:id/assign', ['helpdesk'], async ({ params, body, user, now, r }) => { await assign(r, await getC(r, params.id), body.staffId, user, now); return out(r, params, now.getTime()); });
  route('POST', '/api/complaints/:id/rate', ['resident'], async ({ params, body, user, now, r }) => { await rate(r, await ownComplaint(r, params.id, user), Number(body.rating), body.comment, user, now); return out(r, params, now.getTime()); });
  route('POST', '/api/complaints/:id/reopen', ['resident'], async ({ params, body, user, now, r }) => { await reopen(r, await ownComplaint(r, params.id, user), body.reason, user, now); return out(r, params, now.getTime()); });
  route('POST', '/api/complaints/:id/unlink', ['helpdesk'], async ({ params, user, now, r }) => { await unlink(r, await getC(r, params.id), user, now); return out(r, params, now.getTime()); });
  route('POST', '/api/complaints/:id/link', ['helpdesk'], async ({ params, body, user, now, r }) => {
    const targetId = str(body.targetId, 'Target Complaint ID', { min: 3, max: 20 });
    const c = await getC(r, params.id);
    await linkComplaint(r, c, targetId, user, now, body.reason);
    return out(r, params, now.getTime());
  });
  route('GET', '/api/staff', ['helpdesk'], async ({ r }) => ({ staff: await r.core.staffList() }));
  // Which engine classifies complaints right now. Never returns the key itself.
  route('GET', '/api/ai/status', ['helpdesk', 'committee'], () => ({ ...aiStatus(), categories: CATEGORIES, priorities: URGENCIES }));

  // ================= Visitors =================
  const guestCode = () => crypto.randomInt(100000, 999999).toString();
  const publicVisitor = (v) => ({ ...v, photo: v.photo && !v.photoDeleted ? v.photo : null });
  route('GET', '/api/visitors', ['resident', 'helpdesk', 'guard'], async ({ user, query, r }) => {
    let list = await r.community.visitors({ flatNo: user.role === 'resident' ? user.flatNo : undefined });
    const day = query.date || today();
    if (!query.all) list = list.filter((v) => v.createdAt.slice(0, 10) === day || v.status === 'inside');
    return { visitors: list.map(publicVisitor), notice: `Visitor photos are kept for ${(await r.core.getConfig()).visitorPhotoRetentionDays} days and then deleted automatically (DPDP Act 2023).` };
  });
  route('POST', '/api/visitors', ['guard', 'helpdesk'], async ({ body, user, now, r }) => {
    const name = str(body.name, 'Visitor name', { min: 2, max: 80 });
    const phone = str(body.phone, 'Phone number', { min: 10, max: 10 });
    if (!PHONE_RE.test(phone)) throw bad('Enter a valid 10-digit mobile number');
    const flatNo = str(body.flatNo, 'Flat number', { max: 12 }).toUpperCase();
    if (!(await r.core.flat(flatNo))) throw bad('Unknown flat number');
    const clientId = body.clientId ? String(body.clientId).slice(0, 60) : null;
    if (clientId) { const ex = await r.community.visitorByClientId(clientId); if (ex) return { visitor: publicVisitor(ex), deduplicated: true }; } // offline queue replays are idempotent
    const photo = typeof body.photo === 'string' && body.photo.startsWith('data:image/') && body.photo.length < 1_200_000 ? body.photo : null;
    const v = { id: await r.core.nextId('visitor', 'V-', 4), flatNo, name, phone, purpose: String(body.purpose || 'Visit').slice(0, 60), photo, status: 'pending', createdAt: now.toISOString(), createdBy: user.id, clientId };
    await r.community.insertVisitor(v);
    await r.core.notify(flatNo, `${name} is at the gate for ${flatNo}. Approve or deny in the app.`, 'push-mock');
    return { visitor: publicVisitor(await r.community.visitor(v.id)) };
  });
  route('POST', '/api/visitors/:id/decision', ['resident'], async ({ params, body, user, now, r }) => {
    const v = await r.community.visitor(params.id);
    if (!v || v.flatNo !== user.flatNo) throw new HttpError(404, 'Visitor not found');
    if (v.status !== 'pending') throw new HttpError(409, `Visitor is already ${v.status}`);
    if (!['approve', 'deny'].includes(body.decision)) throw bad('Decision must be approve or deny');
    Object.assign(v, { status: body.decision === 'approve' ? 'approved' : 'denied', decidedAt: now.toISOString(), decidedBy: user.id });
    await r.community.updateVisitor(v);
    return { visitor: publicVisitor(v) };
  });
  route('POST', '/api/visitors/:id/entry', ['guard', 'helpdesk'], async ({ params, now, r }) => {
    const v = await r.community.visitor(params.id);
    if (!v) throw new HttpError(404, 'Visitor not found');
    if (!['approved', 'preapproved'].includes(v.status)) throw new HttpError(409, v.status === 'denied' ? 'Resident denied this visitor' : 'Resident approval is still pending');
    Object.assign(v, { status: 'inside', entryAt: now.toISOString() });
    await r.community.updateVisitor(v);
    return { visitor: publicVisitor(v) };
  });
  route('POST', '/api/visitors/:id/exit', ['guard', 'helpdesk'], async ({ params, now, r }) => {
    const v = await r.community.visitor(params.id);
    if (!v) throw new HttpError(404, 'Visitor not found');
    if (v.status !== 'inside') throw new HttpError(409, 'Visitor is not inside');
    Object.assign(v, { status: 'exited', exitAt: now.toISOString() });
    await r.community.updateVisitor(v);
    return { visitor: publicVisitor(v) };
  });
  route('POST', '/api/guest-codes', ['resident'], async ({ body, user, now, r }) => {
    const guestName = str(body.guestName, 'Guest name', { min: 2, max: 80 });
    const validDate = str(body.date, 'Date', { max: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validDate)) throw bad('Date must look like 2026-11-05');
    if (validDate < today()) throw bad('Date cannot be in the past');
    for (let i = 0; i < 20; i++) {
      const g = { code: guestCode(), flatNo: user.flatNo, guestName, date: validDate, used: false, createdAt: now.toISOString(), createdBy: user.id };
      if (await r.community.insertGuestCode(g)) return { guestCode: g };
    }
    throw new HttpError(503, 'Could not allocate a guest code, please retry');
  });
  route('GET', '/api/guest-codes', ['resident'], async ({ user, r }) => ({ codes: await r.community.guestCodes(user.flatNo) }));
  route('POST', '/api/guest-codes/redeem', ['guard', 'helpdesk'], async ({ body, user, now, r }) => {
    const code = str(body.code, 'Guest code', { min: 6, max: 6 });
    const g = await r.community.guestCode(code);
    if (!g) throw new HttpError(404, 'Code not found');
    if (g.used) throw new HttpError(409, 'Code already used');
    if (g.date !== today()) throw new HttpError(409, `Code is valid only on ${g.date}`);
    if (!(await r.community.claimGuestCode(code))) throw new HttpError(409, 'Code already used');
    const v = { id: await r.core.nextId('visitor', 'V-', 4), flatNo: g.flatNo, name: g.guestName, phone: '', purpose: 'Pre-approved guest', photo: null, status: 'inside', createdAt: now.toISOString(), entryAt: now.toISOString(), createdBy: user.id, guestCode: code };
    await r.community.insertVisitor(v);
    return { visitor: publicVisitor(await r.community.visitor(v.id)) };
  });
  // Retention job: delete photos older than N days. Runs on boot, hourly, and on demand.
  const purge = () => db.transaction(async (tx) => {
    const r = createRepos(tx, clock);
    const cutoff = clock().getTime() - (await r.core.getConfig()).visitorPhotoRetentionDays * 86400000;
    const n = await r.community.purgePhotos(new Date(cutoff).toISOString());
    if (n) await r.core.audit('system', 'visitor.photo.purge', { deleted: n });
    return n;
  });
  route('POST', '/api/visitors/purge', ['helpdesk'], async ({ r, now, user }) => {
    const cutoff = now.getTime() - (await r.core.getConfig()).visitorPhotoRetentionDays * 86400000;
    const n = await r.community.purgePhotos(new Date(cutoff).toISOString());
    if (n) await r.core.audit(user, 'visitor.photo.purge', { deleted: n });
    return { deleted: n };
  });

  // ================= Notices & amenities =================
  route('GET', '/api/notices', ['resident', 'helpdesk', 'committee', 'guard'], async ({ r }) => ({ notices: await r.community.notices() }));
  route('POST', '/api/notices', ['helpdesk'], async ({ body, user, now, r }) => {
    const n = { id: await r.core.nextId('notice', 'NT-', 3), title: str(body.title, 'Title', { max: 100 }), body: str(body.body, 'Message', { max: 1000 }), postedAt: now.toISOString(), by: user.name };
    await r.community.insertNotice(n);
    return { notice: n };
  });
  route('GET', '/api/amenities', ['resident', 'helpdesk'], async ({ query, r }) => {
    const date = query.date || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('Date must look like 2026-11-05');
    const booked = await r.community.bookedSlots(date);
    return { amenities: (await r.community.amenities()).map((a) => {
      const slots = [];
      for (let h = a.openHour; h + a.slotHours <= a.closeHour; h += a.slotHours) slots.push({ startHour: h, endHour: h + a.slotHours, taken: booked.some((b) => b.amenityId === a.id && b.startHour === h) });
      return { ...a, slots };
    }), date };
  });
  route('POST', '/api/bookings', ['resident'], async ({ body, user, now, r }) => {
    const a = (await r.community.amenities()).find((x) => x.id === body.amenityId);
    if (!a) throw new HttpError(404, 'Amenity not found');
    const date = str(body.date, 'Date', { max: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('Date must look like 2026-11-05');
    const startHour = Number(body.startHour);
    if (date < today()) throw bad('Cannot book a past date');
    if (dayDiff(date, today()) > 30) throw bad('Bookings open up to 30 days ahead');
    const ok = [];
    for (let h = a.openHour; h + a.slotHours <= a.closeHour; h += a.slotHours) ok.push(h);
    if (!ok.includes(startHour)) throw bad('Invalid slot');
    if (a.id !== 'AM-1' && await r.community.flatBookedOn(a.id, date, user.flatNo)) throw new HttpError(409, 'One slot per flat per day for this amenity');
    const b = { id: await r.core.nextId('booking', 'BK-', 4), amenityId: a.id, amenityName: a.name, flatNo: user.flatNo, date, startHour, endHour: startHour + a.slotHours, fee: a.fee, status: 'booked', createdAt: now.toISOString(), feeStatus: 'payable' };
    await r.community.insertBooking(b); // the unique slot key rejects a double booking even under a race
    return { booking: b };
  });
  route('GET', '/api/bookings', ['resident'], async ({ user, r }) => ({ bookings: await r.community.bookings(user.flatNo) }));
  route('POST', '/api/bookings/:id/cancel', ['resident'], async ({ params, user, now, r }) => {
    const b = (await r.community.bookings(user.flatNo)).find((x) => x.id === params.id);
    if (!b) throw new HttpError(404, 'Booking not found');
    if (b.status !== 'booked') throw new HttpError(409, 'Already cancelled');
    const startMs = Date.parse(`${b.date}T${String(b.startHour).padStart(2, '0')}:00:00+05:30`);
    if (startMs - now.getTime() < 24 * 3600000) throw new HttpError(409, 'Cancellations close 24 hours before the slot');
    await r.community.cancelBooking(b.id);
    return { booking: { ...b, status: 'cancelled' } };
  });

  // ================= AI Resident Chatbot (Read-only, Authenticated Resident Only) =================
  route('POST', '/api/chat', ['resident'], async ({ body, user, r }) => {
    tooMany(chatLimiter.hit(`chat:${user.id}`));
    const message = str(body.message, 'Message', { min: 1, max: 500 });
    const history = Array.isArray(body.history)
      ? body.history.slice(-10).filter((h) => h && typeof h.content === 'string')
      : [];

    // Context retrieved server-side from authenticated session (never from client request)
    const flatInfo = user.flatNo ? await r.core.flat(user.flatNo) : null;
    const complaints = user.flatNo ? await r.complaints.list({ flatNo: user.flatNo }) : [];
    let billing = null;
    try {
      if (user.flatNo) {
        const [stmt, bills] = await Promise.all([
          statement(r, user.flatNo, today()),
          r.billing.billsForFlat(user.flatNo),
        ]);
        const dueBills = (stmt?.items || []).filter((i) => i.due > 0 && i.kind === 'bill');
        const oldestDue = dueBills.slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
        const latestPayment = (stmt?.payments || []).slice().sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))[0];

        billing = {
          hasRecords: (bills.length > 0 || (stmt?.items && stmt.items.length > 0) || (stmt?.payments && stmt.payments.length > 0)),
          outstanding: stmt ? stmt.outstanding : 0,
          advanceCredit: stmt ? stmt.advanceCredit : 0,
          status: stmt ? (stmt.outstanding <= 0 ? 'paid' : (stmt.maxOverdueDays > 0 ? 'overdue' : 'due')) : 'unavailable',
          daysOverdue: stmt ? stmt.maxOverdueDays : 0,
          oldestDueDate: oldestDue?.dueDate || null,
          unpaidBills: dueBills.slice(0, 3).map((b) => ({
            period: b.period,
            amount: b.amount,
            due: b.due,
            dueDate: b.dueDate,
            daysOverdue: b.daysOverdue,
          })),
          recentPayment: latestPayment ? {
            date: latestPayment.date,
            amount: latestPayment.amount,
            method: latestPayment.method,
            receiptNo: latestPayment.receiptNo,
          } : null,
          paymentRef: flatInfo?.paymentRef || `NST-${user.flatNo}`,
        };
      }
    } catch {
      billing = null;
    }
    const amenities = await r.community.amenities();
    const notices = await r.community.notices(5);

    const result = await runChatbot({
      groq: groqClient,
      context: { flatInfo, complaints, billing, amenities, notices },
      message,
      history,
    });
    return result;
  }, { ownTx: true });

  // ================= Committee =================
  route('GET', '/api/analytics', ['committee', 'helpdesk'], async ({ query, r, now }) => analytics(r, today(), now.getTime(), query.period));
  route('GET', '/api/reports/monthly.csv', ['committee', 'helpdesk'], async ({ query, r, now }) => {
    const period = query.period && /^\d{4}-\d{2}$/.test(query.period) ? query.period : today().slice(0, 7);
    return { __csv: await monthlyReport(r, today(), period, now.getTime()), filename: `nestora-report-${period}.csv` };
  });
  route('GET', '/api/audit', ['committee', 'helpdesk'], async ({ r }) => ({ audit: await r.core.recentAudit(100) }));
  route('GET', '/api/notifications', ['helpdesk'], async ({ r }) => ({ notifications: await r.core.recentNotifications(50) }));

  // ================= Public landing-page data (no personal data) =================
  route('GET', '/api/public/notices', null, async ({ r }) => ({ notices: (await r.community.notices(3)).map(({ id, title, body, postedAt }) => ({ id, title, body, postedAt })) }));
  route('GET', '/api/public/amenities', null, async ({ r }) => ({ amenities: (await r.community.amenities()).map(({ id, name, openHour, closeHour, slotHours, fee, rules }) => ({ id, name, openHour, closeHour, slotHours, fee, rules })) }));

  // ================= Public contact form (landing page) =================
  route('POST', '/api/contact', null, async ({ body, now, r, ip }) => {
    tooMany(publicLimiter.hit(`contact:${ip}`));
    const name = str(body.name, 'Name', { min: 2, max: 80 });
    const phone = String(body.phone || '').trim(); if (phone && !PHONE_RE.test(phone)) throw bad('Enter a valid 10-digit mobile number');
    const message = str(body.message, 'Message', { min: 5, max: 1000 });
    if ((await r.community.recentEnquiryCount(new Date(now.getTime() - 60000).toISOString())) > 30) throw new HttpError(429, 'Please try again in a minute');
    await r.community.insertEnquiry({ id: await r.core.nextId('enquiry', 'ENQ-', 4), at: now.toISOString(), name, phone, message });
    return { received: true };
  });
  route('GET', '/api/enquiries', ['helpdesk'], async ({ r }) => ({ enquiries: await r.community.enquiries() }));

  // ================= Demo utilities =================
  route('POST', '/api/demo/reset', ['helpdesk'], async () => {
    if (!allowDemoReset) throw new HttpError(403, 'Demo reset is disabled in production');
    await resetDemo(db, clock());
    return { reset: true };
  }, { ownTx: true });
  route('GET', '/api/health', null, async ({ r, now }) => { await r.core.countUsers(); return { ok: true, database: db.engine, time: now.toISOString() }; });

  // ================= server =================
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 6_000_000) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(bad('Invalid JSON')); } });
    req.on('error', reject);
  });
  const send = (res, status, data, headers = {}) => {
    const isBuf = Buffer.isBuffer(data) || typeof data === 'string';
    res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store', ...(isBuf ? {} : { 'Content-Type': 'application/json' }), ...headers });
    res.end(isBuf ? data : JSON.stringify(data));
  };
  const serveStatic = (res, pathname) => {
    let base = PUBLIC; let rel = pathname;
    if (pathname.startsWith('/shared/')) { base = SHARED; rel = pathname.slice(7); }
    const file = path.normalize(path.join(base, rel === '/' ? 'index.html' : rel));
    if (!file.startsWith(base)) return send(res, 403, 'Forbidden');
    let target = file;
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) { target = path.join(PUBLIC, 'index.html'); } // SPA fallback
    if (!fs.existsSync(target)) return send(res, 404, 'Not found');
    const ext = path.extname(target);
    send(res, 200, fs.readFileSync(target), { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': target.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300' });
  };

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(res, decodeURIComponent(url.pathname));
      const ip = String(req.socket.remoteAddress || 'local');
      tooMany(apiLimiter.hit(`api:${ip}`));
      const rt = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!rt) {
        if (routes.some((x) => x.re.test(url.pathname))) throw new HttpError(405, 'Method not allowed');
        throw new HttpError(404, 'Not found');
      }
      const m = rt.re.exec(url.pathname);
      const params = {}; rt.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const readRepos = createRepos(db, clock);
      let user = null;
      if (rt.roles) {
        const auth = req.headers.authorization || '';
        const tok = auth.startsWith('Bearer ') ? verifyToken(auth.slice(7), secret) : null;
        user = tok && await readRepos.core.userById(tok.sub);
        if (!user) throw new HttpError(401, 'Please sign in');
        if (!rt.roles.includes(user.role)) throw new HttpError(403, 'Your role does not have access to this');
      }
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const query = Object.fromEntries(url.searchParams);
      const now = clock();
      const call = (r) => rt.handler({ params, body, query, user, now, r, ip, db });
      // Every state-changing request runs in ONE transaction: all of its writes commit together or not at all.
      const result = req.method === 'GET' || rt.ownTx ? await call(readRepos) : await db.transaction((tx) => call(createRepos(tx, clock)));
      if (result && result.__csv !== undefined) return send(res, 200, result.__csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${result.filename}"` });
      send(res, 200, result);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error('Unhandled error:', e?.message || e); // never log request bodies, tokens or keys
      send(res, status, { error: status === 500 ? 'Something went wrong on our side' : e.message, ...(e.details ? { details: e.details } : {}) }, e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {});
    }
  };
  const server = http.createServer(handler);
  server.purge = purge;
  return { server, handler, purge };
}
