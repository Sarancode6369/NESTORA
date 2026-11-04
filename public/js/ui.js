// UI helpers: safe html templating, api client, toasts, modals, formatting.
import { t } from './i18n.js';

class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const render = (v) => (v instanceof Safe ? v.s : Array.isArray(v) ? v.map(render).join('') : v === null || v === undefined || v === false ? '' : esc(v));
// Every interpolation is escaped unless it is itself the output of h``. This is what keeps complaint text from becoming markup.
export const h = (strings, ...vals) => new Safe(strings.reduce((a, s, i) => a + s + (i < vals.length ? render(vals[i]) : ''), ''));
export const raw = (s) => new Safe(s);
export const mount = (el, safe) => { el.innerHTML = safe instanceof Safe ? safe.s : String(safe); };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- session ----
const KEY = 'nestora.session';
export const session = { token: null, user: null };
try { Object.assign(session, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* storage may be blocked */ }
export function setSession(token, user) { session.token = token; session.user = user; try { token ? localStorage.setItem(KEY, JSON.stringify({ token, user })) : localStorage.removeItem(KEY); } catch { /* ignore */ } }

// ---- api ----
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(session.token ? { Authorization: 'Bearer ' + session.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { const err = new Error(t('offline_err')); err.offline = true; throw err; }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && session.token) { setSession(null, null); location.hash = '#/login'; }
    const err = new Error(data?.error || `Request failed (${res.status})`); err.status = res.status; err.details = data?.details; throw err;
  }
  return data;
}

// ---- feedback ----
export function toast(msg, kind = '') {
  let box = $('.toasts'); if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const el = document.createElement('div'); el.className = 'toast ' + kind; el.textContent = msg; box.append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, kind === 'bad' ? 5000 : 3200);
}
let lastFocus = null;
export function openModal(content, { wide = false, drawer = false, onClose, label = '' } = {}) {
  lastFocus = document.activeElement;
  const ov = document.createElement('div'); ov.className = 'overlay' + (drawer ? ' drawer' : '');
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(label)}" tabindex="-1">${content instanceof Safe ? content.s : content}</div>`;
  document.body.append(ov); document.body.style.overflow = 'hidden';
  const modal = ov.firstElementChild;
  const close = () => { ov.remove(); if (!$('.overlay')) document.body.style.overflow = ''; document.removeEventListener('keydown', key); onClose?.(); lastFocus?.focus?.(); };
  const key = (e) => { if (e.key === 'Escape') close(); if (e.key === 'Tab') { const f = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', modal).filter((x) => !x.disabled && x.offsetParent !== null); if (!f.length) return; const first = f[0], last = f[f.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } };
  document.addEventListener('keydown', key);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  modal.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  setTimeout(() => (modal.querySelector('[autofocus]') || modal).focus(), 30);
  return { close, el: modal };
}
export function confirmDialog({ title, body, confirm = t('confirm'), danger = false }) {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const m = openModal(h`<h3>${title}</h3><p class="muted" style="margin:10px 0 22px">${body}</p><div class="row" style="justify-content:flex-end"><button class="btn" data-close>${t('cancel')}</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cf-ok" autofocus>${confirm}</button></div>`, { onClose: () => fin(false) });
    m.el.querySelector('#cf-ok').onclick = () => { fin(true); m.close(); };
  });
}
export async function busy(btn, fn) {
  const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = orig; }
}
const bar = () => { let b = $('.loadbar'); if (!b) { b = document.createElement('div'); b.className = 'loadbar'; document.body.append(b); } return b; };
export function progress(on) { const b = bar(); if (on) { b.style.opacity = 1; b.style.width = '70%'; } else { b.style.width = '100%'; setTimeout(() => { b.style.opacity = 0; b.style.width = '0'; }, 250); } }

// ---- formatting ----
export const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(+n) ? 0 : 2, maximumFractionDigits: 2 });
export const dateFmt = (d) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
export const timeFmt = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-');
export const dtFmt = (d) => (d ? `${dateFmt(d.slice(0, 10))}, ${timeFmt(d)}` : '-');
export const mins = (m) => { const a = Math.abs(Math.round(m)); const s = a >= 1440 ? `${Math.floor(a / 1440)}d ${Math.floor((a % 1440) / 60)}h` : a >= 60 ? `${Math.floor(a / 60)}h ${a % 60}m` : `${a}m`; return s; };
export const hours = (hh) => (hh >= 48 ? (hh / 24).toFixed(1) + ' days' : hh.toFixed(1) + ' h');
export const hourLabel = (hr) => `${String(hr).padStart(2, '0')}:00`;

