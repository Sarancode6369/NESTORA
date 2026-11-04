// NESTORA township renderer - a dependency-free 3D scene (software perspective projection on Canvas 2D).
// Honest scope: this is a carefully lit architectural massing model, not a photoreal path-traced render.
// It does provide real 3D: orbit / zoom, scroll-driven camera paths, picking, hover and animated camera moves.

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

export const PLACES = {
  aerial: { label: 'Township', cam: { tx: 0, ty: 10, tz: 20, yaw: 0.55, pitch: 0.55, dist: 470 } },
  gate: { label: 'Entrance gate', cam: { tx: 0, ty: 8, tz: 235, yaw: 0.2, pitch: 0.16, dist: 120 } },
  towers: { label: 'Residential towers', cam: { tx: -66, ty: 22, tz: 40, yaw: -0.55, pitch: 0.2, dist: 190 } },
  clubhouse: { label: 'Clubhouse', cam: { tx: 0, ty: 6, tz: 18, yaw: 0.12, pitch: 0.3, dist: 100 } },
  pool: { label: 'Swimming pool', cam: { tx: 0, ty: 0, tz: -34, yaw: -0.5, pitch: 0.45, dist: 110 } },
  gardens: { label: 'Landscaped gardens', cam: { tx: 0, ty: 4, tz: 118, yaw: 0.9, pitch: 0.28, dist: 140 } },
};
export const TOWER_COUNT = 28;

// ---------- scene ----------
function buildScene() {
  const towers = [];
  const cols = [-130, -70, 70, 130];
  let n = 0;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 4; c++) {
      n++;
      const heightFloors = 12 + Math.floor(hash(n * 3.1) * 7); // 12-18 floors
      towers.push({ id: n, label: 'T' + String(n).padStart(2, '0'), x: cols[c], z: -180 + r * 60, w: 24, d: 17, floors: heightFloors, h: heightFloors * 3.2, tone: hash(n * 7.7), rot: c < 2 ? 0 : 0 });
    }
  }
  const trees = [];
  const addTree = (x, z, s = 1) => trees.push({ x, z, s, h: 7 + hash(x * 1.3 + z) * 5, tone: hash(x + z * 2.1) });
  // avenue trees along the central road
  for (let z = -220; z <= 250; z += 20) { addTree(-12, z, 0.9); addTree(12, z, 0.9); }
  // garden clusters
  for (let i = 0; i < 90; i++) {
    const x = (hash(i * 5.3) - 0.5) * 340, z = -215 + hash(i * 9.1) * 450;
    const tooClose = towers.some((t) => Math.abs(x - t.x) < t.w / 2 + 8 && Math.abs(z - t.z) < t.d / 2 + 8);
    const onRoad = Math.abs(x) < 10 || Math.abs(Math.abs(x) - 100) < 7 || Math.abs(z + 210) < 8 || Math.abs(z - 215) < 8;
    const inClub = Math.abs(x) < 38 && z > -60 && z < 40;
    if (!tooClose && !onRoad && !inClub) addTree(x, z, 0.8 + hash(i) * 0.6);
  }
  // perimeter planting and distant low-rise context so the site sits in a believable setting
  for (let i = 0; i < 70; i++) { const side = i % 4; const a = hash(i * 4.7) ; const x = side < 2 ? (side ? 195 : -195) + (hash(i) - 0.5) * 30 : -190 + a * 380; const z = side < 2 ? -240 + a * 520 : (side === 2 ? -255 : 295) + (hash(i + 9) - 0.5) * 24; addTree(x, z, 1 + hash(i * 2) * 0.7); }
  const context = [];
  for (let i = 0; i < 26; i++) { const ang = hash(i * 3.3) * TAU; const rad = 330 + hash(i * 6.1) * 380; context.push({ x: Math.cos(ang) * rad, z: Math.sin(ang) * rad * 1.1 + 20, w: 16 + hash(i) * 26, d: 14 + hash(i * 2) * 20, h: 8 + hash(i * 5) * 22, id: 'ctx' + i }); }
  const lamps = [];
  for (let z = -200; z <= 240; z += 40) { lamps.push({ x: -7, z }); lamps.push({ x: 7, z }); }
  return { towers, trees, lamps, context };
}

