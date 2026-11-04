// Scroll-scrubbed image sequence: draws the client's real township frames on a canvas, driven by scroll progress.
// Frames are never stretched or re-rendered: each one is drawn "cover" fitted at its native aspect ratio.
// (No fake 3D from a flat photo: this is the supplied camera-move footage played by scroll position.)

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class Journey {
  constructor(canvas, { count = 270, base = '/frames/f', ext = '.jpg', pad = 3, reduced = false, step = 1, stills = [0, 150, 262] } = {}) {
    Object.assign(this, { c: canvas, ctx: canvas.getContext('2d', { alpha: false }), count, base, ext, pad, reduced, step, stills });
    this.imgs = new Array(count).fill(null); this.loaded = 0; this.target = 0; this.cur = 0; this.p = 0;
    this.fw = 1280; this.fh = 720; this.visible = true; this.t0 = performance.now(); this.lastDrawn = -1; this.dirty = true;
    this._resize = () => { const dpr = Math.min(window.devicePixelRatio || 1, 1.5); const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); this.dirty = true; };
    this._ro = new ResizeObserver(this._resize); this._ro.observe(canvas); this._resize();
    this._io = new IntersectionObserver((e) => { this.visible = e[0].isIntersecting; this.dirty = true; }); this._io.observe(canvas);
    this._raf = requestAnimationFrame(this._loop);
  }
  url(i) { return `${this.base}${String(i + 1).padStart(this.pad, '0')}${this.ext}`; }
  destroy() { cancelAnimationFrame(this._raf); this._ro.disconnect(); this._io.disconnect(); this.dead = true; }

  // Frame 1 first (so the hero appears immediately), then coarse-to-fine passes so a fast scroll always has a nearby frame.
  async load(onFirst) {
    const get = (i) => new Promise((res) => { if (this.imgs[i] || this.dead) return res(); const im = new Image(); im.decoding = 'async'; im.onload = () => { this.imgs[i] = im; this.loaded++; if (i === 0) { this.fw = im.naturalWidth; this.fh = im.naturalHeight; } this.dirty = true; res(); }; im.onerror = () => res(); im.src = this.url(i); });
    await get(0); onFirst?.();
    const wanted = (i) => i % this.step === 0 || i === this.count - 1;
    for (const stride of [30, 10, 4, 2, 1]) {
      const todo = []; for (let i = 0; i < this.count; i += stride) if (!this.imgs[i] && wanted(i)) todo.push(i);
      if (this.step > 1 && stride === 1) continue;
      let k = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (k < todo.length && !this.dead) await get(todo[k++]); }));
    }
  }

  set progress(p) { this.p = clamp(p, 0, 1); this.target = this.reduced ? this._still(this.p) : this.p * (this.count - 1); }
  _still(p) { const n = this.stills.length; return this.stills[Math.min(n - 1, Math.floor(p * n * 0.9999))]; }
  nearest(i) { for (let d = 0; d < this.count; d++) { const a = this.imgs[i - d]; if (a) return a; const b = this.imgs[i + d]; if (b) return b; } return null; }

  _loop = (now) => {
    this._raf = requestAnimationFrame(this._loop);
    if (!this.visible) return;
    const d = this.target - this.cur;
    if (Math.abs(d) > 0.02) { this.cur += this.reduced ? d : d * 0.14; this.dirty = true; } else if (this.cur !== this.target) { this.cur = this.target; this.dirty = true; }
    // gentle idle camera (slow zoom + horizontal drift) only while the hero is on screen and motion is allowed
    const idle = !this.reduced && this.p < 0.06; if (idle) this.dirty = true;
    if (this.dirty) { this.dirty = false; this.draw(now, idle); }
  };

  draw(now, idle) {
    const img = this.nearest(Math.round(this.cur)); if (!img) return;
    const { ctx, c } = this; const cw = c.width, ch = c.height; const fw = img.naturalWidth, fh = img.naturalHeight;
    const fade = idle ? 1 - smooth(0, 0.06, this.p) : 0; const t = (now - this.t0);
    const kb = fade * (0.5 - 0.5 * Math.cos(t * 0.00008)) * 0.075;         // slow cinematic zoom-in/out, max +7.5%
    const pan = fade * Math.sin(t * 0.00011) * 0.5;                          // subtle horizontal camera movement
    const s = Math.max(cw / fw, ch / fh) * (1 + kb);                         // uniform scale: never stretched
    const dw = fw * s, dh = fh * s; const spareX = dw - cw, spareY = dh - ch;
    const x = -spareX / 2 - pan * spareX * (cw < ch ? 0.9 : 0.8);            // portrait phones pan further so the whole building is seen
    const y = -spareY * 0.5;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, Math.round(x), Math.round(y), Math.round(dw), Math.round(dh));
  }
}
