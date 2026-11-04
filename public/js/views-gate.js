import { h, mount, $, $$, api, toast, openModal, busy, timeFmt, icon, chip, session, setSession } from './ui.js';
import { t } from './i18n.js';

// Offline-first guard tablet. New visitors are queued on the device (with a client id so replays are idempotent)
// and synced when the network returns. The last list of visitors is cached for display while offline.
const QK = 'nestora.gate.queue', CK = 'nestora.gate.cache';
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const online = () => navigator.onLine !== false;
let syncing = false;

export async function syncQueue() {
  if (syncing) return 0; const q = read(QK, []); if (!q.length) return 0; syncing = true; let done = 0; const rest = [];
  for (const item of q) {
    try { await api('POST', '/visitors', item); done++; }
    catch (e) { if (e.offline || e.status >= 500) rest.push(item); else if (e.status === 400) { /* invalid - drop so the queue cannot jam */ } else rest.push(item); }
  }
  write(QK, rest); syncing = false; return done;
}

async function photoFromFile(file, enhance) {
  const bmp = await createImageBitmap(file); const k = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); const ctx = c.getContext('2d');
  if (enhance) ctx.filter = 'brightness(1.35) contrast(1.12) saturate(1.05)'; // helps photos taken in low light read clearly
  ctx.drawImage(bmp, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.72);
}

let pollTimer = null, netHandler = null;
export async function gateView(root) {
  clearInterval(pollTimer); if (netHandler) { window.removeEventListener('online', netHandler); window.removeEventListener('offline', netHandler); }
  let visitors = read(CK, []); let queued = read(QK, []);
  const refresh = async () => {
    if (online()) { try { const n = await syncQueue(); const r = await api('GET', '/visitors'); visitors = r.visitors; write(CK, visitors.map((v) => ({ ...v, photo: null }))); if (n) toast(`${n} ${t('synced')}`); } catch { /* keep cache */ } }
    queued = read(QK, []); draw();
  };
  const draw = () => {
    const inside = visitors.filter((v) => v.status === 'inside'); const waiting = visitors.filter((v) => ['pending', 'approved', 'preapproved'].includes(v.status));
    const isOn = online();
    mount(root, h`<div class="gate"><div style="max-width:1100px;margin:0 auto">
      <div class="top"><img src="/logo.png" alt="NESTORA" style="height:34px;filter:brightness(0) invert(1)"><h1 class="grow">${t('gate_title')} · ${session.user.name.replace(' (demo)', '')}</h1>
        <span class="chip ${isOn ? 'ok' : 'warn'}">${isOn ? '● ' + t('online') : '● ' + t('offline_q')}</span>${queued.length ? h`<span class="chip warn">${queued.length} ⟳</span>` : ''}
        <select class="langsel" id="lang" aria-label="${t('language')}" style="background:#1f3329;color:#fff;border-color:#35503f"><option value="en">English</option><option value="hi">हिन्दी</option><option value="mr">मराठी</option></select><button class="btn" id="out">${t('logout')}</button></div>
      <div class="banner warn" style="margin-bottom:18px">${t('gate_notice')}</div>
      <div class="grid2" style="margin-bottom:20px"><button class="bigbtn go" id="new">${icon('plus')}${t('new_visitor')}</button><button class="bigbtn neutral" id="code">${icon('key')}${t('enter_code')}</button></div>
      <div class="grid2" style="align-items:start">
        <div class="panel"><h2 style="font-size:22px;margin-bottom:8px">${t('waiting')} (${waiting.length + queued.length})</h2>
          ${queued.map((q) => h`<div class="vrow"><div class="vphoto" style="display:grid;place-items:center">${icon('clock')}</div><div class="grow"><b style="font-size:20px">${q.name}</b><div style="color:#b9cbc1">${q.flatNo} · ${t('offline_q')}</div></div><span class="chip warn">⟳</span></div>`)}
          ${waiting.map((v) => h`<div class="vrow">${v.photo ? h`<img class="vphoto" src="${v.photo}" alt="">` : h`<div class="vphoto" style="display:grid;place-items:center">${icon('users')}</div>`}<div class="grow"><b style="font-size:20px">${v.name}</b><div style="color:#b9cbc1">${v.flatNo} · ${v.purpose}</div>${chip(v.status)}</div>${v.status === 'pending' ? '' : h`<button class="btn primary" style="min-height:64px;font-size:19px" data-in="${v.id}">${t('enter')}</button>`}</div>`)}
          ${!waiting.length && !queued.length ? h`<div style="color:#8fa89a;padding:24px 0">-</div>` : ''}</div>
        <div class="panel"><h2 style="font-size:22px;margin-bottom:8px">${t('inside_now')} (${inside.length})</h2>${inside.map((v) => h`<div class="vrow">${v.photo ? h`<img class="vphoto" src="${v.photo}" alt="">` : h`<div class="vphoto" style="display:grid;place-items:center">${icon('users')}</div>`}<div class="grow"><b style="font-size:20px">${v.name}</b><div style="color:#b9cbc1">${v.flatNo} · ${timeFmt(v.entryAt)}</div></div><button class="btn" style="min-height:64px;font-size:19px" data-out="${v.id}">${t('exit')}</button></div>`)}${!inside.length ? h`<div style="color:#8fa89a;padding:24px 0">-</div>` : ''}</div>
      </div></div></div>`);
    $('#lang').value = document.documentElement.lang; $('#lang').onchange = async (e) => { const { setLang } = await import('./i18n.js'); setLang(e.target.value); };
    $('#out').onclick = () => { setSession(null, null); location.hash = '#/login'; };
    $('#new').onclick = () => newVisitor(refresh); $('#code').onclick = () => codeEntry(refresh);
    root.onclick = async (e) => {
      const i = e.target.closest('[data-in]'), o = e.target.closest('[data-out]');
      const act = i ? ['entry', i.dataset.in] : o ? ['exit', o.dataset.out] : null; if (!act) return;
      if (!online()) return toast(t('offline_err'), 'bad');
      try { await api('POST', `/visitors/${act[1]}/${act[0]}`); await refresh(); } catch (er) { toast(er.message, 'bad'); }
    };
  };
  draw(); refresh();
  pollTimer = setInterval(() => { if (location.hash.startsWith('#/app/gate')) refresh(); else clearInterval(pollTimer); }, 8000);
  netHandler = () => refresh(); window.addEventListener('online', netHandler); window.addEventListener('offline', netHandler);
}

