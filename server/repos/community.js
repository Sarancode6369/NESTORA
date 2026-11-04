import { toDb, fromDb, ymdOut, bool, num, isDuplicateError, HttpError } from './util.js';

const vMap = (v) => ({
  id: v.id, flatNo: v.flat_no, name: v.name, phone: v.phone || '', purpose: v.purpose, photo: v.photo_uri, photoDeleted: !!v.photo_deleted, status: v.status, clientId: v.client_id, guestCode: v.guest_code,
  createdAt: fromDb(v.created_at), createdBy: v.created_by, decidedAt: fromDb(v.decided_at), decidedBy: v.decided_by, entryAt: fromDb(v.entry_at), exitAt: fromDb(v.exit_at), demo: !!v.is_demo,
});

export function communityRepo(tx, clock) {
  const nowDb = () => toDb(clock());
  return {
    // ---- visitors
    async visitors({ flatNo } = {}) { return (await (flatNo ? tx.query('SELECT * FROM visitors WHERE flat_no = ? ORDER BY created_at DESC, id DESC', [flatNo]) : tx.query('SELECT * FROM visitors ORDER BY created_at DESC, id DESC'))).map(vMap); },
    async visitor(id) { const [v] = await tx.query('SELECT * FROM visitors WHERE id = ?', [id]); return v ? vMap(v) : null; },
    async visitorByClientId(cid) { const [v] = await tx.query('SELECT * FROM visitors WHERE client_id = ?', [cid]); return v ? vMap(v) : null; },
    async insertVisitor(v) {
      try {
        await tx.query('INSERT INTO visitors (id, flat_no, name, phone, purpose, photo_uri, photo_deleted, status, client_id, guest_code, created_at, created_by, entry_at, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [v.id, v.flatNo, v.name, v.phone || null, v.purpose || null, v.photo || null, 0, v.status, v.clientId || null, v.guestCode || null, toDb(v.createdAt), v.createdBy || null, toDb(v.entryAt), bool(v.demo)]);
      } catch (e) { if (isDuplicateError(e)) throw new HttpError(409, 'This visitor record was already received'); throw e; }
    },
    async updateVisitor(v) { await tx.query('UPDATE visitors SET status = ?, decided_at = ?, decided_by = ?, entry_at = ?, exit_at = ? WHERE id = ?', [v.status, toDb(v.decidedAt), v.decidedBy || null, toDb(v.entryAt), toDb(v.exitAt), v.id]); },
    // DPDP retention: photos older than the cutoff are erased; the visit record itself stays.
    async purgePhotos(cutoffIso) { const u = await tx.query('UPDATE visitors SET photo_uri = NULL, photo_deleted = 1 WHERE photo_uri IS NOT NULL AND created_at < ?', [toDb(cutoffIso)]); return u.affectedRows; },
    // ---- guest codes
    async insertGuestCode(g) { try { await tx.query('INSERT INTO guest_codes (code, flat_no, guest_name, valid_date, used, created_at, created_by) VALUES (?, ?, ?, ?, 0, ?, ?)', [g.code, g.flatNo, g.guestName, g.date, toDb(g.createdAt), g.createdBy]); } catch (e) { if (isDuplicateError(e)) return false; throw e; } return true; },
    async guestCodes(flatNo) { return (await tx.query('SELECT * FROM guest_codes WHERE flat_no = ? ORDER BY created_at DESC, code', [flatNo])).map((g) => ({ code: g.code, flatNo: g.flat_no, guestName: g.guest_name, date: ymdOut(g.valid_date), used: !!g.used, createdAt: fromDb(g.created_at), createdBy: g.created_by })); },
    async guestCode(code) { const [g] = await tx.query('SELECT * FROM guest_codes WHERE code = ?', [code]); return g ? { code: g.code, flatNo: g.flat_no, guestName: g.guest_name, date: ymdOut(g.valid_date), used: !!g.used } : null; },
    async claimGuestCode(code) { const u = await tx.query('UPDATE guest_codes SET used = 1 WHERE code = ? AND used = 0', [code]); return u.affectedRows === 1; },
    // ---- notices
    async notices(limit) { const rows = await tx.query(`SELECT * FROM notices ORDER BY posted_at DESC, id DESC ${limit ? 'LIMIT ' + Number(limit) : ''}`); return rows.map((n) => ({ id: n.id, title: n.title, body: n.body, postedAt: fromDb(n.posted_at), by: n.posted_by })); },
    async insertNotice(n) { await tx.query('INSERT INTO notices (id, title, body, posted_at, posted_by) VALUES (?, ?, ?, ?, ?)', [n.id, n.title, n.body, toDb(n.postedAt), n.by]); },
    // ---- amenities & bookings
    async amenities() { return (await tx.query('SELECT * FROM amenities ORDER BY id')).map((a) => ({ id: a.id, name: a.name, openHour: Number(a.open_hour), closeHour: Number(a.close_hour), slotHours: Number(a.slot_hours), fee: Number(a.fee), rules: a.rules })); },
    async bookedSlots(date) { return (await tx.query("SELECT amenity_id, start_hour FROM bookings WHERE booking_date = ? AND status = 'booked'", [date])).map((b) => ({ amenityId: b.amenity_id, startHour: Number(b.start_hour) })); },
    async flatBookedOn(amenityId, date, flatNo) { return (await tx.query("SELECT id FROM bookings WHERE amenity_id = ? AND booking_date = ? AND flat_no = ? AND status = 'booked'", [amenityId, date, flatNo])).length > 0; },
    async insertBooking(b) {
      try { await tx.query('INSERT INTO bookings (id, amenity_id, flat_no, booking_date, start_hour, end_hour, fee, fee_status, status, slot_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [b.id, b.amenityId, b.flatNo, b.date, b.startHour, b.endHour, b.fee, b.feeStatus, 'booked', `${b.amenityId}|${b.date}|${b.startHour}`, nowDb()]); }
      catch (e) { if (isDuplicateError(e)) throw new HttpError(409, 'That slot was just taken'); throw e; }
    },
    async bookings(flatNo) {
      return (await tx.query('SELECT b.*, a.name AS amenity_name FROM bookings b JOIN amenities a ON a.id = b.amenity_id WHERE b.flat_no = ? ORDER BY b.booking_date DESC, b.id DESC', [flatNo])).map((b) => ({ id: b.id, amenityId: b.amenity_id, amenityName: b.amenity_name, flatNo: b.flat_no, date: ymdOut(b.booking_date), startHour: Number(b.start_hour), endHour: Number(b.end_hour), fee: Number(b.fee), feeStatus: b.fee_status, status: b.status, createdAt: fromDb(b.created_at) }));
    },
    async cancelBooking(id) { await tx.query("UPDATE bookings SET status = 'cancelled', slot_key = NULL WHERE id = ?", [id]); },
    // ---- enquiries
    async insertEnquiry(e) { await tx.query('INSERT INTO enquiries (id, created_at, name, phone, message) VALUES (?, ?, ?, ?, ?)', [e.id, toDb(e.at), e.name, e.phone || null, e.message]); },
    async enquiries() { return (await tx.query('SELECT * FROM enquiries ORDER BY created_at DESC, id DESC')).map((e) => ({ id: e.id, at: fromDb(e.created_at), name: e.name, phone: e.phone || '', message: e.message })); },
    async recentEnquiryCount(sinceIso) { return Number((await tx.query('SELECT COUNT(*) AS n FROM enquiries WHERE created_at >= ?', [toDb(sinceIso)]))[0].n); },
  };
}