// ---- icons (single consistent stroke set) ----
const P = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10', pay: 'M3 7h18v12H3zM3 11h18M7 15h3', msg: 'M4 5h16v11H9l-5 4z', users: 'M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21c0-4 4-6 8-6s8 2 8 6', cal: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2', bank: 'M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18', desk: 'M3 5h18v10H3zM8 19h8M12 15v4', cog: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 00-2-1.2L14 3h-4l-.6 2.7a7 7 0 00-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 002 1.2L10 21h4l.6-2.7a7 7 0 002-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z',
  plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', pin: 'M12 21s-7-6-7-11a7 7 0 1114 0c0 5-7 11-7 11zM12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5z', arrowr: 'M5 12h14M13 6l6 6-6 6', arrowd: 'M12 5v14M6 13l6 6 6-6', user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 4-6 8-6s8 2 8 6', building: 'M6 21V4h12v17M3 21h18M9 8h2M13 8h2M9 12h2M13 12h2M9 16h2M13 16h2', rot: 'M20 12a8 8 0 11-3-6.2M20 4v5h-5', check: 'M5 13l4 4L19 7', x: 'M6 6l12 12M18 6L6 18', logout: 'M10 4H5v16h5M15 8l4 4-4 4M19 12H9', file: 'M6 3h9l4 4v14H6zM14 3v5h5', up: 'M12 16V4M6 10l6-6 6 6M4 20h16', cam: 'M4 8h4l2-3h4l2 3h4v12H4zM12 17a3.5 3.5 0 100-7 3.5 3.5 0 000 7z', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', key: 'M14 10a5 5 0 11-2 4l-8 6v-3l3-1v-2h2l2-2', door: 'M6 3h10v18H6zM16 3l3 2v16M12 12h.01', enter: 'M10 4H5v16h5M12 12h9M17 8l4 4-4 4', exit: 'M14 4h5v16h-5M12 12H3M7 8l-4 4 4 4', alert: 'M12 4l9 16H3zM12 10v4M12 17h.01', phone: 'M7 3h10v18H7zM11 18h2', menu: 'M4 7h16M4 12h16M4 17h16', cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5', leaf: 'M5 19c0-9 5-14 15-14 0 10-5 15-14 15M5 19l7-7', globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18', refresh: 'M4 12a8 8 0 0114-5l2-2v6h-6l2.2-2.2A5 5 0 007 12M20 12a8 8 0 01-14 5l-2 2v-6h6l-2.2 2.2A5 5 0 0017 12', download: 'M12 4v12M6 10l6 6 6-6M4 20h16', clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2', bell: 'M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20h4',
};
export const icon = (n, cls = '') => raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[n] || P.file}"/></svg>`);

export const statusChip = (kind, label) => h`<span class="chip ${kind}">${label}</span>`;
export const CHIP = { open: ['info', 'Open'], assigned: ['info', 'Assigned'], in_progress: ['warn', 'In progress'], resolved: ['ok', 'Resolved'], reopened: ['bad', 'Reopened'], escalated: ['bad', 'Escalated'], paid: ['ok', 'Paid'], partial: ['warn', 'Partial'], unpaid: ['bad', 'Unpaid'], overdue: ['bad', 'Overdue'], due: ['warn', 'Due'], matched: ['ok', 'Matched'], unmatched: ['bad', 'Unmatched'], needs_review: ['warn', 'Needs review'], duplicate: ['', 'Duplicate'], posted: ['dark', 'Posted'], rejected: ['', 'Rejected'], pending: ['warn', 'Awaiting approval'], approved: ['ok', 'Approved'], denied: ['bad', 'Denied'], inside: ['ok', 'Inside'], exited: ['', 'Exited'], Emergency: ['bad', 'Emergency'], High: ['warn', 'High'], Medium: ['info', 'Medium'], Low: ['', 'Low'] };
export const chip = (key, label) => { const [k, l] = CHIP[key] || ['', key]; return h`<span class="chip ${k}">${label || l}</span>`; };
