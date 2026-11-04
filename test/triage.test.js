import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyComplaint, checkSafety, similarity } from '../server/triage.js';
import { createComplaint, changeCategory } from '../server/complaints.js';
import { makeCtx } from './helpers.js';

const cls = (title, description = '', residentCategory = null) => classifyComplaint({ title, description, residentCategory });

test('classifies the main categories', () => {
  assert.equal(cls('Tap leaking', 'Kitchen tap leaking, water on floor').category, 'Plumbing');
  assert.equal(cls('Light not working', 'Corridor bulb fused, switch faulty').category, 'Electrical');
  assert.equal(cls('Lift not working', 'Lift is out of order').category, 'Lift');
  assert.equal(cls('Garbage', 'Garbage not collected and dirty staircase').category, 'Cleaning');
  assert.equal(cls('Stranger at gate', 'Guard let a stranger in at the gate').category, 'Security');
});
test('unrecognised text falls back to Other and is flagged for review', () => {
  const r = cls('Hello', 'Something odd'); assert.equal(r.category, 'Other'); assert.equal(r.needsReview, true);
});
test('safety words always escalate to Emergency, overriding the classifier and resident choice', () => {
  for (const [t, d, id] of [['Fire', 'There is a fire in the parking', 'fire'], ['Smell', 'I can smell gas in the kitchen, gas leak', 'gas_leak'], ['Help', 'Someone is stuck in the lift', 'lift_stuck'], ['Switch', 'My child got an electric shock from the switch', 'electric_shock']]) {
    const r = cls(t, d, 'Cleaning');
    assert.equal(r.urgency, 'Emergency', t); assert.equal(r.safety.triggered, true, t); assert.ok(r.safety.rules.includes(id), t); assert.equal(r.needsReview, true);
  }
});
test('safety rule works in Hindi and does not fire on ordinary text', () => {
  assert.ok(checkSafety('बिल्डिंग में आग लग गई').length > 0);
  assert.equal(checkSafety('The garden lights are fine, no problem. Fireplace decor request').length, 0);
  assert.equal(checkSafety('Lift is slow today').length, 0);
});
test('classifier failure yields a safe fallback, never throws', () => {
  const r = classifyComplaint({ title: null, description: undefined });
  assert.ok(r.category); assert.ok(r.urgency);
});
test('similarity', () => { assert.ok(similarity('lift not working tower 3', 'tower 3 lift is not working') > 0.5); assert.ok(similarity('water leak', 'garbage dirty') < 0.1); });

test('safety escalation persists status escalated and notifies the duty manager (mock)', async () => {
  const s = await makeCtx(); const u = await s.user('9000000003');
  const c = await createComplaint(s.r, { flatNo: 'T21-1601', title: 'Lift stuck', description: 'We are stuck in the lift between floors' }, u, s.clock());
  assert.equal(c.status, 'escalated'); assert.equal(c.urgency, 'Emergency'); assert.ok(c.escalatedTo);
  const again = await s.r.complaints.get(c.id); // read back from the database
  assert.equal(again.status, 'escalated'); assert.equal(again.safety.triggered, true);
  assert.ok((await s.r.core.recentNotifications()).some((n) => /SAFETY ESCALATION/.test(n.message) && n.mock));
  await s.close();
});
test('duplicates are linked to the original, never closed (ten flats, one lift)', async () => {
  const s = await makeCtx(); const u = await s.user('9000000001');
  const first = await createComplaint(s.r, { flatNo: 'T07-1203', title: 'Lift not working', description: 'Tower 7 lift is not working' }, u, s.clock());
  const second = await createComplaint(s.r, { flatNo: 'T07-1203', title: 'Lift not working again', description: 'Lift in tower 7 not working' }, u, s.clock());
  assert.equal(second.linkedTo, first.id); assert.notEqual(second.status, 'resolved');
  const f = await s.r.complaints.get(first.id); assert.notEqual(f.status, 'resolved'); assert.equal(f.linkedCount, 1);
  const list = await s.r.complaints.list(); assert.ok(list.some((x) => x.id === second.id), 'duplicates stay visible');
  await s.close();
});
test('unrelated complaints are not linked', async () => {
  const s = await makeCtx(); const u = await s.user('9000000004') || await s.user('9000000001');
  const a = await createComplaint(s.r, { flatNo: 'T03-0502', title: 'Garbage', description: 'Garbage not collected' }, u, s.clock());
  const b = await createComplaint(s.r, { flatNo: 'T03-0502', title: 'Tap leaking', description: 'Bathroom tap leaking badly' }, u, s.clock());
  assert.equal(b.linkedTo, null);
  await s.close();
});
test('help desk can change category in one action; review flag clears; correction is audited', async () => {
  const s = await makeCtx(); const u = await s.user('9000000001'); const desk = await s.user('9000000010');
  const c = await createComplaint(s.r, { flatNo: 'T03-0502', title: 'Hello', description: 'Something odd' }, u, s.clock());
  assert.equal(c.needsReview, true);
  await changeCategory(s.r, c, 'Plumbing', desk, s.clock());
  const back = await s.r.complaints.get(c.id);
  assert.equal(back.category, 'Plumbing'); assert.equal(back.needsReview, false); assert.ok(back.categoryConfirmedBy); assert.equal(back.classificationMethod, 'manual');
  const corr = await s.r.complaints.corrections(c.id);
  assert.equal(corr.length, 1); assert.equal(corr[0].oldValue, 'Other'); assert.equal(corr[0].newValue, 'Plumbing'); assert.equal(corr[0].methodBefore, 'keyword_fallback'); assert.equal(corr[0].by, desk.id);
  assert.ok((await s.r.core.recentAudit(10)).some((a) => a.action === 'complaint.correct'));
  await s.close();
});
