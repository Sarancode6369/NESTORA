import test from 'node:test';
import assert from 'node:assert/strict';
import { setupApi } from './helpers.js';
import { suggestDuplicates } from '../server/triage.js';
import { suggestDuplicateComplaints } from '../server/ai/duplicates.js';
import { createGroqClient } from '../server/ai/groq.js';

const KEY = 'gsk_TEST_KEY_NOT_REAL_0123456789abcdef';
const ok = (obj) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] }) });

test('duplicate detection: similar complaints in same category/location are detected, unrelated complaints are not', () => {
  const openComplaints = [
    { id: 'CMP-0001', flatNo: 'T07-1203', tower: 7, category: 'Lift', status: 'open', title: 'Tower 7 elevator stuck on 4th floor', description: 'The lift stopped working and lights are off', createdAt: new Date().toISOString() },
    { id: 'CMP-0002', flatNo: 'T07-1203', tower: 7, category: 'Plumbing', status: 'open', title: 'Water leakage in master bathroom', description: 'Water dripping continuously from ceiling pipe', createdAt: new Date().toISOString() },
    { id: 'CMP-0003', flatNo: 'T12-0408', tower: 12, category: 'Security', status: 'open', title: 'Car parking slot occupied by unknown vehicle', description: 'Unknown car parked in slot B-14', createdAt: new Date().toISOString() },
  ];

  // 1. Similar complaint in same tower and category (Lift)
  const similarLift = suggestDuplicates(openComplaints, {
    title: 'Lift not working in Tower 7',
    description: 'Elevator stopped between floors in Tower 7',
    category: 'Lift',
    tower: 7,
  });
  assert.ok(similarLift.length > 0);
  assert.equal(similarLift[0].id, 'CMP-0001');
  assert.ok(similarLift[0].similarity >= 0.25);
  assert.ok(similarLift[0].explanation.includes('Tower 7'));

  // 2. Completely unrelated complaint (e.g. Painting in Tower 20) does not match
  const unrelated = suggestDuplicates(openComplaints, {
    title: 'Balcony wall paint peeling',
    description: 'Cosmetic paint peeling on the outer balcony railing of Tower 20',
    category: 'Civil',
    tower: 20,
    flatNo: 'T20-0101',
  });
  assert.equal(unrelated.length, 0);
});

test('duplicate detection: semantic comparison with Groq enriches matches and handles API failures gracefully', async () => {
  const openComplaints = [
    { id: 'CMP-0010', flatNo: 'T07-0501', tower: 7, category: 'Plumbing', status: 'open', title: 'Main pipe burst near basement', description: 'Water flooding the basement from burst water line', createdAt: new Date().toISOString() },
  ];

  // Mock Groq semantic comparator returning high confidence duplicate
  const fetchImpl = async () => ok({
    duplicates: [
      { id: 'CMP-0010', isDuplicate: true, similarity: 0.95, explanation: 'Both complaints report the same basement pipe burst causing flooding.' }
    ]
  });
  const groq = createGroqClient({ apiKey: KEY, fetchImpl });

  const candidates = await suggestDuplicateComplaints(openComplaints, {
    title: 'Flooding in basement parking',
    description: 'Heavy water leak from main pipe in basement parking area',
    category: 'Plumbing',
    tower: 7,
  }, { groq });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'CMP-0010');
  assert.equal(candidates[0].needsReview, false);
  assert.ok(candidates[0].similarity >= 0.7);
  assert.match(candidates[0].explanation, /basement pipe burst/);

  // Fallback when Groq fails: returns deterministic keyword score without throwing
  const failingFetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'Groq down' } }) });
  const failingGroq = createGroqClient({ apiKey: KEY, fetchImpl: failingFetch });
  const fallback = await suggestDuplicateComplaints(openComplaints, {
    title: 'Flooding in basement parking',
    description: 'Heavy water leak from main pipe in basement parking area',
    category: 'Plumbing',
    tower: 7,
  }, { groq: failingGroq });

  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].id, 'CMP-0010');
  assert.ok(fallback[0].similarity > 0);
});

