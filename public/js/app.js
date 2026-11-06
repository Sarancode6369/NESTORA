import { h, mount, $, $$, api, session, setSession, toast, busy, icon, chip } from './ui.js';
import { t, setLang, getLang, LANGS } from './i18n.js';
import { landingView, langSelect } from './landing.js';
import * as R from './views-resident.js';
import * as S from './views-staff.js';
import { gateView, syncQueue } from './views-gate.js';

const root = document.getElementById('app');
let cleanups = [];
const leave = () => { cleanups.forEach((f) => { try { f(); } catch { /* ignore */ } }); cleanups = []; root.onclick = null; root.onchange = null; root.onkeydown = null; };

const HOME = { resident: '#/app/home', helpdesk: '#/app/desk', committee: '#/app/committee', guard: '#/app/gate' };
const NAV = {
  resident: [['home', 'tab_home', 'home'], ['pay', 'tab_pay', 'pay'], ['complaints', 'tab_complaints', 'msg'], ['visitors', 'tab_visitors', 'users'], ['book', 'tab_book', 'cal'], ['chat', 'tab_chat', 'bot']],
  helpdesk: [['desk', 'tab_desk', 'desk'], ['payments', 'tab_payments', 'bank'], ['committee', 'tab_dashboard', 'chart'], ['admin', 'tab_admin', 'cog']],
  committee: [['committee', 'tab_dashboard', 'chart']],
};