export class Township {
  constructor(canvas, { onSelect, onHover, interactive = true, lite = false } = {}) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.scene = buildScene();
    this.cam = { ...PLACES.aerial.cam };
    this.target = { ...this.cam };
    this.anim = null;
    this.selected = null; this.hover = null;
    this.onSelect = onSelect; this.onHover = onHover;
    this.interactive = interactive;
    this.lite = lite || matchMedia('(max-width: 700px)').matches;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.visible = true; this.driven = false; this.t0 = performance.now();
    this.polys = []; this.dirty = true; this.idle = 0;
    this.sun = norm([-0.45, 0.8, 0.4]);
    this._bind();
    this._resize();
    this._raf = requestAnimationFrame(this._loop);
  }
  destroy() { cancelAnimationFrame(this._raf); this._ro?.disconnect(); this._io?.disconnect(); }

  // --- camera control ---
  flyTo(place, ms = 1600) {
    const k = typeof place === 'string' ? PLACES[place].cam : place;
    if (this.reduced) { Object.assign(this.cam, k); this.dirty = true; return; }
    const from = { ...this.cam };
    let dyaw = k.yaw - from.yaw; dyaw = ((dyaw + Math.PI) % TAU + TAU) % TAU - Math.PI; // shortest way round
    this.anim = { from, to: { ...k, yaw: from.yaw + dyaw }, t0: performance.now(), ms };
  }
  setCamera(k) { Object.assign(this.cam, k); this.dirty = true; }
  select(id) { this.selected = id; this.dirty = true; }
  zoom(f) { this.anim = null; this.cam.dist = clamp(this.cam.dist * f, 50, 900); this.dirty = true; }
  rotate(d) { this.anim = null; this.autoRotate = false; this.cam.yaw += d; this.dirty = true; }

  _bind() {
    const c = this.c;
    this._ro = new ResizeObserver(() => this._resize()); this._ro.observe(c);
    this._io = new IntersectionObserver((e) => { this.visible = e[0].isIntersecting; if (this.visible) this.dirty = true; }); this._io.observe(c);
    if (!this.interactive) return;
    let drag = null; const pts = new Map(); let pinch = 0;
    c.style.touchAction = 'pan-y';
    c.addEventListener('pointerdown', (e) => { this._wheelOk = true; this.autoRotate = false; pts.set(e.pointerId, e); drag = { x: e.clientX, y: e.clientY, moved: 0, id: e.pointerId }; c.setPointerCapture(e.pointerId); this.anim = null; });
    c.addEventListener('pointermove', (e) => {
      pts.set(e.pointerId, e);
      if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); if (pinch) { this.cam.dist = clamp(this.cam.dist * (pinch / d), 50, 900); this.dirty = true; } pinch = d; return; }
      if (drag && drag.id === e.pointerId && pts.size === 1) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
        if (drag.moved > 4) { c.style.touchAction = 'none'; this.cam.yaw -= dx * 0.006; this.cam.pitch = clamp(this.cam.pitch + dy * 0.004, 0.06, 1.35); this.dirty = true; }
      } else if (!drag) this._hover(e);
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = 0; if (drag && drag.id === e.pointerId) { if (drag.moved <= 4) this._click(e); drag = null; c.style.touchAction = 'pan-y'; } };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => { if (this.hover) { this.hover = null; this.dirty = true; this.onHover?.(null); } });
    c.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey && !this._wheelOk) return; e.preventDefault(); this.cam.dist = clamp(this.cam.dist * Math.exp(e.deltaY * 0.0012), 50, 900); this.anim = null; this.dirty = true; }, { passive: false });
    // scroll-wheel zoom is only active after the viewer clicks/drags the model, so the page itself can always scroll past it
    c.addEventListener('mouseleave', () => { this._wheelOk = false; }); c.addEventListener('blur', () => { this._wheelOk = false; });
    c.tabIndex = 0;
    c.addEventListener('keydown', (e) => {
      const m = { ArrowLeft: () => (this.cam.yaw -= 0.1), ArrowRight: () => (this.cam.yaw += 0.1), ArrowUp: () => (this.cam.pitch = clamp(this.cam.pitch - 0.05, 0.06, 1.35)), ArrowDown: () => (this.cam.pitch = clamp(this.cam.pitch + 0.05, 0.06, 1.35)), '+': () => (this.cam.dist = clamp(this.cam.dist * 0.9, 50, 900)), '-': () => (this.cam.dist = clamp(this.cam.dist * 1.1, 50, 900)) };
      if (m[e.key]) { e.preventDefault(); m[e.key](); this.dirty = true; }
    });
  }
  _pick(e) {
    const r = this.c.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
    for (let i = this.polys.length - 1; i >= 0; i--) { const p = this.polys[i]; if (inside(p.pts, x, y)) return p.id; }
    return null;
  }
  _hover(e) { const id = this._pick(e); if (id !== this.hover) { this.hover = id; this.c.style.cursor = id ? 'pointer' : 'grab'; this.dirty = true; this.onHover?.(id, e); } }
  _click(e) { const id = this._pick(e); if (id) { this.selected = id; this.dirty = true; const t = this.scene.towers.find((t) => t.id === id); if (t) this.flyTo({ tx: t.x, ty: t.h / 2, tz: t.z, yaw: this.cam.yaw, pitch: 0.3, dist: 150 }, 1200); this.onSelect?.(t); } }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.lite ? 1.5 : 2);
    const w = this.c.clientWidth, h = this.c.clientHeight; if (!w || !h) return;
    this.c.width = Math.round(w * dpr); this.c.height = Math.round(h * dpr); this.W = w; this.H = h; this.dpr = dpr; this.dirty = true;
  }

  _loop = (now) => {
    this._raf = requestAnimationFrame(this._loop);
    if (!this.visible || !this.W) return;
    if (this.anim) {
      const t = clamp((now - this.anim.t0) / this.anim.ms, 0, 1), e = ease(t);
      for (const k of Object.keys(this.anim.to)) this.cam[k] = lerp(this.anim.from[k], this.anim.to[k], e);
      if (t >= 1) this.anim = null; this.dirty = true;
    } else if (!this.reduced && this.autoRotate && !this.driven) { this.cam.yaw += 0.0007; this.dirty = true; }
    if (this.dirty) { this.dirty = false; this.draw(now); }
  };

  // ---------- projection ----------
  _setupCam() {
    const { tx, ty, tz, yaw, pitch, dist } = this.cam;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const pos = [tx + Math.sin(yaw) * cp * dist, ty + sp * dist, tz + Math.cos(yaw) * cp * dist];
    // Lens shift: at low pitch the view axis is kept closer to horizontal so building verticals stay upright;
    // the principal point is shifted so the orbit target still sits in the middle of the frame.
    const k = 0.3 + 0.7 * smooth(0.3, 0.85, pitch); const pe = pitch * k;
    const f = norm([-Math.sin(yaw) * Math.cos(pe), -Math.sin(pe), -Math.cos(yaw) * Math.cos(pe)]);
    const r = norm(cross(f, [0, 1, 0])); const u = cross(r, f);
    const focal = (this.H / 2) / Math.tan((this.W < 700 ? 46 : 36) * Math.PI / 180);
    this.P = { pos, f, r, u, focal, near: 1.5, cy: this.H / 2 - focal * Math.tan(pitch - pe), pe };
  }
  _toCam(p) { const { pos, f, r, u } = this.P; const d = [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]]; return [dot(d, r), dot(d, u), dot(d, f)]; }
  _scr(c) { const k = this.P.focal / c[2]; return [this.W / 2 + c[0] * k, this.P.cy - c[1] * k, c[2]]; }
  // project a polygon with near-plane clipping; returns screen pts or null
  _poly(pts3) {
    let cs = pts3.map((p) => this._toCam(p)); const n = this.P.near; const out = [];
    for (let i = 0; i < cs.length; i++) {
      const a = cs[i], b = cs[(i + 1) % cs.length]; const ina = a[2] >= n, inb = b[2] >= n;
      if (ina) out.push(a);
      if (ina !== inb) { const t = (n - a[2]) / (b[2] - a[2]); out.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t), n]); }
    }
    if (out.length < 3) return null; return out.map((c) => this._scr(c));
  }

  // ---------- drawing ----------
  draw(now) {
    const ctx = this.ctx; ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._setupCam();
    const { W, H } = this; const { focal } = this.P;
    const horizon = this.P.cy - focal * Math.tan(this.P.pe);
    const hz = clamp(horizon, -H, 2 * H);
    // sky
    const sky = ctx.createLinearGradient(0, Math.min(0, hz - H), 0, Math.max(hz, 1));
    sky.addColorStop(0, '#9fc3dd'); sky.addColorStop(0.65, '#dbe9ee'); sky.addColorStop(1, '#f3ede0');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    // distant ground / haze
    const g = ctx.createLinearGradient(0, hz, 0, hz + H * 0.5); g.addColorStop(0, '#cfd8c0'); g.addColorStop(1, '#7ea06c');
    ctx.fillStyle = g; ctx.fillRect(0, Math.max(0, hz), W, H - Math.max(0, hz));
    // far hills
    if (hz > 10 && hz < H) { ctx.fillStyle = 'rgba(122,150,128,.5)'; ctx.beginPath(); ctx.moveTo(0, hz); for (let x = 0; x <= W; x += 20) ctx.lineTo(x, hz - 8 - 10 * Math.sin(x * 0.011 + this.cam.yaw * 3) - 6 * Math.sin(x * 0.031)); ctx.lineTo(W, hz); ctx.fill(); }

    this.polys = [];
    const haze = [231, 236, 226];
    const fog = (col, depth) => mix(col, haze, clamp((depth - 260) / 900, 0, 0.7));
    const L = this.sun;
    const flat = (pts, col, depthBias = 0) => { const p = this._poly(pts); if (!p) return; ctx.fillStyle = rgb(col); ctx.beginPath(); p.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath(); ctx.fill(); return p; };
    const rect = (x0, z0, x1, z1, y = 0) => [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]];

    // site: lawn, boundary
    flat(rect(-9000, -9000, 9000, 9000, -0.3), [118, 152, 100]);
    flat(rect(-460, -470, 460, 560, -0.2), [108, 146, 92]);
    flat(rect(-175, -232, 175, 272, 0), [127, 168, 106]);
    // lawn stripes for realism
    for (let z = -228; z < 270; z += 16) flat(rect(-175, z, 175, z + 8, 0.02), [122, 162, 101]);
    // roads
    const road = [74, 78, 80]; const kerb = [196, 194, 186];
    const roadRect = (x0, z0, x1, z1) => { flat(rect(x0 - 1, z0 - 1, x1 + 1, z1 + 1, 0.04), kerb); flat(rect(x0, z0, x1, z1, 0.06), road); };
    roadRect(-6, -218, 6, 276); roadRect(-175, -222, 175, -210); roadRect(-175, 207, 175, 219);
    roadRect(-105, -222, -95, 219); roadRect(95, -222, 105, 219);
    roadRect(-175, 268, 175, 276);
    // dashed centre line
    if (this.cam.dist < 520) for (let z = -214; z < 272; z += 10) flat(rect(-0.3, z, 0.3, z + 5, 0.08), [220, 218, 205]);
    // clubhouse plaza, paths
    flat(rect(-40, -62, 40, 44, 0.07), [204, 196, 178]);
    flat(rect(-34, -56, 34, -8, 0.1), [168, 156, 138]); // pool deck
    // pool
    const pool = flat(rect(-22, -52, 22, -22, 0.14), [58, 150, 170]); if (pool) { const gp = ctx.createLinearGradient(pool[0][0], pool[0][1], pool[2][0], pool[2][1]); gp.addColorStop(0, 'rgba(255,255,255,.35)'); gp.addColorStop(1, 'rgba(0,70,100,.25)'); ctx.fillStyle = gp; ctx.beginPath(); pool.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.fill(); this.polys.push({ id: 'pool', pts: pool }); }
    // walking paths
    for (const x of [-60, 60]) flat(rect(x - 2.5, -205, x + 2.5, 205, 0.05), [214, 205, 184]);
    // parking bays near gate
    for (let i = 0; i < 12; i++) { flat(rect(-160 + i * 12, 232, -151 + i * 12, 252, 0.05), [96, 98, 98]); }
    for (let i = 0; i < 12; i++) { flat(rect(52 + i * 12, 232, 61 + i * 12, 252, 0.05), [96, 98, 98]); }

    // boundary wall
    const wall = [[-176, -233, 176, -231], [-176, 271, 176, 273], [-177, -233, -175, 273], [175, -233, 177, 273]];
    for (const [a, b2, c2, d2] of wall) flat(rect(a, b2, c2, d2, 0.3), [196, 190, 176]);
    // gather 3D objects with depth
    const objs = [];
    const cam = this.P.pos;
    const dist2 = (x, z) => Math.hypot(x - cam[0], z - cam[2]);
    // shadows first (flat, below all)
    const sdx = -this.sun[0] / this.sun[1], sdz = -this.sun[2] / this.sun[1];
    const shadow = (b) => { const k = b.h; const pts = [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]]; const sh = pts.map(([x, z]) => [x + sdx * k, z + sdz * k]); const hull = convexHull([...pts, ...sh]); const p = this._poly(hull.map(([x, z]) => [x, 0.2, z])); if (p) { ctx.fillStyle = 'rgba(30,45,35,.22)'; ctx.beginPath(); p.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.fill(); } };
    const boxes = [];
    for (const t of this.scene.towers) boxes.push({ kind: 'tower', t, x0: t.x - t.w / 2, x1: t.x + t.w / 2, z0: t.z - t.d / 2, z1: t.z + t.d / 2, y0: 0, h: t.h, id: t.id });
    boxes.push({ kind: 'club', x0: -26, x1: 26, z0: 6, z1: 34, y0: 0, h: 11, id: 'clubhouse' });
    boxes.push({ kind: 'clubroof', x0: -30, x1: 30, z0: 2, z1: 38, y0: 11, h: 1.2, id: 'clubhouse' });
    boxes.push({ kind: 'gatehouse', x0: -26, x1: -18, z0: 262, z1: 282, y0: 0, h: 4.5, id: 'gate' });
    boxes.push({ kind: 'gatehouse', x0: 18, x1: 26, z0: 262, z1: 282, y0: 0, h: 4.5, id: 'gate' });
    boxes.push({ kind: 'gatebeam', x0: -26, x1: 26, z0: 268, z1: 276, y0: 4.5, h: 1.6, id: 'gate' });
    for (const cx of this.scene.context) boxes.push({ kind: 'ctx', x0: cx.x - cx.w / 2, x1: cx.x + cx.w / 2, z0: cx.z - cx.d / 2, z1: cx.z + cx.d / 2, y0: 0, h: cx.h, id: cx.id });
    for (const b of boxes) if (this.cam.dist < 800 && b.kind !== 'ctx') shadow(b);
    for (const tr of this.scene.trees) { const p = this._poly(ellipse(tr.x + sdx * tr.h * 0.6, tr.z + sdz * tr.h * 0.6, tr.s * 4.2, 8)); if (p && this.cam.dist < 500) { ctx.fillStyle = 'rgba(30,45,35,.18)'; ctx.beginPath(); p.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.fill(); } }

    for (const b of boxes) objs.push({ type: 'box', b, depth: dist2((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2) });
    for (const tr of this.scene.trees) objs.push({ type: 'tree', tr, depth: dist2(tr.x, tr.z) });
    if (this.cam.dist < 420) for (const l of this.scene.lamps) objs.push({ type: 'lamp', l, depth: dist2(l.x, l.z) });
    objs.sort((a, b) => b.depth - a.depth);

    for (const o of objs) {
      if (o.type === 'box') this._box(ctx, o.b, L, fog, o.depth);
      else if (o.type === 'tree') this._tree(ctx, o.tr, fog, o.depth);
      else this._lamp(ctx, o.l);
    }

    const hb = ctx.createLinearGradient(0, hz - 40, 0, hz + H * 0.22); hb.addColorStop(0, 'rgba(231,236,226,0)'); hb.addColorStop(0.35, 'rgba(231,236,226,.55)'); hb.addColorStop(1, 'rgba(231,236,226,0)'); ctx.fillStyle = hb; ctx.fillRect(0, Math.max(0, hz - 40), W, Math.min(H, H * 0.22 + 40));
    // labels
    ctx.font = '600 11px "Plus Jakarta Sans", Inter, system-ui, sans-serif'; ctx.textAlign = 'center';
    const labelOf = (id) => (typeof id === 'number' ? this.scene.towers.find((t) => t.id === id)?.label : { clubhouse: 'Clubhouse', pool: 'Swimming pool', gate: 'Entrance gate' }[id]);
    const showId = (id) => id === this.hover || id === this.selected;
    const places = [['clubhouse', [0, 13, 20]], ['pool', [0, 1, -37]], ['gate', [0, 9, 272]]];
    for (const [id, p] of places) { if (!(this.cam.dist < 150 || showId(id))) continue; this._label(ctx, labelOf(id), p, showId(id)); }
    if (this.cam.dist < 700 || this.hover || this.selected) for (const t of this.scene.towers) { const d = dist2(t.x, t.z); const show = showId(t.id) || (this.cam.dist >= 360 && this.cam.dist < 700); if (show) this._label(ctx, t.label, [t.x, t.h + 3, t.z], showId(t.id)); }
    // soft vignette
    const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.8); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(18,40,30,.18)'); ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  }

  _label(ctx, text, p3, active) {
    const c = this._toCam(p3); if (c[2] < 5) return; const s = this._scr(c);
    const w = ctx.measureText(text).width + 14; ctx.fillStyle = active ? '#124B39' : 'rgba(255,255,255,.88)'; roundRect(ctx, s[0] - w / 2, s[1] - 18, w, 20, 10); ctx.fill();
    ctx.fillStyle = active ? '#fff' : '#124B39'; ctx.fillText(text, s[0], s[1] - 4);
  }

  _box(ctx, b, L, fog, depth) {
    const { x0, x1, z0, z1, y0, h } = b; const y1 = y0 + h;
    const isTower = b.kind === 'tower'; const t = b.t;
    const tone = isTower ? t.tone : 0.5;
    const base = b.kind === 'ctx' ? [206, 200, 190] : b.kind === 'club' ? [226, 216, 196] : b.kind === 'clubroof' ? [90, 96, 92] : b.kind === 'gatebeam' ? [18, 75, 57] : b.kind === 'gatehouse' ? [210, 200, 182] : mix([232, 228, 218], [214, 205, 188], tone);
    const sel = isTower && (b.id === this.selected); const hov = b.id === this.hover && !sel;
    const faces = [
      { n: [0, 0, 1], pts: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], name: 'S' },
      { n: [0, 0, -1], pts: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], name: 'N' },
      { n: [1, 0, 0], pts: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], name: 'E' },
      { n: [-1, 0, 0], pts: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], name: 'W' },
      { n: [0, 1, 0], pts: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], name: 'T' },
    ];
    const cp = this.P.pos; const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const vis = faces.filter((f) => { const fc = [cx + f.n[0] * (x1 - x0) / 2, (y0 + y1) / 2 + f.n[1] * h / 2, cz + f.n[2] * (z1 - z0) / 2]; return dot(f.n, [cp[0] - fc[0], cp[1] - fc[1], cp[2] - fc[2]]) > 0; });
    const hull = [];
    for (const f of vis) {
      const p = this._poly(f.pts); if (!p) continue; hull.push(...p);
      let shade = 0.55 + 0.45 * Math.max(0, dot(f.n, L)); if (f.name === 'T') shade = 0.98;
      let col = [base[0] * shade, base[1] * shade, base[2] * shade];
      if (sel) col = mix(col, [216, 195, 154], 0.35); else if (hov) col = mix(col, [216, 195, 154], 0.22);
      col = fog(col, depth);
      ctx.fillStyle = rgb(col); ctx.beginPath(); p.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(40,40,35,.18)'; ctx.lineWidth = 0.6; ctx.stroke();
      if (f.name !== 'T') this._windows(ctx, b, f, p, shade, depth, fog);
      else if (isTower) { // rooftop plant + parapet line
        const inset = this._poly([[x0 + 4, y1 + 0.1, z1 - 4], [x1 - 4, y1 + 0.1, z1 - 4], [x1 - 4, y1 + 0.1, z0 + 4], [x0 + 4, y1 + 0.1, z0 + 4]]); if (inset) { ctx.fillStyle = rgb(fog([150, 152, 148], depth), 0.8); ctx.beginPath(); inset.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.fill(); }
      }
    }
    if (hull.length && b.kind !== 'ctx' && (b.kind === 'tower' || b.id === 'clubhouse' || b.id === 'gate')) {
      const hp = convexHull(hull.map((q) => [q[0], q[1]])).map((q) => q);
      this.polys.push({ id: b.id, pts: hp });
      if (sel || hov) { ctx.strokeStyle = '#D8C39A'; ctx.lineWidth = sel ? 2.5 : 1.8; ctx.beginPath(); hp.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath(); ctx.stroke(); }
    }
  }

  _windows(ctx, b, f, p, shade, depth, fog) {
    if (p.length !== 4) return;
    const isTower = b.kind === 'tower', isClub = b.kind === 'club'; if (!isTower && !isClub) return;
    const wPx = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), hPx = Math.hypot(p[3][0] - p[0][0], p[3][1] - p[0][1]);
    if (hPx < 14 || wPx < 6) return;
    const floors = isTower ? b.t.floors : 3; const horiz = f.name === 'S' || f.name === 'N' ? b.x1 - b.x0 : b.z1 - b.z0;
    const bays = Math.max(3, Math.round(horiz / 3.4)); const step = this.lite && floors > 10 ? 2 : 1;
    const lerp2 = (u, v) => [p[0][0] + (p[1][0] - p[0][0]) * u + (p[3][0] - p[0][0]) * v, p[0][1] + (p[1][1] - p[0][1]) * u + (p[3][1] - p[0][1]) * v];
    // perspective-correct enough for these distances; skip heavy detail when tiny
    const detail = hPx / floors > 3.2;
    // balcony slabs
    if (detail && isTower) { ctx.strokeStyle = rgb(fog([120, 112, 98].map((c) => c * shade), depth), 0.55); ctx.lineWidth = Math.max(0.6, hPx / floors * 0.12); ctx.beginPath(); for (let fl = 1; fl < floors; fl += step) { const a = lerp2(0, fl / floors), c = lerp2(1, fl / floors); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); } ctx.stroke(); }
    // glazing
    const glass = fog([70 + 40 * shade, 105 + 45 * shade, 125 + 40 * shade], depth);
    ctx.fillStyle = rgb(glass, 0.92);
    const warm = fog([240, 214, 150], depth);
    for (let fl = 0; fl < floors; fl += step) {
      for (let bay = 0; bay < bays; bay++) {
        const u0 = (bay + 0.2) / bays, u1 = (bay + 0.8) / bays, v0 = (fl + 0.22) / floors, v1 = (fl + 0.78) / floors;
        const a = lerp2(u0, v0), bb = lerp2(u1, v0), c = lerp2(u1, v1), d = lerp2(u0, v1);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(bb[0], bb[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath();
        ctx.fillStyle = rgb(glass, 0.9); ctx.fill();
        if (isTower && hash(b.id * 31 + fl * 7 + bay * 3 + (f.name === 'S' ? 1 : 2)) > 0.9 && detail) { ctx.fillStyle = rgb(warm, 0.55); ctx.fill(); }
      }
    }
  }

  _tree(ctx, tr, fog, depth) {
    const base = this._toCam([tr.x, 0, tr.z]); if (base[2] < 4) return;
    const top = this._toCam([tr.x, tr.h, tr.z]); const sb = this._scr(base), st = this._scr(top);
    const r = (this.P.focal / base[2]) * 3.4 * tr.s; if (r < 0.7) return;
    const trunkW = Math.max(1, r * 0.22);
    ctx.strokeStyle = rgb(fog([92, 70, 52], depth)); ctx.lineWidth = trunkW; ctx.beginPath(); ctx.moveTo(sb[0], sb[1]); ctx.lineTo(st[0], st[1] + r * 0.4); ctx.stroke();
    const g = mix([46, 98, 62], [84, 132, 76], tr.tone);
    const grd = ctx.createRadialGradient(st[0] - r * 0.3, st[1] - r * 0.35, r * 0.1, st[0], st[1], r * 1.2);
    grd.addColorStop(0, rgb(fog(mix(g, [160, 190, 120], 0.35), depth))); grd.addColorStop(1, rgb(fog([g[0] * 0.62, g[1] * 0.7, g[2] * 0.62], depth)));
    ctx.fillStyle = grd; ctx.beginPath(); ctx.ellipse(st[0], st[1], r, r * 1.08, 0, 0, TAU); ctx.fill();
    if (r > 6) { ctx.fillStyle = rgb(fog([g[0] * 0.8, g[1] * 0.85, g[2] * 0.8], depth), 0.8); ctx.beginPath(); ctx.ellipse(st[0] + r * 0.45, st[1] + r * 0.3, r * 0.55, r * 0.5, 0, 0, TAU); ctx.fill(); }
  }
  _lamp(ctx, l) {
    const b = this._toCam([l.x, 0, l.z]); if (b[2] < 4) return; const t = this._toCam([l.x, 6, l.z]); const sb = this._scr(b), st = this._scr(t);
    ctx.strokeStyle = 'rgba(60,64,62,.9)'; ctx.lineWidth = Math.max(0.8, 90 / b[2]); ctx.beginPath(); ctx.moveTo(sb[0], sb[1]); ctx.lineTo(st[0], st[1]); ctx.stroke();
    ctx.fillStyle = 'rgba(255,240,200,.95)'; ctx.beginPath(); ctx.arc(st[0], st[1], Math.max(1, 220 / b[2]), 0, TAU); ctx.fill();
  }
}

