// Small dependency-free SVG charts. Every value is passed in from API data; nothing is hardcoded here.
import { h, raw } from './ui.js';

export const COLORS = { primary: '#087A50', forest: '#124B39', champagne: '#D8C39A', grey: '#C9CEC8', warn: '#B7791F', bad: '#B42318', info: '#2B6CB0' };
const fmtK = (n) => (n >= 10000000 ? (n / 10000000).toFixed(1) + ' Cr' : n >= 100000 ? (n / 100000).toFixed(1) + ' L' : n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'k' : String(Math.round(n)));
const niceMax = (v) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
const monthName = (m) => new Date(m + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'short' });

export function groupedBars(rows, { a = 'billed', b = 'collected', labelA = 'Billed', labelB = 'Collected', height = 240 } = {}) {
  if (!rows.length) return h`<div class="empty">No data yet</div>`;
  const W = 640, H = height, pl = 46, pr = 8, pt = 10, pb = 28; const iw = W - pl - pr, ih = H - pt - pb;
  const max = niceMax(Math.max(...rows.flatMap((r) => [r[a], r[b]])));
  const bw = Math.min(26, iw / rows.length / 2.6); const step = iw / rows.length;
  let svg = '';
  for (let i = 0; i <= 4; i++) { const y = pt + ih - (ih * i) / 4; svg += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" stroke="#ECECE5"/><text x="${pl - 8}" y="${y + 4}" text-anchor="end">${fmtK((max * i) / 4)}</text>`; }
  rows.forEach((r, i) => {
    const cx = pl + step * i + step / 2; const ha = (r[a] / max) * ih, hb = (r[b] / max) * ih;
    svg += `<rect x="${cx - bw - 1.5}" y="${pt + ih - ha}" width="${bw}" height="${ha}" rx="4" fill="${COLORS.champagne}"><title>${labelA}: ₹${r[a].toLocaleString('en-IN')}</title></rect>`;
    svg += `<rect x="${cx + 1.5}" y="${pt + ih - hb}" width="${bw}" height="${hb}" rx="4" fill="${COLORS.primary}"><title>${labelB}: ₹${r[b].toLocaleString('en-IN')}</title></rect>`;
    svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${monthName(r.month)}</text>`;
  });
  return h`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly billed versus collected" width="100%">${raw(svg)}</svg><div class="legend"><span><i style="background:${COLORS.champagne}"></i>${labelA}</span><span><i style="background:${COLORS.primary}"></i>${labelB}</span></div>`;
}

export function hbars(items, { fmt = (v) => v, color = COLORS.primary, colors } = {}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return h`<div class="stack sm">${items.map((it, idx) => h`<div><div class="row between small" style="margin-bottom:4px"><span>${it.label}</span><b class="mono">${fmt(it.value)}${it.sub ? h` <span class="muted" style="font-weight:500">${it.sub}</span>` : ''}</b></div><div class="bar"><i style="width:${(it.value / max) * 100}%;background:${colors?.[idx] || color}"></i></div></div>`)}</div>`;
}

export function donut(items, { size = 168, center = '' } = {}) {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total) return h`<div class="empty">No data yet</div>`;
  const r = 60, c = 2 * Math.PI * r; let off = 0; let svg = `<circle cx="80" cy="80" r="${r}" fill="none" stroke="#F1F3EC" stroke-width="22"/>`;
  for (const it of items) { if (!it.value) continue; const len = (it.value / total) * c; svg += `<circle cx="80" cy="80" r="${r}" fill="none" stroke="${it.color}" stroke-width="22" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}" transform="rotate(-90 80 80)"><title>${it.label}: ${it.value}</title></circle>`; off += len; }
  svg += `<text x="80" y="78" text-anchor="middle" style="font:700 24px var(--display);fill:#171C19">${total}</text><text x="80" y="96" text-anchor="middle" style="font-size:11px">${center}</text>`;
  return h`<div class="row wrap" style="gap:24px"><svg class="chart" viewBox="0 0 160 160" width="${size}" height="${size}" role="img" aria-label="Breakdown">${raw(svg)}</svg><div class="stack sm small">${items.map((it) => h`<div class="row"><i style="width:10px;height:10px;border-radius:3px;background:${it.color};display:inline-block"></i><span>${it.label}</span><b class="mono">${it.value}</b></div>`)}</div></div>`;
}