test('duplicate suggestion API: resident view strips other residents private flat details; help desk sees flat details', async () => {
  const { call, login, close } = await setupApi();
  try {
    const resident = await login('9000000001'); // Flat T07-1203
    const helpdesk = await login('9000000010');

    // Submit an open complaint from another flat (Swati Joshi, Flat T12-0408)
    const res2 = await login('9000000002');
    const comp = await call('POST', '/api/complaints', {
      token: res2,
      body: {
        title: 'Water pipe leaking in kitchen',
        description: 'Kitchen sink pipe is leaking water continuously on the kitchen floor',
        category: 'Plumbing',
      },
    });
    assert.equal(comp.status, 200);

    // Resident 1 checks for duplicate suggestions with a similar plumbing issue
    const resSuggest = await call('POST', '/api/complaints/duplicates/suggest', {
      token: resident,
      body: {
        title: 'Kitchen water pipe leak',
        description: 'Water pipe leaking from kitchen sink continuously',
        category: 'Plumbing',
      },
    });
    assert.equal(resSuggest.status, 200);
    assert.ok(Array.isArray(resSuggest.body.candidates));
    if (resSuggest.body.candidates.length > 0) {
      const candidate = resSuggest.body.candidates[0];
      assert.equal(candidate.id, comp.body.complaint.id);
      // PRIVACY REQUIREMENT: resident must NOT see other flat's flatNo or tower
      assert.equal(candidate.flatNo, undefined);
      assert.equal(candidate.tower, undefined);
      assert.ok(candidate.title);
      assert.ok(candidate.category);
      assert.ok(candidate.status);
      assert.ok(candidate.explanation);
    }

    // Help Desk checks suggestions: must see flatNo and tower for triage
    const deskSuggest = await call('POST', '/api/complaints/duplicates/suggest', {
      token: helpdesk,
      body: {
        title: 'Kitchen water pipe leak',
        description: 'Water pipe leaking from kitchen sink continuously',
        category: 'Plumbing',
      },
    });
    assert.equal(deskSuggest.status, 200);
    assert.ok(deskSuggest.body.candidates.length > 0);
    assert.equal(deskSuggest.body.candidates[0].flatNo, 'T12-0408');
  } finally {
    await close();
  }
});

test('duplicate linking safety: staff confirmation required, never auto-closed, linked complaints stay open, staff can unlink', async () => {
  const { call, login, close, ctx } = await setupApi();
  try {
    const res1 = await login('9000000001'); // Flat T07-1203, Tower 7
    const res2 = await login('9000000002'); // Flat T12-0408, Tower 12
    const desk = await login('9000000010');

    // Create two complaints in different towers so they are not auto-linked at creation
    const c1 = (await call('POST', '/api/complaints', {
      token: res1,
      body: { title: 'Clubhouse gym AC leaking water', description: 'The split AC unit in the common clubhouse gym is dripping water', category: 'Electrical' },
    })).body.complaint;

    const c2 = (await call('POST', '/api/complaints', {
      token: res2,
      body: { title: 'Gym air conditioner water drip', description: 'Air conditioner in the clubhouse gym has water dripping from the indoor unit', category: 'Electrical' },
    })).body.complaint;

    assert.notEqual(c1.id, c2.id);
    assert.equal(c2.linkedTo, null, 'Must start unlinked');

    // Resident cannot link complaints (403 forbidden)
    const resLinkAttempt = await call('POST', `/api/complaints/${c2.id}/link`, {
      token: res1,
      body: { targetId: c1.id },
    });
    assert.equal(resLinkAttempt.status, 403);

    // Help Desk confirms and links c2 as duplicate of c1
    const linkRes = await call('POST', `/api/complaints/${c2.id}/link`, {
      token: desk,
      body: { targetId: c1.id, reason: 'Confirmed duplicate report of clubhouse gym AC leak' },
    });
    assert.equal(linkRes.status, 200);
    assert.equal(linkRes.body.complaint.linkedTo, c1.id);

    // CRITICAL SAFETY CHECK: neither complaint was closed!
    const dbC1 = await ctx.r.complaints.get(c1.id);
    const dbC2 = await ctx.r.complaints.get(c2.id);
    assert.notEqual(dbC1.status, 'resolved', 'Original complaint must remain open');
    assert.notEqual(dbC2.status, 'resolved', 'Duplicate complaint must remain open');
    assert.equal(dbC2.linkedTo, c1.id);

    // Check audit trail
    const audits = (await call('GET', '/api/audit', { token: desk })).body.audit;
    assert.ok(audits.some((a) => a.action === 'complaint.link' && a.detail.targetId === c1.id));

    // Staff can unlink if duplicate link was incorrect
    const unlinkRes = await call('POST', `/api/complaints/${c2.id}/unlink`, { token: desk });
    assert.equal(unlinkRes.status, 200);
    assert.equal(unlinkRes.body.complaint.linkedTo, null);

    const dbC2After = await ctx.r.complaints.get(c2.id);
    assert.equal(dbC2After.linkedTo, null);

    // Linking to self must be rejected
    const selfLink = await call('POST', `/api/complaints/${c1.id}/link`, {
      token: desk,
      body: { targetId: c1.id },
    });
    assert.equal(selfLink.status, 400);

    // Non-existent target complaint must return 404
    const notFoundLink = await call('POST', `/api/complaints/${c1.id}/link`, {
      token: desk,
      body: { targetId: 'CMP-9999' },
    });
    assert.equal(notFoundLink.status, 404);
  } finally {
    await close();
  }
});

