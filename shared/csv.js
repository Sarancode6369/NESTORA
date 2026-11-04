// Minimal RFC-4180 style CSV parser, shared by server and browser (no dependencies).

export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export function normHeader(h) {
  return String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Accepted header aliases -> canonical column
const ALIASES = {
  date: ['date', 'txn date', 'transaction date', 'value date', 'posting date'],
  description: ['description', 'narration', 'particulars', 'remarks', 'transaction remarks'],
  reference: ['reference', 'ref', 'ref no', 'reference no', 'utr', 'chq ref no', 'payment reference'],
  upi: ['upi id', 'upi', 'vpa', 'payer upi'],
  credit: ['credit', 'deposit', 'deposit amt', 'credit amount', 'cr'],
  debit: ['debit', 'withdrawal', 'withdrawal amt', 'debit amount', 'dr'],
};

export const REQUIRED_COLUMNS = ['date', 'description', 'credit'];

export function mapHeaders(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => {
    const n = normHeader(h);
    for (const [canon, list] of Object.entries(ALIASES)) {
      if (idx[canon] === undefined && list.includes(n)) idx[canon] = i;
    }
  });
  const missing = REQUIRED_COLUMNS.filter((c) => idx[c] === undefined);
  return { idx, missing };
}

export function parseAmount(value) {
  if (value === undefined || value === null) return 0;
  let s = String(value).trim();
  if (s === '' || s === '-') return 0;
  s = s.replace(/₹|rs\.?|inr/gi, '').replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100) / 100;
}

// Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD-Mon-YYYY. Returns ISO date or null.
export function parseDate(value) {
  const s = String(value ?? '').trim();
  let y, m, d;
  let mt;
  if ((mt = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) [, y, m, d] = mt;
  else if ((mt = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s))) [, d, m, y] = mt;
  else if ((mt = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{4})/.exec(s))) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mi = months.indexOf(mt[2].toLowerCase());
    if (mi < 0) return null;
    [d, y] = [mt[1], mt[3]];
    m = mi + 1;
  } else return null;
  y = +y; m = +m; d = +d;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Returns { ok, missing, rows:[{line, date, description, reference, upi, credit, debit}], errors:[{line,error}], totalLines }
export function parseBankStatement(text) {
  const table = parseCsv(text);
  if (table.length === 0) return { ok: false, missing: REQUIRED_COLUMNS, rows: [], errors: [{ line: 0, error: 'File is empty' }], totalLines: 0 };
  const { idx, missing } = mapHeaders(table[0]);
  if (missing.length) return { ok: false, missing, rows: [], errors: [], totalLines: table.length - 1, headers: table[0] };
  const rows = [];
  const errors = [];
  for (let r = 1; r < table.length; r++) {
    const line = r + 1;
    const cells = table[r];
    const get = (k) => (idx[k] === undefined ? '' : String(cells[idx[k]] ?? '').trim());
    const date = parseDate(get('date'));
    const credit = parseAmount(get('credit'));
    const debit = parseAmount(get('debit'));
    if (!date) { errors.push({ line, error: `Invalid date "${get('date')}"` }); continue; }
    if (Number.isNaN(credit) || Number.isNaN(debit)) { errors.push({ line, error: 'Invalid amount' }); continue; }
    if (credit < 0 || debit < 0) { errors.push({ line, error: 'Negative amount' }); continue; }
    rows.push({ line, date, description: get('description'), reference: get('reference'), upi: get('upi'), credit, debit });
  }
  return { ok: true, missing: [], rows, errors, totalLines: table.length - 1 };
}