function newVisitor(done) {
  let photo = null; let enhance = true; let file = null;
  const m = openModal(h`<h2 style="font-size:24px;margin-bottom:16px">${t('new_visitor')}</h2><form id="nv" class="stack" novalidate>
    <div class="field"><label for="v-name">${t('visitor_name')}</label><input id="v-name" class="input" autocomplete="off" required autofocus></div>
    <div class="grid2"><div class="field"><label for="v-phone">${t('phone')}</label><input id="v-phone" class="input" inputmode="numeric" maxlength="10" required></div><div class="field"><label for="v-flat">${t('flat_no')}</label><input id="v-flat" class="input" placeholder="T07-1203" autocapitalize="characters" required></div></div>
    <div class="field"><label for="v-purpose">${t('purpose')}</label><div class="seg" id="v-purpose" style="gap:6px">${['Guest', 'Delivery', 'Service', 'Cab'].map((p, i) => h`<button type="button" data-p="${p}" aria-pressed="${i === 0}" style="min-height:52px;font-size:17px;background:#1f3329;color:#fff">${p}</button>`)}</div></div>
    <div class="row"><label class="btn grow" style="cursor:pointer">${icon('cam')}<span id="ph-l">${t('take_photo')}</span><input type="file" accept="image/*" capture="environment" id="v-file" class="sr"></label><img id="v-prev" class="vphoto hide" alt=""></div>
    <label class="row" style="font-size:16px"><input type="checkbox" id="v-enh" checked style="width:22px;height:22px"> ${t('night_enhance')}</label>
    <div class="errmsg" id="v-err" style="font-size:16px"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-close>${t('cancel')}</button><button class="btn primary" type="submit" id="v-go" style="min-width:220px">${t('register')}</button></div></form>`, { label: t('new_visitor') });
  let purpose = 'Guest';
  $('#v-purpose', m.el).onclick = (e) => { const b = e.target.closest('[data-p]'); if (!b) return; purpose = b.dataset.p; $$('[data-p]', m.el).forEach((x) => x.setAttribute('aria-pressed', x === b)); };
  const setPhoto = async () => { if (!file) return; try { photo = await photoFromFile(file, enhance); const p = $('#v-prev', m.el); p.src = photo; p.classList.remove('hide'); $('#ph-l', m.el).textContent = t('retake'); } catch { toast('Could not read photo', 'bad'); } };
  $('#v-file', m.el).onchange = (e) => { file = e.target.files[0]; setPhoto(); }; $('#v-enh', m.el).onchange = (e) => { enhance = e.target.checked; setPhoto(); };
  $('#nv', m.el).onsubmit = async (e) => {
    e.preventDefault(); const err = $('#v-err', m.el); err.textContent = '';
    const body = { name: $('#v-name', m.el).value.trim(), phone: $('#v-phone', m.el).value.trim(), flatNo: $('#v-flat', m.el).value.trim().toUpperCase(), purpose, photo, clientId: 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) };
    if (body.name.length < 2) return (err.textContent = t('visitor_name') + '?');
    if (!/^[6-9]\d{9}$/.test(body.phone)) return (err.textContent = t('phone') + ': 10 digits');
    if (!/^T\d{2}-\d{4}$/.test(body.flatNo)) return (err.textContent = t('flat_no') + ': T07-1203');
    await busy($('#v-go', m.el), async () => {
      try { await api('POST', '/visitors', body); m.close(); toast('✓'); done(); }
      catch (er) {
        if (er.offline || er.status >= 500) { const q = read(QK, []); q.push(body); if (write(QK, q)) { m.close(); toast(t('offline_q')); done(); } else err.textContent = 'Storage full'; }
        else err.textContent = er.message;
      }
    });
  };
}

function codeEntry(done) {
  let code = '';
  const m = openModal(h`<h2 style="font-size:24px;margin-bottom:12px">${t('enter_code')}</h2><div class="center mono" id="cd" style="font:800 56px var(--display);letter-spacing:.2em;min-height:76px">······</div><div class="errmsg center" id="cd-err" style="font-size:17px;min-height:26px"></div>
    <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => h`<button data-k="${n}">${n}</button>`)}<button data-k="back" aria-label="Back">⌫</button><button data-k="0">0</button><button data-k="ok" style="background:#2BD08A;color:#05281a">✓</button></div>`, { label: t('enter_code') });
  const show = () => ($('#cd', m.el).textContent = (code + '······').slice(0, 6));
  m.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-k]'); if (!b) return; const k = b.dataset.k; const err = $('#cd-err', m.el); err.textContent = '';
    if (k === 'back') code = code.slice(0, -1); else if (k === 'ok') {
      if (code.length !== 6) return (err.textContent = '6 digits');
      if (!online()) return (err.textContent = t('offline_err'));
      try { const r = await api('POST', '/guest-codes/redeem', { code }); m.close(); toast(`✓ ${r.visitor.name} · ${r.visitor.flatNo}`); done(); } catch (er) { err.textContent = er.message; }
    } else if (code.length < 6) code += k; show();
  });
}
