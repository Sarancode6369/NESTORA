// Seed data. The three flats from the client brief are exact. Anything else is marked demo:true.
// It builds an in-memory snapshot in the legacy JSON shape; server/db/import.js loads it into MySQL.
import { computeMonthlyBill, addDays, ymd } from './billing.js';
import { classifyComplaint, findDuplicate, suggestStaff, SLA_MINUTES } from './triage.js';

const nextId = (db, key, prefix, pad = 4) => { db.counters[key] = (db.counters[key] || 0) + 1; return `${prefix}${String(db.counters[key]).padStart(pad, '0')}`; };

// Sample-data builder only (the live app uses server/complaints.js against MySQL). Same rules, in memory.
function createComplaint(db, input, user, now) {
  const flat = db.flats.find((f) => f.flatNo === input.flatNo);
  const iso = (d) => new Date(d).toISOString();
  const t = classifyComplaint({ title: input.title, description: input.description, residentCategory: input.category });
  const c = {
    id: nextId(db, 'complaint', 'CMP-', 4), flatNo: flat.flatNo, tower: flat.tower, title: input.title.trim(), description: input.description.trim(), residentCategory: input.category || null,
    ...t, categoryConfirmedBy: null, status: 'open', assigneeId: null, escalatedTo: null, createdAt: iso(now), createdBy: user?.id || null,
    respondBy: iso(new Date(now).getTime() + SLA_MINUTES[t.urgency] * 60000), firstResponseAt: null, resolvedAt: null, rating: null, ratingComment: '', linkedTo: null, linkedCount: 0,
    reopenCount: 0, photos: [], history: [], demo: !!input.demo,
  };
  const hist = (x, action, actor, detail) => x.history.push({ at: iso(now), actor, action, detail });
  hist(c, 'created', user?.name || 'Resident', 'Complaint submitted');
  hist(c, 'triage', 'Auto-triage', `Suggested ${t.aiCategory} / ${t.aiUrgency} (confidence ${t.confidence}). ${t.reasons.join('; ')}`);
  const load = {}; db.complaints.forEach((x) => { if (x.assigneeId && x.status !== 'resolved') load[x.assigneeId] = (load[x.assigneeId] || 0) + 1; });
  const staff = suggestStaff(db.staff, load, c.category);
  if (staff) { c.assigneeId = staff.id; c.status = 'assigned'; hist(c, 'assigned', 'Auto-assign', `Suggested assignment to ${staff.name} (${staff.team})`); }
  if (t.safety.triggered) {
    const duty = db.staff.find((s) => s.team === 'Duty');
    c.status = 'escalated'; c.escalatedTo = duty?.id || null;
    hist(c, 'escalated', 'Safety rule', `${t.safety.labels.join(', ')} - escalated to ${duty?.name || 'duty manager'} by rule`);
  }
  const dup = findDuplicate(db.complaints, c, new Date(now).getTime());
  if (dup) {
    let root = dup.candidate; const seen = new Set();
    while (root.linkedTo && !seen.has(root.id)) { seen.add(root.id); root = db.complaints.find((x) => x.id === root.linkedTo) || root; }
    c.linkedTo = root.id; root.linkedCount += 1;
    hist(c, 'linked', 'Auto-link', `Looks similar to ${root.id} (similarity ${dup.similarity}). Linked only - not closed.`);
  }
  db.complaints.push(c);
  return c;
}

const addMonths = (ymdStr, n) => {
  const [y, m] = ymdStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
};

