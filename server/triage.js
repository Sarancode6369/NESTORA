// Automated complaint triage: category, urgency, summary, duplicate linking, staff suggestion.
//
// Honest note: this is a transparent weighted-keyword model (English / Hindi / Marathi), not a hosted LLM.
// Every output is a *suggestion* (confidence + reasons) that a help-desk person can change in one action.
// Safety rules run FIRST, are plain regular expressions, and always override the model.

export const CATEGORIES = ['Plumbing', 'Electrical', 'Lift', 'Security', 'Cleaning', 'Civil', 'Other'];
export const URGENCIES = ['Low', 'Medium', 'High', 'Emergency'];

// ---- Safety rules (deterministic, never depend on the classifier) ----
// JS \b is ASCII-only, so Devanagari terms use explicit letter/mark lookarounds (u flag).
const DEV_L = '(?<![\\p{L}\\p{M}])';
const DEV_R = '(?![\\p{L}\\p{M}])';
export const SAFETY_RULES = [
  { id: 'fire', label: 'Fire', category: 'Other', re: new RegExp(String.raw`\b(fire|fires|flames?|caught fire|on fire)\b|${DEV_L}(आग|आगी)${DEV_R}`, 'iu') },
  { id: 'gas_leak', label: 'Gas leak', category: 'Other', re: new RegExp(String.raw`\bgas\s+(is\s+)?(leak\w*|smell\w*)|\bsmell\w*\s+(of\s+)?gas\b|\blpg\s+leak|गैस\s*(लीक|रिसाव|गळती|वास)`, 'iu') },
  { id: 'lift_stuck', label: 'Lift stuck', category: 'Lift', re: new RegExp(String.raw`\b(lift|elevator)\b[^.\n]{0,50}\b(stuck|trapped|entrap\w*|struck|stopped between)\b|\b(stuck|trapped|entrap\w*)\b[^.\n]{0,40}\b(in|inside)\s+(the\s+|a\s+)?(lift|elevator)\b|लिफ्ट[^.\n]{0,30}(फंस|अटक|अडक)|(फंस|अडक)[^.\n]{0,20}लिफ्ट`, 'iu') },
  { id: 'electric_shock', label: 'Electric shock', category: 'Electrical', re: new RegExp(String.raw`\b(electric(al)?\s+)?shock(ed|s)?\b|\belectrocut\w*|current\s+(laga|lag\s*gaya|lagla)|करंट|शॉक`, 'iu') },
];

export function checkSafety(text) {
  const hits = [];
  for (const r of SAFETY_RULES) if (r.re.test(text)) hits.push(r);
  return hits;
}

// ---- Weighted keywords per category ----
const KW = {
  Plumbing: ['leak', 'leaking', 'leakage', 'seepage', 'water', 'pipe', 'tap', 'drain', 'drainage', 'sewage', 'overflow', 'flush', 'toilet', 'bathroom', 'geyser', 'clog', 'blocked', 'plumb', 'tank', 'motor', 'pressure', 'पानी', 'लीक', 'नल', 'पाइप', 'नाली', 'गळती', 'नळ', 'पाईप', 'गटार', 'टाकी'],
  Electrical: ['electric', 'power', 'light', 'bulb', 'switch', 'socket', 'wire', 'wiring', 'spark', 'sparking', 'mcb', 'fuse', 'short circuit', 'voltage', 'fan', 'ac ', 'inverter', 'meter', 'बिजली', 'लाइट', 'स्विच', 'तार', 'वीज', 'दिवा', 'पंखा'],
  Lift: ['lift', 'elevator', 'lifts', 'floor button', 'lobby lift', 'लिफ्ट'],
  Cleaning: ['garbage', 'trash', 'dustbin', 'dirty', 'clean', 'cleaning', 'sweep', 'sweeping', 'mop', 'smell', 'stink', 'waste', 'litter', 'stairs', 'staircase', 'corridor', 'pest', 'cockroach', 'mosquito', 'garden', 'कचरा', 'सफाई', 'गंदगी', 'कचरा', 'स्वच्छता', 'घाण'],
  Civil: ['crack', 'cracks', 'cracked', 'plaster', 'dampness', 'tile', 'tiles', 'roof', 'slab', 'structural', 'structure', 'balcony', 'railing', 'compound wall', 'pothole', 'footpath', 'waterlogging', 'paint peeling', 'दरार', 'दीवार', 'भिंत', 'तडा'],
  Security: ['security', 'guard', 'gate', 'visitor', 'stranger', 'theft', 'stolen', 'intruder', 'cctv', 'suspicious', 'parking', 'unauthorised', 'unauthorized', 'trespass', 'बाहरी', 'चोरी', 'सुरक्षा', 'गार्ड', 'चोरी', 'पार्किंग'],
};
const HIGH_WORDS = ['flood', 'flooding', 'overflowing', 'no water', 'no power', 'power cut', 'blackout', 'sparking', 'spark', 'short circuit', 'burning', 'sewage', 'theft', 'stolen', 'intruder', 'elderly', 'child', 'pregnant', 'urgent', 'emergency', 'all flats', 'whole tower', 'entire tower', 'since morning', 'since yesterday', 'बाढ़', 'तुरंत', 'आपातकाल', 'चोरी', 'अर्जंट', 'तातडीने'];
const LOW_WORDS = ['suggestion', 'request', 'minor', 'whenever', 'not urgent', 'when possible', 'paint', 'faded', 'scratch', 'cosmetic', 'please check when'];
const STOP = new Set('the a an is are was were be been to of in on at for and or but my our your this that it its with from by as have has had not no please kindly sir madam flat tower since there here very also been into than then them they we you i me can could would should will do does did get got any all some one two still again day days today yesterday morning evening night'.split(' '));