// ---------- scroll-driven cinematic path ----------
export const FLY_PATH = [
  { at: 0.0, cam: { tx: 0, ty: 12, tz: 30, yaw: 0.7, pitch: 0.52, dist: 520 } },     // wide aerial
  { at: 0.25, cam: { tx: 0, ty: 8, tz: 215, yaw: 0.25, pitch: 0.2, dist: 150 } },   // approach the entrance
  { at: 0.5, cam: { tx: 0, ty: 20, tz: 100, yaw: 0.08, pitch: 0.14, dist: 120 } },  // travel between towers
  { at: 0.75, cam: { tx: 0, ty: 6, tz: 18, yaw: 0.3, pitch: 0.3, dist: 105 } },     // gardens + clubhouse
  { at: 1.0, cam: { tx: 0, ty: 10, tz: 10, yaw: 1.2, pitch: 0.62, dist: 460 } },     // rise back up
];
export function cameraAt(p) {
  const path = FLY_PATH; p = clamp(p, 0, 1);
  let i = 0; while (i < path.length - 2 && p > path[i + 1].at) i++;
  const a = path[i], b = path[i + 1]; const t = ease(clamp((p - a.at) / (b.at - a.at), 0, 1));
  const out = {}; for (const k of Object.keys(a.cam)) out[k] = lerp(a.cam[k], b.cam[k], t); return out;
}

// ---------- geometry helpers ----------
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function smooth(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function norm(a) { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function inside(poly, x, y) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; }
function ellipse(cx, cz, r, n) { const p = []; for (let i = 0; i < n; i++) p.push([cx + Math.cos((i / n) * TAU) * r, 0.2, cz + Math.sin((i / n) * TAU) * r]); return p; }
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = []; for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up = []; for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop(); return lo.concat(up);
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