test('duplicate linking safety: prevents duplicate links, circular relationships, and linking to resolved complaints', async () => {
  const { call, login, close, ctx } = await setupApi();
  try {
    const res1 = await login('9000000001'); // Flat T07-1203
    const res2 = await login('9000000002'); // Flat T12-0408
    const desk = await login('9000000010');

    const c1 = (await call('POST', '/api/complaints', {
      token: res1,
      body: { title: 'Main gate boom barrier broken', description: 'Boom barrier at main security gate is stuck open', category: 'Security' },
    })).body.complaint;

    const c2 = (await call('POST', '/api/complaints', {
      token: res2,
      body: { title: 'Security boom barrier malfunction', description: 'Car barrier at main gate not descending', category: 'Security' },
    })).body.complaint;

    const c3 = (await call('POST', '/api/complaints', {
      token: res1,
      body: { title: 'Main gate barrier damaged', description: 'Vehicles passing through without barrier check', category: 'Security' },
    })).body.complaint;

    // 1. Link c2 to c1
    const linkRes = await call('POST', `/api/complaints/${c2.id}/link`, {
      token: desk,
      body: { targetId: c1.id, reason: 'Duplicate gate report' },
    });
    assert.equal(linkRes.status, 200);

    // 2. Prevent duplicate link: attempting to link c2 to c1 again must be rejected (400)
    const dupeLink = await call('POST', `/api/complaints/${c2.id}/link`, {
      token: desk,
      body: { targetId: c1.id },
    });
    assert.equal(dupeLink.status, 400);
    assert.match(dupeLink.body.error, /already linked/i);

    // 3. Link c3 to c2 (links to root c1)
    const linkC3 = await call('POST', `/api/complaints/${c3.id}/link`, {
      token: desk,
      body: { targetId: c2.id },
    });
    assert.equal(linkC3.status, 200);
    assert.equal(linkC3.body.complaint.linkedTo, c1.id, 'Should resolve to canonical root c1');

    // 4. Prevent circular link: attempting to link c1 to c3 or c2 must be rejected (400)
    const circularLink = await call('POST', `/api/complaints/${c1.id}/link`, {
      token: desk,
      body: { targetId: c3.id },
    });
    assert.equal(circularLink.status, 400);
    assert.match(circularLink.body.error, /circular/i);

    // 5. Prevent linking to a resolved complaint
    // Resolve a dummy complaint
    const resolvedComp = (await call('POST', '/api/complaints', {
      token: res1,
      body: { title: 'Old resolved bulb replacement', description: 'Corridor bulb replacement done', category: 'Electrical' },
    })).body.complaint;
    await call('PATCH', `/api/complaints/${resolvedComp.id}/status`, { token: desk, body: { status: 'resolved' } });

    const linkResolved = await call('POST', `/api/complaints/${c1.id}/link`, {
      token: desk,
      body: { targetId: resolvedComp.id },
    });
    assert.equal(linkResolved.status, 400);
    assert.match(linkResolved.body.error, /resolved/i);
  } finally {
    await close();
  }
});