function tokens(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
}

function scoreCategories(text) {
  const lower = ` ${text.toLowerCase()} `;
  const scores = Object.fromEntries(Object.keys(KW).map((k) => [k, 0]));
  const evidence = Object.fromEntries(Object.keys(KW).map((k) => [k, []]));
  for (const [cat, words] of Object.entries(KW)) {
    for (const w of words) {
      const isLatin = /^[a-z ]+$/.test(w);
      const hit = isLatin ? new RegExp(`(^|[^a-z])${w.trim().replace(/ /g, '\\s+')}`, 'i').test(lower) : lower.includes(w);
      if (hit) {
        const weight = cat === 'Lift' ? 3 : w.length > 6 ? 2 : 1;
        scores[cat] += weight;
        evidence[cat].push(w.trim());
      }
    }
  }
  return { scores, evidence };
}

// Main entry. Never throws: on any failure returns a safe fallback flagged for human review.
export function classifyComplaint({ title = '', description = '', residentCategory = null }) {
  const text = `${title}. ${description}`.trim();
  let safety = [];
  try { safety = checkSafety(text); } catch { /* regex failure must never block */ }
  let ai;
  try {
    const { scores, evidence } = scoreCategories(text);
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [topCat, topScore] = ranked[0];
    const second = ranked[1][1];
    let category = topScore > 0 ? topCat : 'Other';
    let confidence = topScore === 0 ? 0.2 : Math.min(0.95, 0.35 + 0.6 * (topScore - second) / (topScore + 1) + Math.min(0.2, topScore * 0.04));
    const reasons = [];
    if (topScore > 0) reasons.push(`Matched ${category.toLowerCase()} terms: ${evidence[topCat].slice(0, 4).join(', ')}`);
    else reasons.push('No category keywords recognised');
    if (topScore > 0 && topScore === second) { confidence = Math.min(confidence, 0.45); reasons.push(`Ambiguous between ${topCat} and ${ranked[1][0]}`); }

    const lower = ` ${text.toLowerCase()} `;
    let urgency = 'Medium';
    const high = HIGH_WORDS.filter((w) => lower.includes(w));
    const low = LOW_WORDS.filter((w) => lower.includes(w));
    if (high.length) { urgency = 'High'; reasons.push(`Urgency cues: ${high.slice(0, 3).join(', ')}`); }
    else if (low.length && !high.length) { urgency = 'Low'; reasons.push(`Low-urgency cues: ${low.slice(0, 2).join(', ')}`); }
    ai = { category, urgency, confidence: Math.round(confidence * 100) / 100, reasons };
  } catch (e) {
    ai = { category: 'Other', urgency: 'Medium', confidence: 0, reasons: ['Automatic triage failed; safe fallback used'], failed: true };
  }

  const result = {
    aiCategory: ai.category, aiUrgency: ai.urgency, confidence: ai.confidence, reasons: ai.reasons,
    category: residentCategory && CATEGORIES.includes(residentCategory) ? residentCategory : ai.category,
    urgency: ai.urgency, needsReview: false, reviewReasons: [],
    safety: { triggered: false, rules: [] }, summary: summarize(title, description, ai.category),
  };
  if (ai.failed) { result.needsReview = true; result.reviewReasons.push('Automatic triage unavailable'); }
  if (ai.confidence < 0.6) { result.needsReview = true; result.reviewReasons.push('Low classifier confidence'); }
  if (residentCategory && CATEGORIES.includes(residentCategory) && residentCategory !== ai.category && ai.confidence >= 0.5) {
    result.needsReview = true; result.reviewReasons.push(`Resident chose ${residentCategory}; automated suggestion was ${ai.category}`);
  }
  if (safety.length) {
    // Rule-based escalation overrides everything the classifier said.
    result.safety = { triggered: true, rules: safety.map((s) => s.id), labels: safety.map((s) => s.label) };
    result.urgency = 'Emergency';
    result.category = safety[0].category;
    result.needsReview = true;
    result.reviewReasons.unshift(`Safety rule: ${safety.map((s) => s.label).join(', ')} - escalated to duty manager`);
  }
  return result;
}

