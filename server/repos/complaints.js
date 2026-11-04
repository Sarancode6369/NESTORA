import { toDb, fromDb, jsonOut, jsonIn, bool, num } from './util.js';

const BASE = `SELECT c.*, r.rating AS rating_value, r.comment_text AS rating_comment,
  (SELECT COUNT(*) FROM complaints x WHERE x.linked_to = c.id) AS linked_count
  FROM complaints c LEFT JOIN complaint_ratings r ON r.complaint_id = c.id`;

const map = (c) => ({
  id: c.id, flatNo: c.flat_no, tower: Number(c.tower), title: c.title, description: c.description, residentCategory: c.resident_category,
  category: c.category, urgency: c.priority, status: c.status, summary: c.summary, suggestedDepartment: c.suggested_department,
  aiCategory: c.ai_category, aiUrgency: c.ai_priority, confidence: num(c.ai_confidence), reasons: c.ai_explanation ? String(c.ai_explanation).split(' | ') : [], explanation: c.ai_explanation || '',
  classificationMethod: c.classification_method, classificationModel: c.classification_model,
  needsReview: !!c.needs_review, reviewReasons: jsonIn(c.review_reasons, []), safety: jsonIn(c.safety_rules, { triggered: false, rules: [] }),
  categoryConfirmedBy: c.category_confirmed_by, assigneeId: c.assignee_id, escalatedTo: c.escalated_to,
  createdAt: fromDb(c.created_at), createdBy: c.created_by, respondBy: fromDb(c.respond_by), firstResponseAt: fromDb(c.first_response_at), resolvedAt: fromDb(c.resolved_at),
  rating: c.rating_value == null ? null : Number(c.rating_value), ratingComment: c.rating_comment || '',
  linkedTo: c.linked_to, linkedSimilarity: num(c.linked_similarity), linkedCount: Number(c.linked_count || 0), reopenCount: Number(c.reopen_count), demo: !!c.is_demo,
  photos: [], history: [],
});

const COLS = (c) => [
  c.flatNo, c.tower, c.title, c.description, c.residentCategory || null, c.category, c.urgency, c.status, c.summary || null, c.suggestedDepartment || null,
  c.aiCategory || null, c.aiUrgency || null, c.confidence ?? null, (c.reasons || []).join(' | ').slice(0, 1000) || null, c.classificationMethod, c.classificationModel || null,
  bool(c.needsReview), jsonOut(c.reviewReasons || []), jsonOut(c.safety || { triggered: false, rules: [] }), c.categoryConfirmedBy || null, c.assigneeId || null, c.escalatedTo || null,
  toDb(c.createdAt), c.createdBy || null, toDb(c.respondBy), toDb(c.firstResponseAt), toDb(c.resolvedAt), c.linkedTo || null, c.linkedSimilarity ?? null, c.reopenCount || 0, bool(c.demo),
];

