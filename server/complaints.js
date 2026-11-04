// Complaint workflow. All persistence goes through the repositories (`r`); the HTTP layer runs every write
// request inside one database transaction, so a failure part-way rolls the whole operation back.
import { classifyComplaint, findDuplicate, suggestStaff, SLA_MINUTES, CATEGORIES, URGENCIES } from './triage.js';

export const STATUSES = ['open', 'assigned', 'in_progress', 'resolved', 'reopened', 'escalated'];

const iso = (d) => new Date(d).toISOString();
const plusMin = (d, m) => iso(new Date(d).getTime() + m * 60000);
const fail = (status, message) => Object.assign(new Error(message), { status });

// Default classifier = deterministic keyword engine. The HTTP layer injects the Groq-backed classifier
// (server/ai/classifier.js), which itself falls back to this one.
export const keywordClassifier = async (input) => ({ ...classifyComplaint(input), method: 'keyword_fallback', model: null, suggestedDepartment: null });

export async function staffLoad(r) { return r.complaints.openLoad(); }

export async function createComplaint(r, input, user, now, { classifier = keywordClassifier } = {}) {
  const flat = await r.core.flat(input.flatNo);
  if (!flat) throw fail(404, 'Unknown flat');
  const t = await classifier({ title: input.title, description: input.description, residentCategory: input.category, staff: await r.core.staffList(), load: await staffLoad(r) });
  const c = {
    id: await r.core.nextId('complaint', 'CMP-', 4), flatNo: flat.flatNo, tower: flat.tower,
    title: input.title.trim(), description: input.description.trim(), residentCategory: input.category || null,
    ...t, classificationMethod: t.method, classificationModel: t.model || null, categoryConfirmedBy: null, status: 'open', assigneeId: null, escalatedTo: null,
    createdAt: iso(now), createdBy: user?.id || null, respondBy: plusMin(now, SLA_MINUTES[t.urgency]),
    firstResponseAt: null, resolvedAt: null, rating: null, ratingComment: '', linkedTo: null, linkedSimilarity: null, linkedCount: 0,
    reopenCount: 0, photos: input.photos || [], history: [], demo: !!input.demo,
  };
  c.suggestedDepartment = t.suggestedDepartment || c.category;
  await r.complaints.insert(c);
  await r.complaints.history(c, now, user?.name || 'Resident', 'created', 'Complaint submitted');
  const how = t.method === 'groq_ai' ? `AI (${t.model || 'Groq'})` : 'Keyword fallback';
  await r.complaints.history(c, now, 'Auto-triage', 'triage', `${how}: ${t.aiCategory} / ${t.aiUrgency} (confidence ${t.confidence}). ${(t.reasons || []).join('; ')}`);

  const staffList = await r.core.staffList();
  const load = await staffLoad(r);
  // Staff suggestion: the classifier may name a specific member (validated against the roster); otherwise least-loaded in the department.
  const dept = t.suggestedDepartment && CATEGORIES.includes(t.suggestedDepartment) ? t.suggestedDepartment : c.category;
  const named = t.suggestedStaffId ? staffList.find((s) => s.id === t.suggestedStaffId && s.onDuty && s.team === dept) : null;
  const staff = named || suggestStaff(staffList, load, dept);
  if (staff) { c.assigneeId = staff.id; c.status = 'assigned'; await r.complaints.history(c, now, 'Auto-assign', 'assigned', `Suggested assignment to ${staff.name} (${staff.team})`); }

  // Escalation to the duty manager. Safety rules are deterministic and independent of the classifier: they always win.
  // An emergency the AI spotted on its own (no rule matched) is escalated too, but stays correctable by the help desk.
  const esc = t.safety?.triggered ? { labels: t.safety.labels, by: 'Safety rule', why: 'by rule, regardless of automated classification' } : t.aiEscalate ? { labels: ['AI-detected emergency'], by: 'AI triage', why: 'on the AI emergency verdict - verify' } : null;
  if (esc) {
    const duty = staffList.find((s) => s.team === 'Duty');
    c.status = 'escalated';
    c.escalatedTo = duty?.id || null;
    await r.complaints.history(c, now, esc.by, 'escalated', `${esc.labels.join(', ')} - escalated to ${duty?.name || 'duty manager'} ${esc.why}`);
    await r.core.notify(duty?.phone || 'duty-manager', `SAFETY ESCALATION (${esc.labels.join(', ')}) at ${c.flatNo}: ${c.title}`);
  }

  // Duplicate linking: link only. The duplicate stays visible and open; nothing is closed or hidden.
  const open = await r.complaints.list({ openOnly: true });
  const dup = findDuplicate(open, c, new Date(now).getTime());
  if (dup) {
    let rootId = dup.candidate.id; const guard = new Set();
    for (let nxt = await r.complaints.linkedToOf(rootId); nxt && !guard.has(nxt); nxt = await r.complaints.linkedToOf(rootId)) { guard.add(rootId); rootId = nxt; }
    c.linkedTo = rootId; c.linkedSimilarity = dup.similarity;
    await r.complaints.history(c, now, 'Auto-link', 'linked', `Looks similar to ${rootId} (similarity ${dup.similarity}). Linked only - not closed.`);
    const primary = await r.complaints.get(rootId, { photos: false });
    if (primary) await r.complaints.history(primary, now, 'Auto-link', 'linked-by', `${c.id} (${c.flatNo}) reported something similar`);
  }
  await r.complaints.save(c);
  return r.complaints.get(c.id);
}

