// Strict validation of the model's JSON. Nothing from the model is stored unless it passes every check here.
import { CATEGORIES, URGENCIES } from '../triage.js';

// Pull a JSON object out of the completion (tolerates a fenced block or leading/trailing prose).
export function extractJson(text) {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, error: 'empty response' };
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const candidate = fenced ? fenced[1].trim() : t;
  const tryParse = (s) => { try { return { ok: true, value: JSON.parse(s) }; } catch { return null; } };
  const direct = tryParse(candidate); if (direct) return direct;
  const a = candidate.indexOf('{'); const b = candidate.lastIndexOf('}');
  if (a >= 0 && b > a) { const sliced = tryParse(candidate.slice(a, b + 1)); if (sliced) return sliced; }
  return { ok: false, error: 'response is not valid JSON' };
}

const text = (v, name, min, max, errors) => {
  if (typeof v !== 'string') { errors.push(`${name} must be a string`); return null; }
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length < min) errors.push(`${name} is empty`);
  if (s.length > max) { return s.slice(0, max); } // overlong prose is trimmed, not trusted blindly nor rejected
  return s;
};

// roster: [{id, team, onDuty}] - a staff suggestion is only kept if it names a real, on-duty member of the department.
export function validateClassification(obj, { roster = [] } = {}) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['top level must be a JSON object'] };
  if (!CATEGORIES.includes(obj.category)) errors.push(`category must be one of ${CATEGORIES.join(', ')}`);
  if (!URGENCIES.includes(obj.priority)) errors.push(`priority must be one of ${URGENCIES.join(', ')}`);
  const summary = text(obj.summary, 'summary', 3, 200, errors);
  const explanation = text(obj.explanation, 'explanation', 3, 500, errors);
  const dept = obj.suggested_department;
  if (!CATEGORIES.includes(dept)) errors.push(`suggested_department must be one of ${CATEGORIES.join(', ')}`);
  const conf = obj.confidence;
  if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) errors.push('confidence must be a number between 0 and 1');
  let staffId = null;
  if (obj.suggested_staff_id !== undefined && obj.suggested_staff_id !== null && obj.suggested_staff_id !== '') {
    if (typeof obj.suggested_staff_id !== 'string') errors.push('suggested_staff_id must be a string or null');
    else { const m = roster.find((s) => s.id === obj.suggested_staff_id && s.onDuty && s.team === dept); staffId = m ? m.id : null; }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { category: obj.category, priority: obj.priority, summary, explanation, suggestedDepartment: dept, confidence: Math.round(conf * 100) / 100, suggestedStaffId: staffId } };
}