export function complaintsRepo(tx) {
  const r = {
    async insert(c) {
      await tx.query(`INSERT INTO complaints (id, flat_no, tower, title, description, resident_category, category, priority, status, summary, suggested_department, ai_category, ai_priority, ai_confidence, ai_explanation, classification_method, classification_model, needs_review, review_reasons, safety_rules, category_confirmed_by, assignee_id, escalated_to, created_at, created_by, respond_by, first_response_at, resolved_at, linked_to, linked_similarity, reopen_count, is_demo) VALUES (${Array(32).fill('?').join(', ')})`, [c.id, ...COLS(c)]);
      let seq = 0;
      for (const p of c.photos || []) await tx.query('INSERT INTO complaint_photos (complaint_id, seq, data_uri) VALUES (?, ?, ?)', [c.id, ++seq, p]);
    },
    async save(c) {
      await tx.query('UPDATE complaints SET flat_no=?, tower=?, title=?, description=?, resident_category=?, category=?, priority=?, status=?, summary=?, suggested_department=?, ai_category=?, ai_priority=?, ai_confidence=?, ai_explanation=?, classification_method=?, classification_model=?, needs_review=?, review_reasons=?, safety_rules=?, category_confirmed_by=?, assignee_id=?, escalated_to=?, created_at=?, created_by=?, respond_by=?, first_response_at=?, resolved_at=?, linked_to=?, linked_similarity=?, reopen_count=?, is_demo=? WHERE id=?', [...COLS(c), c.id]);
    },
    async history(c, at, actor, action, detail = '') {
      const [m] = await tx.query('SELECT COALESCE(MAX(seq), 0) AS m FROM complaint_history WHERE complaint_id = ?', [c.id]);
      const entry = { at: new Date(at).toISOString(), actor, action, detail: String(detail).slice(0, 600) };
      await tx.query('INSERT INTO complaint_history (complaint_id, seq, event_at, actor, action, detail) VALUES (?, ?, ?, ?, ?, ?)', [c.id, Number(m.m) + 1, toDb(entry.at), actor, action, entry.detail]);
      c.history.push(entry);
    },
    async get(id, { photos = true } = {}) {
      const [row] = await tx.query(`${BASE} WHERE c.id = ?`, [id]);
      if (!row) return null;
      const c = map(row);
      c.history = (await tx.query('SELECT * FROM complaint_history WHERE complaint_id = ? ORDER BY seq', [id])).map((h) => ({ at: fromDb(h.event_at), actor: h.actor, action: h.action, detail: h.detail || '' }));
      c.photos = photos ? (await tx.query('SELECT data_uri FROM complaint_photos WHERE complaint_id = ? ORDER BY seq', [id])).map((p) => p.data_uri) : [];
      c.photoCount = (await tx.query('SELECT COUNT(*) AS n FROM complaint_photos WHERE complaint_id = ?', [id]))[0].n;
      c.photoCount = Number(c.photoCount);
      return c;
    },
    // Light rows for lists / analytics / duplicate search: no photos, no history.
    async list({ flatNo, status, category, urgency, review, sinceIso, openOnly } = {}) {
      const where = []; const p = [];
      if (flatNo) { where.push('c.flat_no = ?'); p.push(flatNo); }
      if (status) { where.push('c.status = ?'); p.push(status); }
      if (category) { where.push('c.category = ?'); p.push(category); }
      if (urgency) { where.push('c.priority = ?'); p.push(urgency); }
      if (review) where.push('c.needs_review = 1');
      if (openOnly) where.push("c.status <> 'resolved'");
      if (sinceIso) { where.push('c.created_at >= ?'); p.push(toDb(sinceIso)); }
      const rows = await tx.query(`${BASE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.created_at DESC, c.id DESC`, p);
      const photoCounts = Object.fromEntries((await tx.query('SELECT complaint_id, COUNT(*) AS n FROM complaint_photos GROUP BY complaint_id')).map((x) => [x.complaint_id, Number(x.n)]));
      return rows.map((row) => { const c = map(row); c.photoCount = photoCounts[c.id] || 0; return c; });
    },
    async linkedToOf(id) { const [x] = await tx.query('SELECT linked_to FROM complaints WHERE id = ?', [id]); return x ? x.linked_to : null; },
    async linkedFrom(id) { return (await tx.query('SELECT id, flat_no, title FROM complaints WHERE linked_to = ? ORDER BY created_at', [id])).map((x) => ({ id: x.id, flatNo: x.flat_no, title: x.title })); },
    async openLoad() { return Object.fromEntries((await tx.query("SELECT assignee_id, COUNT(*) AS n FROM complaints WHERE assignee_id IS NOT NULL AND status <> 'resolved' GROUP BY assignee_id")).map((x) => [x.assignee_id, Number(x.n)])); },
    async setRating(id, rating, comment, at) { await tx.query('INSERT INTO complaint_ratings (complaint_id, rating, comment_text, rated_at) VALUES (?, ?, ?, ?)', [id, rating, comment || null, toDb(at)]); },
    async clearRating(id) { await tx.query('DELETE FROM complaint_ratings WHERE complaint_id = ?', [id]); },
    async addCorrection(x) {
      await tx.query('INSERT INTO complaint_corrections (id, complaint_id, field_name, old_value, new_value, method_before, corrected_by, corrected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [x.id, x.complaintId, x.field, x.oldValue || null, x.newValue, x.methodBefore || null, x.by, toDb(x.at)]);
    },
    async corrections(id) {
      return (await tx.query('SELECT * FROM complaint_corrections WHERE complaint_id = ? ORDER BY corrected_at, id', [id])).map((x) => ({ id: x.id, field: x.field_name, oldValue: x.old_value, newValue: x.new_value, methodBefore: x.method_before, by: x.corrected_by, at: fromDb(x.corrected_at) }));
    },
  };
  return r;
}