// Help-desk correction of the category. Recorded in the corrections audit trail and in the complaint history.
export async function changeCategory(r, c, category, user, now) {
  if (!CATEGORIES.includes(category)) throw fail(400, 'Invalid category');
  const before = c.category;
  const methodBefore = c.classificationMethod;
  c.category = category;
  c.categoryConfirmedBy = user.id;
  c.needsReview = false;
  c.classificationMethod = 'manual';
  c.suggestedDepartment = category;
  const staff = suggestStaff(await r.core.staffList(), await staffLoad(r), category);
  if (staff && c.status !== 'resolved') { c.assigneeId = staff.id; if (c.status === 'open') c.status = 'assigned'; }
  await r.complaints.save(c);
  if (before !== category) {
    const id = await r.core.nextId('correction', 'CC-', 5);
    await r.complaints.addCorrection({ id, complaintId: c.id, field: 'category', oldValue: before, newValue: category, methodBefore, by: user.id, at: now });
    await r.core.audit(user, 'complaint.correct', { complaintId: c.id, field: 'category', from: before, to: category, methodBefore });
  }
  await r.complaints.history(c, now, user.name, 'category', `Category ${before} -> ${category}${staff ? `; reassigned to ${staff.name}` : ''}`);
  return c;
}

// Help-desk correction of the priority. A safety-flagged (emergency) complaint can never be lowered.
export async function changePriority(r, c, urgency, user, now) {
  if (!URGENCIES.includes(urgency)) throw fail(400, 'Invalid priority');
  if (c.safety?.triggered && urgency !== 'Emergency') throw fail(409, 'Safety-escalated complaints stay at Emergency priority. Resolve the incident instead.');
  const before = c.urgency;
  if (before === urgency) return c;
  const methodBefore = c.classificationMethod;
  c.urgency = urgency; c.categoryConfirmedBy = user.id; c.needsReview = false; c.classificationMethod = 'manual';
  c.respondBy = plusMin(c.createdAt, SLA_MINUTES[urgency]);
  await r.complaints.save(c);
  const id = await r.core.nextId('correction', 'CC-', 5);
  await r.complaints.addCorrection({ id, complaintId: c.id, field: 'priority', oldValue: before, newValue: urgency, methodBefore, by: user.id, at: now });
  await r.core.audit(user, 'complaint.correct', { complaintId: c.id, field: 'priority', from: before, to: urgency, methodBefore });
  await r.complaints.history(c, now, user.name, 'priority', `Priority ${before} -> ${urgency}`);
  return c;
}

// Confirm that a flagged complaint has been checked by a person without changing it.
export async function confirmReview(r, c, user, now) {
  c.needsReview = false; c.categoryConfirmedBy = user.id;
  await r.complaints.save(c);
  await r.core.audit(user, 'complaint.review', { complaintId: c.id, category: c.category, priority: c.urgency });
  await r.complaints.history(c, now, user.name, 'reviewed', `Classification ${c.category} / ${c.urgency} confirmed by help desk`);
  return c;
}

export async function changeStatus(r, c, status, user, now) {
  if (!STATUSES.includes(status)) throw fail(400, 'Invalid status');
  const prev = c.status;
  c.status = status;
  if (!c.firstResponseAt && ['in_progress', 'resolved'].includes(status)) c.firstResponseAt = iso(now);
  if (status === 'resolved') c.resolvedAt = iso(now);
  await r.complaints.save(c);
  await r.complaints.history(c, now, user.name, 'status', `${prev} -> ${status}`);
  return c;
}

export async function assign(r, c, staffId, user, now) {
  const s = await r.core.staffById(staffId);
  if (!s) throw fail(404, 'Unknown staff member');
  c.assigneeId = s.id;
  if (c.status === 'open' || c.status === 'reopened') c.status = 'assigned';
  await r.complaints.save(c);
  await r.complaints.history(c, now, user.name, 'assigned', `Assigned to ${s.name} (${s.team})`);
  return c;
}

export async function rate(r, c, rating, comment, user, now) {
  if (c.status !== 'resolved') throw fail(409, 'Only resolved complaints can be rated');
  if (c.rating) throw fail(409, 'Already rated');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw fail(400, 'Rating must be 1 to 5');
  const text = String(comment || '').slice(0, 300);
  await r.complaints.setRating(c.id, rating, text, now);
  c.rating = rating; c.ratingComment = text;
  await r.complaints.history(c, now, user.name, 'rated', `${rating}/5`);
  return c;
}

export async function reopen(r, c, reason, user, now) {
  if (c.status !== 'resolved') throw fail(409, 'Only resolved complaints can be reopened');
  c.status = 'reopened'; c.reopenCount += 1; c.resolvedAt = null; c.rating = null;
  c.respondBy = plusMin(now, SLA_MINUTES[c.urgency]);
  await r.complaints.clearRating(c.id);
  await r.complaints.save(c);
  await r.complaints.history(c, now, user.name, 'reopened', String(reason || '').slice(0, 300));
  return c;
}

export async function unlink(r, c, user, now) {
  if (!c.linkedTo) return c;
  const was = c.linkedTo;
  c.linkedTo = null; c.linkedSimilarity = null;
  await r.complaints.save(c);
  await r.complaints.history(c, now, user.name, 'unlinked', `Unlinked from ${was}`);
  return c;
}

export function responseState(c, nowMs) {
  const due = Date.parse(c.respondBy);
  if (c.firstResponseAt && c.status !== 'reopened') return { state: 'responded', minutes: Math.round((Date.parse(c.firstResponseAt) - Date.parse(c.createdAt)) / 60000) };
  if (c.status === 'resolved') return { state: 'responded', minutes: null };
  const left = Math.round((due - nowMs) / 60000);
  return { state: left < 0 ? 'overdue' : 'running', minutes: left };
}