function parse() {
  const raw = location.hash.replace(/^#/, '') || '/'; const [path, qs] = raw.split('?');
  return { path, parts: path.split('/').filter(Boolean), params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

async function route() {
  leave();
  const { path, parts, params } = parse();
  window.scrollTo(0, 0);
  if (!parts.length) { document.title = 'NESTORA — Better Living. Smarter Communities.'; return landingView(root, cleanups); }
  if (parts[0] === 'login') { if (session.token && session.user) return (location.hash = HOME[session.user.role]); document.title = 'Sign in — NESTORA'; return authView(); }
  if (parts[0] === 'app') {
    if (!session.token || !session.user) return (location.hash = '#/login');
    const role = session.user.role; const page = parts[1] || '';
    const allowed = role === 'guard' ? ['gate'] : (NAV[role] || []).map((n) => n[0]).concat(role === 'resident' ? [] : []);
    if (!allowed.includes(page)) return (location.hash = HOME[role]);
    if (role === 'guard') { document.title = 'Gate — NESTORA'; return gateView(root); }
    shell(role, page);
    const main = $('#main');
    const title = { home: t('tab_home'), pay: t('tab_pay'), complaints: t('tab_complaints'), visitors: t('tab_visitors'), book: t('tab_book'), chat: t('tab_chat'), desk: t('tab_desk'), payments: t('tab_payments'), committee: t('tab_dashboard'), admin: t('tab_admin') }[page];
    document.title = `${title} — NESTORA`;
    const R_ = { home: () => R.homeView(main), pay: () => R.payView(main, params), complaints: () => (parts[2] === 'new' ? R.newComplaintView(main) : parts[2] ? R.complaintDetailView(main, parts[2]) : R.complaintsView(main)), visitors: () => R.visitorsView(main), book: () => R.bookView(main), chat: () => R.chatView(main), desk: () => S.deskView(main), payments: () => S.paymentsView(main), committee: () => S.committeeView(main), admin: () => S.adminView(main) };
    cleanups.push(() => { main.onclick = null; });
    return R_[page]();
  }
  location.hash = '#/';
}

function shell(role, page) {
  const nav = NAV[role]; const u = session.user;
  mount(root, h`<div class="shell"><header class="topbar"><div class="in"><a href="${HOME[role]}"><img src="/logo.png" alt="NESTORA"></a>
    <nav class="sidenav hide-m grow" style="margin-left:12px" aria-label="Main">${nav.map(([k, l, ic]) => h`<a href="#/app/${k}" ${k === page ? 'aria-current="page"' : ''}>${icon(ic)}${t(l)}</a>`)}</nav><div class="grow hide" id="sp"></div>
    ${langSelect()}<div class="row" style="gap:8px"><div class="avatar" aria-hidden="true">${u.name.split(' ').map((x) => x[0]).slice(0, 2).join('')}</div><div class="hide-m small" style="line-height:1.2"><b>${u.name.replace(' (demo)', '')}</b><br><span class="muted tiny">${t('role_' + u.role)}${u.flatNo ? ' · ' + u.flatNo : ''}</span></div></div><button class="btn ghost sm" id="logout" aria-label="${t('logout')}" title="${t('logout')}">${icon('logout')}</button></div></header>
    <div class="banner warn" style="border-radius:0;border-width:0 0 1px;justify-content:center;padding:6px 16px;font-size:12.5px"><b>${t('demo_banner')}</b></div>
    <main class="main" id="main" tabindex="-1"></main>
    <nav class="tabbar" aria-label="Main">${nav.map(([k, l, ic]) => h`<a href="#/app/${k}" ${k === page ? 'aria-current="page"' : ''}>${icon(ic)}<span>${t(l)}</span></a>`)}</nav></div>`);
  $('#logout').onclick = () => { setSession(null, null); location.hash = '#/login'; toast(t('logout')); };
}

// ================= Auth =================
const DEMOS = [['9000000001', 'Neeraj Kulkarni', 'T07-1203 · owner'], ['9000000002', 'Swati Joshi', 'T12-0408 · tenant'], ['9000000003', 'Aamir Shaikh', 'T21-1601 · owner'], ['9000000010', 'Help Desk Staff', 'help desk'], ['9000000020', 'Committee Member', 'committee'], ['9000000030', 'Gate Guard', 'gate tablet']];
function authView() {
  let phone = '', demoOtp = '';
  const side = h`<aside class="authside"><img class="bg" src="/frames/f001.jpg" alt="NESTORA township at sunset"><div class="cap"><h2>${t('hero_l1')} ${t('hero_l2')}</h2></div></aside>`;
  const stepPhone = () => mount($('#af'), h`<div><h1 style="font-size:32px">${t('login_title')}</h1><p class="muted" style="margin-top:6px">${t('login_sub')}</p></div>
    <div class="banner warn"><b>${t('demo_banner')}</b></div>
    <form id="pf" class="stack" novalidate><div class="field"><label for="ph">${t('mobile')}</label><input id="ph" class="input" inputmode="numeric" autocomplete="tel" maxlength="10" placeholder="9000000001" value="${phone}" autofocus><div class="errmsg" id="pe"></div></div><button class="btn primary lg" type="submit" id="pb">${t('send_otp')}</button></form>
    <div class="stack sm"><div class="small muted"><b>${t('demo_accounts')}</b></div><div class="demo-accts">${DEMOS.map(([p, n, d]) => h`<button class="demo-acct" data-p="${p}" type="button"><span><b>${n}</b><br><span class="tiny muted">${d}</span></span><span class="mono small muted">${p}</span></button>`)}</div></div>`);
  const requestOtp = async (btn) => {
    const err = $('#pe'); err.textContent = ''; phone = $('#ph').value.trim();
    if (!/^[6-9]\d{9}$/.test(phone)) return (err.textContent = '10-digit mobile number');
    await busy(btn, async () => { try { const r = await api('POST', '/auth/request-otp', { phone }); demoOtp = r.demoOtp; stepOtp(); } catch (e) { err.textContent = e.message; } });
  };
  const stepOtp = () => {
    mount($('#af'), h`<div><h1 style="font-size:32px">${t('otp')}</h1><p class="muted" style="margin-top:6px">+91 ${phone}</p></div>
      <div class="banner warn"><div><b>${t('demo_otp_note')}</b> <span class="mono" style="font-size:18px;letter-spacing:.1em">${demoOtp}</span></div></div>
      <form id="of" class="stack" novalidate><div class="otpbox" id="ob">${[0, 1, 2, 3, 4, 5].map((i) => h`<input inputmode="numeric" maxlength="1" aria-label="digit ${i + 1}" data-i="${i}" autocomplete="${i === 0 ? 'one-time-code' : 'off'}">`)}</div><div class="errmsg" id="oe"></div><button class="btn primary lg" type="submit" id="ov">${t('verify')}</button><button class="btn ghost" type="button" id="back">${t('change_number')}</button></form>`);
    const boxes = $$('#ob input'); boxes[0].focus();
    boxes.forEach((b, i) => { b.oninput = () => { b.value = b.value.replace(/\D/g, '').slice(-1); if (b.value && boxes[i + 1]) boxes[i + 1].focus(); }; b.onkeydown = (e) => { if (e.key === 'Backspace' && !b.value && boxes[i - 1]) boxes[i - 1].focus(); }; b.onpaste = (e) => { const d = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6); if (d) { e.preventDefault(); d.split('').forEach((c, j) => (boxes[j].value = c)); boxes[Math.min(5, d.length)].focus(); } }; });
    $('#back').onclick = stepPhone;
    $('#of').onsubmit = async (e) => { e.preventDefault(); const otp = boxes.map((b) => b.value).join(''); const err = $('#oe'); err.textContent = ''; if (otp.length !== 6) return (err.textContent = '6 digits');
      await busy($('#ov'), async () => { try { const r = await api('POST', '/auth/verify-otp', { phone, otp }); setSession(r.token, r.user); location.hash = HOME[r.user.role]; } catch (er) { err.textContent = er.status === 401 ? t('otp_wrong') : er.message; } }); };
  };
  mount(root, h`<div class="authwrap">${side}<section class="authform"><a href="#/"><img src="/logo.png" alt="NESTORA"></a><div class="stack" id="af"></div><div class="row between small muted"><a href="#/">← ${t('nav_home')}</a>${langSelect()}</div></section></div>`);
  stepPhone();
  root.addEventListener('submit', (e) => { if (e.target.id === 'pf') { e.preventDefault(); requestOtp($('#pb')); } });
  root.onclick = async (e) => { const d = e.target.closest('[data-p]'); if (d) { $('#ph').value = d.dataset.p; requestOtp($('#pb')); } };
}

// language change re-renders the current route; selects inside any view are wired here
document.addEventListener('change', (e) => { if (e.target.matches('[data-lang]')) setLang(e.target.value); });
window.addEventListener('langchange', () => route());
window.addEventListener('hashchange', route);
window.addEventListener('online', () => syncQueue().catch(() => {}));
document.documentElement.lang = getLang();
route();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
