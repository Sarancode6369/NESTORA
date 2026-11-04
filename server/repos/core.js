import { toDb, fromDb, jsonOut, jsonIn, bool, num } from './util.js';

const SETTING_KEYS = {
  ratePerSqft: 'rate_per_sqft', dueDays: 'due_days', dutyManager: 'duty_manager', demoOtp: 'demo_otp', visitorPhotoRetentionDays: 'visitor_photo_retention_days',
  'lateFee.mode': 'late_fee_mode', 'lateFee.graceDays': 'late_fee_grace_days', 'lateFee.value': 'late_fee_value',
};

export function coreRepo(tx, clock) {
  const nowDb = () => toDb(clock());
  const r = {
    // ---- ids: race-safe because the counter row is locked until the surrounding transaction ends
    async nextId(name, prefix, pad = 4) {
      const u = await tx.query('UPDATE counters SET current_value = current_value + 1 WHERE name = ?', [name]);
      if (!u.affectedRows) await tx.query('INSERT INTO counters (name, current_value) VALUES (?, 1)', [name]);
      const [row] = await tx.query('SELECT current_value FROM counters WHERE name = ?', [name]);
      return `${prefix}${String(num(row.current_value)).padStart(pad, '0')}`;
    },
    // ---- settings
    async getConfig() {
      const rows = await tx.query('SELECT setting_key, setting_value FROM app_settings');
      const m = Object.fromEntries(rows.map((x) => [x.setting_key, x.setting_value]));
      return {
        ratePerSqft: Number(m.rate_per_sqft ?? 6.5), dueDays: Number(m.due_days ?? 10), dutyManager: m.duty_manager || 'Duty Manager',
        demoOtp: m.demo_otp || '123456', visitorPhotoRetentionDays: Number(m.visitor_photo_retention_days ?? 90),
        lateFee: { mode: m.late_fee_mode || 'none', graceDays: Number(m.late_fee_grace_days ?? 0), value: Number(m.late_fee_value ?? 0) },
      };
    },
    async setSetting(key, value) {
      const col = SETTING_KEYS[key] || key;
      const u = await tx.query('UPDATE app_settings SET setting_value = ?, updated_at = ? WHERE setting_key = ?', [String(value), nowDb(), col]);
      if (!u.affectedRows) await tx.query('INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)', [col, String(value), nowDb()]);
    },
    // ---- people
    userMap: (u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role, flatNo: u.flat_no, relation: u.relation, demo: !!u.is_demo }),
    async userByPhone(phone) { const [u] = await tx.query('SELECT * FROM users WHERE phone = ?', [phone]); return u ? r.userMap(u) : null; },
    async userById(id) { const [u] = await tx.query('SELECT * FROM users WHERE id = ?', [id]); return u ? r.userMap(u) : null; },
    async usersOfFlat(flatNo) { return (await tx.query('SELECT * FROM users WHERE flat_no = ? ORDER BY id', [flatNo])).map(r.userMap); },
    async countUsers() { const [x] = await tx.query('SELECT COUNT(*) AS n FROM users'); return num(x.n); },
    async flats() {
      const rows = await tx.query('SELECT * FROM flats ORDER BY flat_no');
      const upis = await tx.query('SELECT upi_id, flat_no FROM flat_upi_ids');
      return rows.map((f) => ({ flatNo: f.flat_no, tower: Number(f.tower), area: Number(f.area_sqft), paymentRef: f.payment_ref, demo: !!f.is_demo, upiIds: upis.filter((u) => u.flat_no === f.flat_no).map((u) => u.upi_id) }));
    },
    async flat(flatNo) { return (await r.flats()).find((f) => f.flatNo === flatNo) || null; },
    async staffList() { return (await tx.query('SELECT * FROM staff ORDER BY id')).map((s) => ({ id: s.id, name: s.name, team: s.team, phone: s.phone, onDuty: !!s.on_duty, demo: !!s.is_demo })); },
    async staffById(id) { return (await r.staffList()).find((s) => s.id === id) || null; },
    // ---- audit & notifications
    async audit(actor, action, detail) {
      const id = await r.nextId('audit', 'A-', 5);
      await tx.query('INSERT INTO audit_logs (id, created_at, actor, action, detail) VALUES (?, ?, ?, ?, ?)', [id, nowDb(), actor?.id || (typeof actor === 'string' ? actor : 'system'), action, jsonOut(detail)]);
      return id;
    },
    async recentAudit(limit = 100) {
      return (await tx.query('SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?', [limit])).map((a) => ({ id: a.id, at: fromDb(a.created_at), actor: a.actor, action: a.action, detail: jsonIn(a.detail, {}) }));
    },
    async notify(to, message, channel = 'sms-mock') {
      const id = await r.nextId('notif', 'N-', 5);
      await tx.query('INSERT INTO notifications (id, created_at, channel, recipient, message, is_mock) VALUES (?, ?, ?, ?, ?, ?)', [id, nowDb(), channel, to, String(message).slice(0, 500), bool(true)]);
    },
    async recentNotifications(limit = 50) {
      return (await tx.query('SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ?', [limit])).map((n) => ({ id: n.id, at: fromDb(n.created_at), channel: n.channel, to: n.recipient, message: n.message, mock: !!n.is_mock }));
    },
  };
  return r;
}