export function summarize(title, description, category) {
  const first = String(description || '').trim().split(/(?<=[.!?])\s+/)[0] || '';
  const body = first.length > 140 ? first.slice(0, 137) + '...' : first;
  return `${String(title).trim()}${body && !body.startsWith(String(title).trim()) ? ' - ' + body : ''}`.slice(0, 200);
}

export function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Find an existing open complaint this one repeats. Linking only; never closes anything.
// `open` is the list of currently open complaints (light rows). Returns the best candidate or null; the
// caller resolves the root of any existing chain.
export function findDuplicate(open, c, nowMs) {
  const text = `${c.title} ${c.description}`;
  let best = null;
  for (const o of open) {
    if (o.id === c.id || o.status === 'resolved') continue;
    if (nowMs - Date.parse(o.createdAt) > 7 * 86400000) continue;
    if (o.category !== c.category) continue;
    const sim = similarity(text, `${o.title} ${o.description}`);
    const sameTower = o.tower === c.tower;
    const sameFlat = o.flatNo === c.flatNo;
    const match = (sameFlat && sim >= 0.4) || (sameTower && sim >= 0.25) || (sameTower && c.category === 'Lift' && sim >= 0.12);
    if (match && (!best || sim > best.sim)) best = { o, sim };
  }
  return best ? { candidate: best.o, similarity: Math.round(best.sim * 100) / 100 } : null;
}

// Find multiple potential duplicates with explanations for staff review or resident warnings.
export function suggestDuplicates(open, c, nowMs = Date.now(), { maxCandidates = 5 } = {}) {
  const text = `${c.title || ''} ${c.description || ''}`.trim();
  const scored = [];
  for (const o of open) {
    if (c.id && o.id === c.id) continue;
    if (o.status === 'resolved') continue;
    const candText = `${o.title} ${o.description}`;
    const sim = similarity(text, candText);
    const sameCat = c.category && o.category ? c.category === o.category : false;
    const sameFlat = c.flatNo && o.flatNo ? c.flatNo === o.flatNo : false;
    const sameTower = c.tower && o.tower ? c.tower === o.tower : false;

    let baseScore = sim;
    if (sameCat) baseScore += 0.15;
    if (sameFlat) baseScore += 0.25;
    else if (sameTower) baseScore += 0.1;
    if (c.category === 'Lift' && sameTower) baseScore += 0.15;

    if (baseScore < 0.2 && sim < 0.2) continue;

    let explanation = '';
    if (sameFlat && sim >= 0.3) {
      explanation = `Similar issue reported in flat ${o.flatNo} (${Math.round(sim * 100)}% text match)`;
    } else if (sameTower && c.category === 'Lift') {
      explanation = `Tower ${o.tower} lift issue already reported in ${o.id}`;
    } else if (sameTower && sameCat) {
      explanation = `Same tower and ${o.category} category (${Math.round(sim * 100)}% match)`;
    } else if (sameCat && sim >= 0.25) {
      explanation = `Similar ${o.category} issue reported (${Math.round(sim * 100)}% match)`;
    } else {
      explanation = `Possible overlapping issue (${Math.round(sim * 100)}% keyword similarity)`;
    }

    scored.push({
      complaint: o,
      similarity: Math.round(Math.min(0.99, baseScore) * 100) / 100,
      explanation,
    });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, maxCandidates).map((s) => ({
    id: s.complaint.id,
    title: s.complaint.title,
    category: s.complaint.category,
    status: s.complaint.status,
    urgency: s.complaint.urgency || s.complaint.priority,
    flatNo: s.complaint.flatNo,
    tower: s.complaint.tower,
    createdAt: s.complaint.createdAt,
    similarity: s.similarity,
    explanation: s.explanation,
    needsReview: s.similarity < 0.6,
  }));
}

export const SLA_MINUTES = { Emergency: 15, High: 120, Medium: 480, Low: 1440 };

// Least-loaded on-duty staff member of the department. `load` maps staffId -> open complaints.
export function suggestStaff(staff, load, category) {
  const pool = staff.filter((s) => s.team === category && s.onDuty);
  if (!pool.length) return null;
  return pool.map((s) => ({ s, l: load[s.id] || 0 })).sort((a, b) => a.l - b.l || a.s.id.localeCompare(b.s.id))[0].s;
}