export function seedDatabase(now = new Date()) {
  const today = ymd(now);
  const db = {
    counters: {},
    config: {
      ratePerSqft: 6.5, dueDays: 10,
      lateFee: { mode: 'none', graceDays: 0, value: 0 }, // set per society bye-laws; nothing invented
      dutyManager: 'Duty Manager (demo)', demoOtp: '123456', visitorPhotoRetentionDays: 90,
    },
    users: [], flats: [], bills: [], ledger: [], bankFiles: [], bankTxns: [], complaints: [], staff: [],
    visitors: [], guestCodes: [], notices: [], amenities: [], bookings: [], audit: [], notifications: [], paySessions: [],
  };
  const id = (k, p, pad) => nextId(db, k, p, pad);

  const flats = [
    { flatNo: 'T07-1203', tower: 7, area: 1150, upiIds: ['neeraj.k@oksbi'] },
    { flatNo: 'T12-0408', tower: 12, area: 980, upiIds: ['swati.joshi@okaxis'] },
    { flatNo: 'T21-1601', tower: 21, area: 1640, upiIds: ['aamir.shaikh@okhdfc'] },
    { flatNo: 'T03-0502', tower: 3, area: 1200, upiIds: ['demo.a@okicici'], demo: true },
    { flatNo: 'T15-0907', tower: 15, area: 850, upiIds: ['demo.b@ybl'], demo: true },
  ];
  for (const f of flats) db.flats.push({ ...f, paymentRef: `NST-${f.flatNo}` });

  const U = (name, phone, role, flatNo = null, relation = null, demo = false) => db.users.push({ id: id('user', 'U-', 3), name, phone, role, flatNo, relation, demo });
  U('Neeraj Kulkarni', '9000000001', 'resident', 'T07-1203', 'owner');
  U('Swati Joshi', '9000000002', 'resident', 'T12-0408', 'tenant');
  U('Aamir Shaikh', '9000000003', 'resident', 'T21-1601', 'owner');
  U('Demo Resident A', '9000000004', 'resident', 'T03-0502', 'owner', true);
  U('Demo Resident B', '9000000005', 'resident', 'T15-0907', 'tenant', true);
  U('Family Member of T07 (demo)', '9000000011', 'resident', 'T07-1203', 'family', true);
  U('Help Desk Staff (demo)', '9000000010', 'helpdesk', null, null, true);
  U('Committee Member (demo)', '9000000020', 'committee', null, null, true);
  U('Gate Guard, Gate 1 (demo)', '9000000030', 'guard', null, null, true);

  const S = (name, team, phone) => db.staff.push({ id: id('staff', 'S-', 3), name, team, phone, onDuty: true, demo: true });
  S('Ramesh Patil (demo)', 'Plumbing', '9000000101'); S('Suresh Gaikwad (demo)', 'Plumbing', '9000000102');
  S('Anil Pawar (demo)', 'Electrical', '9000000103'); S('Lift AMC Technician (demo)', 'Lift', '9000000104');
  S('Sunita Jadhav (demo)', 'Cleaning', '9000000105'); S('Santosh More (demo)', 'Security', '9000000106');
  S('Mahesh Gaikwad (demo)', 'Civil', '9000000108'); S('Facilities Coordinator (demo)', 'Other', '9000000107'); S('Duty Manager (demo)', 'Duty', '9000000099');

  // ---- Ledger ----
  const addBill = (flat, issueDate, dueDate) => {
    const amount = computeMonthlyBill(flat.area, db.config.ratePerSqft);
    const period = issueDate.slice(0, 7);
    const bill = { id: id('bill', 'BILL-'), flatNo: flat.flatNo, period, area: flat.area, rate: db.config.ratePerSqft, amount, issueDate, dueDate };
    db.bills.push(bill);
    db.ledger.push({ id: id('ledger', 'L-', 5), flatNo: flat.flatNo, kind: 'bill', date: issueDate, dueDate, amount, billId: bill.id, period });
    return bill;
  };
  const pay = (flat, date, amount, method = 'upi') => {
    db.ledger.push({ id: id('ledger', 'L-', 5), flatNo: flat.flatNo, kind: 'payment', date, amount, method, ref: `SEED-${flat.flatNo}-${date}`, receiptNo: id('receipt', `RCP-${date.slice(0, 4)}-`, 6), txnId: null, note: 'Seed data' });
  };
  const monthStart = today.slice(0, 7) + '-01';
  const sample = {
    'T07-1203': { issue: monthStart, due: addDays(monthStart, 10), paid: 7475 },
    'T12-0408': { due: addDays(today, -47), paid: 0 },
    'T21-1601': { due: addDays(today, -18), paid: 5000 },
    'T03-0502': { issue: monthStart, due: addDays(monthStart, 10), paid: 0 },
    'T15-0907': { issue: monthStart, due: addDays(monthStart, 10), paid: 0 },
  };
  for (const f of db.flats) {
    const s = sample[f.flatNo];
    const issue = s.issue || addDays(s.due, -10);
    const firstOfSamplePeriod = issue.slice(0, 7) + '-01';
    for (let i = 5; i >= 1; i--) { // five earlier months, all paid (demo history)
      const start = addMonths(firstOfSamplePeriod, -i);
      addBill(f, start, addDays(start, 10));
      pay(f, addDays(start, 4), computeMonthlyBill(f.area, 6.5));
    }
    addBill(f, issue, s.due);
    if (s.paid > 0) { const payDate = [addDays(issue, 1), addDays(s.due, -6)].map((d) => (d > today ? today : d)).sort()[f.flatNo === 'T21-1601' ? 1 : 0]; pay(f, payDate > today ? today : payDate, s.paid); }
  }

  // ---- Complaints: sample (T12 water leak, open) + clearly marked demo history for analytics ----
  const hoursAgo = (h) => new Date(now.getTime() - h * 3600000);
  const swati = db.users.find((u) => u.phone === '9000000002');
  createComplaint(db, { flatNo: 'T12-0408', title: 'Water leak', description: 'Water is leaking from the bathroom ceiling and dripping onto the floor since two days.', category: 'Plumbing' }, swati, hoursAgo(30));

  const hist = [
    ['T03-0502', 'Lift not working', 'Tower 3 lift is not working on the left side, please repair.', 140 * 24, 6, 0, 5],
    ['T15-0907', 'Corridor light fused', 'The corridor light near flat 907 is not working.', 120 * 24, 20, 0, 4],
    ['T07-1203', 'Garbage not collected', 'Garbage was not collected from our floor for two days, dirty smell.', 100 * 24, 30, 1, 3],
    ['T21-1601', 'Tap leakage', 'Kitchen tap is leaking continuously.', 90 * 24, 9, 0, 5],
    ['T03-0502', 'Security gate issue', 'Guard let an unknown visitor in without calling.', 75 * 24, 4, 0, 4],
    ['T15-0907', 'Water leakage from ceiling', 'Water seepage in living room ceiling, wall damp.', 60 * 24, 52, 1, 3],
    ['T07-1203', 'Power socket sparking', 'Socket in bedroom is sparking when plugging in.', 45 * 24, 3, 0, 5],
    ['T21-1601', 'Staircase cleaning', 'Staircase has not been mopped this week.', 30 * 24, 14, 0, 4],
    ['T03-0502', 'Drain blocked', 'Drain in balcony is blocked and water is stagnant.', 20 * 24, 26, 0, 4],
    ['T15-0907', 'Lift buttons broken', 'Lift floor buttons are not responding in tower 15.', 10 * 24, 8, 1, 4],
  ];
  for (const [flatNo, title, description, agoH, resH, reopened, rating] of hist) {
    const u = db.users.find((x) => x.flatNo === flatNo && x.relation !== 'family');
    const created = hoursAgo(agoH);
    const c = createComplaint(db, { flatNo, title, description, demo: true }, u, created);
    c.firstResponseAt = new Date(created.getTime() + Math.min(resH, 3) * 3600000).toISOString();
    c.status = 'resolved';
    c.resolvedAt = new Date(created.getTime() + resH * 3600000).toISOString();
    c.rating = rating;
    c.reopenCount = reopened;
    c.needsReview = false;
    c.linkedTo = null; c.linkedCount = 0;
    if (reopened) c.history.push({ at: c.resolvedAt, actor: 'Demo data', action: 'reopened', detail: 'Reopened once, then resolved again (demo history)' });
    c.history.push({ at: c.resolvedAt, actor: 'Demo data', action: 'status', detail: 'resolved (demo history)' });
  }
  // Re-assert that the sample resolved complaints do not distort the live queue
  db.complaints.forEach((c) => { if (c.demo) c.assigneeId = c.assigneeId; });

  // ---- Notices ----
  const N = (title, body, daysAgo) => db.notices.push({ id: id('notice', 'NT-', 3), title, body, postedAt: new Date(now.getTime() - daysAgo * 86400000).toISOString(), by: 'Help Desk Staff (demo)' });
  N('Water tank cleaning - Towers 10 to 14', 'Overhead tank cleaning is scheduled on Saturday 10:00 to 14:00. Please store water in advance.', 1);
  N('Maintenance due date', `Maintenance bills are issued on the 1st of each month and fall due ${db.config.dueDays} days later. Late fees, if any, follow the society bye-laws.`, 3);
  N('Clubhouse booking rules', 'Hall bookings are for residents only, up to 30 days ahead. Cancellations are free up to 24 hours before the slot.', 6);

  // ---- Visitors (today) ----
  const now2 = now.toISOString();
  db.visitors.push({ id: id('visitor', 'V-', 4), flatNo: 'T07-1203', name: 'Rahul Verma (demo)', phone: '9000000201', purpose: 'Friend visit', photo: null, status: 'pending', createdAt: now2, createdBy: 'guard', clientId: null, demo: true });
  db.visitors.push({ id: id('visitor', 'V-', 4), flatNo: 'T21-1601', name: 'Courier - Demo Express', phone: '9000000202', purpose: 'Delivery', photo: null, status: 'exited', createdAt: new Date(now.getTime() - 3 * 3600000).toISOString(), entryAt: new Date(now.getTime() - 3 * 3600000 + 600000).toISOString(), exitAt: new Date(now.getTime() - 2.8 * 3600000).toISOString(), createdBy: 'guard', clientId: null, demo: true });

  // ---- Amenities ----
  db.amenities.push({ id: 'AM-1', name: 'Clubhouse Hall', openHour: 8, closeHour: 22, slotHours: 2, fee: 1500, rules: 'Residents only. Up to 30 days in advance. Max 60 guests. Music off by 22:00.' });
  db.amenities.push({ id: 'AM-2', name: 'Badminton Court', openHour: 6, closeHour: 22, slotHours: 1, fee: 100, rules: 'One slot per flat per day. Non-marking shoes required.' });
  db.amenities.push({ id: 'AM-3', name: 'Tennis Court', openHour: 6, closeHour: 21, slotHours: 1, fee: 200, rules: 'Maximum 4 players. Floodlights charged within the slot fee.' });
  return db;
}