test('duplicate linking: preserves emergency priorities, resident ownership, photos, and records audit trail on link & unlink', async () => {
  const { call, login, close, ctx } = await setupApi();
  try {
    const res1 = await login('9000000001'); // Flat T07-1203
    const res2 = await login('9000000002'); // Flat T12-0408
    const desk = await login('9000000010');

    // 1. Resident 1 reports an EMERGENCY (electric shock risk)
    const emgComp = (await call('POST', '/api/complaints', {
      token: res1,
      body: {
        title: 'Exposed wire sparking electric shock hazard',
        description: 'Exposed live wire sparking in corridor near flat T07-1203 electric shock danger',
        category: 'Electrical',
      },
    })).body.complaint;

    assert.equal(emgComp.urgency, 'Emergency');
    assert.equal(emgComp.status, 'escalated');

    // 2. Resident 2 reports a related complaint
    const relComp = (await call('POST', '/api/complaints', {
      token: res2,
      body: {
        title: 'Sparking wire on 12th floor corridor',
        description: 'Electrical sparking seen near corridor switchboard',
        category: 'Electrical',
      },
    })).body.complaint;

    // 3. Link related complaint to emergency complaint
    const linkRes = await call('POST', `/api/complaints/${relComp.id}/link`, {
      token: desk,
      body: { targetId: emgComp.id, reason: 'Duplicate hazard report' },
    });
    assert.equal(linkRes.status, 200);

    // 4. Verify EMERGENCY status and priority are completely preserved on both records
    const checkEmg = (await call('GET', `/api/complaints/${emgComp.id}`, { token: desk })).body.complaint;
    const checkRel = (await call('GET', `/api/complaints/${relComp.id}`, { token: desk })).body.complaint;

    assert.equal(checkEmg.urgency, 'Emergency', 'Emergency priority must never be changed by linking');
    assert.equal(checkEmg.status, 'escalated', 'Escalation status must be preserved');
    assert.equal(checkEmg.flatNo, 'T07-1203', 'Resident flat ownership preserved');
    assert.equal(checkRel.flatNo, 'T12-0408', 'Resident flat ownership preserved');
    assert.notEqual(checkRel.status, 'resolved', 'Duplicate complaint must NOT be resolved');

    // 5. Verify histories on both complaints
    assert.ok(checkRel.history.some((h) => h.action === 'linked' && h.detail.includes(emgComp.id)));
    assert.ok(checkEmg.history.some((h) => h.action === 'linked-by' && h.detail.includes(relComp.id)));

    // 6. Unlink and verify audit history on both complaints
    const unlinkRes = await call('POST', `/api/complaints/${relComp.id}/unlink`, { token: desk });
    assert.equal(unlinkRes.status, 200);

    const checkRelAfter = (await call('GET', `/api/complaints/${relComp.id}`, { token: desk })).body.complaint;
    const checkEmgAfter = (await call('GET', `/api/complaints/${emgComp.id}`, { token: desk })).body.complaint;

    assert.equal(checkRelAfter.linkedTo, null);
    assert.ok(checkRelAfter.history.some((h) => h.action === 'unlinked' && h.detail.includes(emgComp.id)));
    assert.ok(checkEmgAfter.history.some((h) => h.action === 'unlinked-by' && h.detail.includes(relComp.id)));

    // 7. Verify audit_logs table contains complaint.unlink
    const audits = (await call('GET', '/api/audit', { token: desk })).body.audit;
    assert.ok(audits.some((a) => a.action === 'complaint.unlink' && a.detail.complaintId === relComp.id));
  } finally {
    await close();
  }
});

test('duplicate detection: location context parses block, floor, and shared facilities accurately', async () => {
  const openComplaints = [
    {
      id: 'CMP-0050',
      flatNo: 'T07-1203',
      tower: 7,
      category: 'Plumbing',
      status: 'open',
      title: 'Ceiling leakage in 12th floor corridor',
      description: 'Water dripping from the false ceiling on the 12th floor outside flat 1203',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'CMP-0051',
      flatNo: 'T15-0907',
      tower: 15,
      category: 'Civil',
      status: 'open',
      title: 'Clubhouse swimming pool tile loose',
      description: 'Loose tiles near the clubhouse pool deck posing trip hazard',
      createdAt: new Date().toISOString(),
    },
  ];

  // 1. Same tower and same floor (Floor 12, Tower 7) with overlapping plumbing issue
  const floorMatch = await suggestDuplicateComplaints(openComplaints, {
    title: 'Water seepage near 12th floor lobby',
    description: 'Floor 12 corridor near Tower 7 has water seepage from ceiling pipe',
    category: 'Plumbing',
    flatNo: 'T07-1205',
    tower: 7,
  });

  assert.ok(floorMatch.length > 0);
  assert.equal(floorMatch[0].id, 'CMP-0050');
  assert.ok(floorMatch[0].similarity >= 0.4);
  assert.match(floorMatch[0].explanation, /Floor 12|Tower 7/);

  // 2. Shared facility (Clubhouse) reported from a different flat
  const facilityMatch = await suggestDuplicateComplaints(openComplaints, {
    title: 'Broken tile at swimming pool in clubhouse',
    description: 'Tile broken along the edge of the clubhouse swimming pool area',
    category: 'Civil',
    flatNo: 'T03-0502',
    tower: 3,
  });

  assert.ok(facilityMatch.length > 0);
  assert.equal(facilityMatch[0].id, 'CMP-0051');
  assert.ok(facilityMatch[0].similarity >= 0.4);
  assert.match(facilityMatch[0].explanation, /Clubhouse|swimming pool/i);
});
