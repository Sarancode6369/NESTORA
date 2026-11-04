// Small helpers shared by the repositories: timestamp / JSON / boolean conversion and error mapping.
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Timestamps are stored as UTC "YYYY-MM-DD HH:MM:SS.mmm" and exposed to the app as ISO-8601 strings.
export const toDb = (iso) => (iso == null ? null : new Date(iso).toISOString().slice(0, 23).replace('T', ' '));
export const fromDb = (s) => {
  if (s == null) return null;
  if (s instanceof Date) return s.toISOString();
  return `${String(s).replace(' ', 'T').replace(/Z$/, '')}Z`.replace(/(\.\d{3})\d*Z$/, '$1Z').replace(/T(\d\d:\d\d:\d\d)Z$/, 'T$1.000Z');
};
export const ymdOut = (s) => (s == null ? null : String(s).slice(0, 10));
export const jsonOut = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
export const jsonIn = (v, fallback = null) => {
  if (v == null) return fallback;
  if (typeof v === 'object') return v; // mysql2 already parses JSON columns
  try { return JSON.parse(v); } catch { return fallback; }
};
export const bool = (v) => (v ? 1 : 0);
export const num = (v) => (v == null ? null : Number(v));

// Canonical form of a payment reference / UTR: upper-case letters and digits only.
export const normRef = (s) => { const t = String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return t || null; };

export const isDuplicateError = (e) => !!e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062 || /UNIQUE constraint failed/i.test(e.message || ''));
