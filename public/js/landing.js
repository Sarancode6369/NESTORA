import { h, mount, $, $$, api, toast, busy, icon, money } from './ui.js';
import { t, LANGS, getLang, setLang } from './i18n.js';
import { Township, PLACES, TOWER_COUNT } from './township3d.js';
import { Journey } from './journey.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const portrait = () => window.innerWidth < 760;
export function langSelect(cls = 'langsel') {
  return h`<select class="${cls}" data-lang aria-label="${t('language')}">${LANGS.map(([c, n]) => h`<option value="${c}" ${getLang() === c ? 'selected' : ''}>${n}</option>`)}</select>`;
}
const hr = (n) => `${String(n).padStart(2, '0')}:00`;
// Journey chapters (position on the scroll track, 0..1). The footage runs: aerial -> approach -> gate -> lawns, pool and clubhouse.
const CHAPTERS = [['town', 0, 'ch_town'], ['gate', 0.5, 'ch_gate'], ['club', 0.8, 'ch_club']];

export function landingView(root, cleanups) {
  const mobile = portrait();
  mount(root, h`
  <header class="lnav" id="lnav"><div class="in"><a class="brand" href="#/" aria-label="NESTORA home"><img src="/logo-light.png" alt="NESTORA Smart Township" data-dark="/logo.png"></a>
    <nav class="links nav-links grow" aria-label="Sections"><a class="l" href="#/" data-scroll="top">${t('nav_home')}</a><a class="l" href="#/" data-scroll="view360">360°</a><a class="l" href="#/" data-scroll="about">${t('nav_about')}</a><a class="l" href="#/" data-scroll="services">${t('nav_services')}</a><a class="l" href="#/" data-scroll="amenities">${t('nav_amenities')}</a><a class="l" href="#/" data-scroll="notices">${t('nav_notices')}</a><a class="l" href="#/" data-scroll="contact">${t('nav_contact')}</a></nav>
    <div class="links row" style="gap:10px">${langSelect()}<a class="signin" href="#/login">${icon('user')}${t('nav_signin')}</a></div><button class="menu" id="menu" aria-label="Menu" aria-expanded="false">${icon('menu')}</button></div></header>

  <main id="top">
  <div class="jtrack" id="jtrack" style="height:${reduced ? 330 : mobile ? 520 : 680}vh"><div class="jstage"><canvas id="jcanvas" role="img" aria-label="Aerial view of the NESTORA township, moving from the wide view to the entrance gate, clubhouse and swimming pool"></canvas><div class="jshade" id="jshade"></div>
    <div class="jhero" id="jhero">
      <span class="badge">${icon('pin')}${t('hero_badge')}</span>
      <h1><span>${t('hero_l1')}</span><span class="gold">${t('hero_l2')}</span></h1>
      <p>${t('hero_p')}</p>
      <a class="enter" href="#/login">${t('btn_enter')}${icon('arrowr')}</a>
      <div class="stats" aria-label="Township at a glance"><div>${icon('home')}<b>2,400</b><span>${t('st_res')}</span></div><div>${icon('building')}<b>28</b><span>${t('st_tow')}</span></div><div>${icon('users')}<b>180</b><span>${t('st_staff')}</span></div></div>
    </div>
    <div class="jcap" id="cap-gate"><span>${t('ch_gate')}</span><p>${t('gate_cap')}</p></div>
    <div class="jcap" id="cap-club"><span>${t('ch_club')}</span><p>${t('club_cap')}</p><button class="jnext" data-scroll="view360">${t('jump_3d')}${icon('arrowd')}</button></div>
    <button class="jdown" id="jdown" aria-label="Scroll down">${icon('arrowd')}</button>
    <div class="jdots" role="tablist" aria-label="Journey chapters">${CHAPTERS.map(([k, , l], i) => h`<button role="tab" data-ch="${i}" aria-label="${t(l)}" aria-selected="${i === 0}"><i></i></button>`)}</div>
  </div></div>

  <section class="v360" id="view360"><canvas id="v360c" role="img" aria-label="Interactive 3D model of the township. Drag to rotate, scroll to zoom."></canvas>
    <div class="v360-head"><div class="eyebrow-d" style="color:var(--champagne)">360°</div><h2>${t('view360_title')}</h2><p>${t('view360_sub')}</p></div>
    <div class="chips" id="chips">${Object.entries(PLACES).map(([k, p], i) => h`<button data-place="${k}" aria-pressed="${i === 0}">${p.label}</button>`)}</div>
    <div class="v360-ctl" role="group" aria-label="3D controls"><button data-z="0.8" aria-label="Zoom in">${icon('plus')}</button><button data-z="1.25" aria-label="Zoom out">${icon('minus')}</button><button data-r="-0.4" aria-label="Rotate left">${icon('rot')}</button></div>
    <div class="info hide" id="info"></div></section>

  <section class="section" id="about"><div class="wrap"><div class="rv"><div class="eyebrow-d">${t('nav_about')}</div><h2>${t('about_title')}</h2><p class="lead">${t('about_copy')}</p></div>
    <div class="numbers rv"><div><b data-count="2400">2,400</b><span>${t('n_apts')}</span></div><div><b data-count="${TOWER_COUNT}">28</b><span>${t('n_towers')}</span></div><div><b data-count="180">180</b><span>${t('n_staff')}</span></div><div><b data-count="4">4</b><span>${t('n_gates')}</span></div></div></div></section>

  <section class="section alt" id="services"><div class="wrap"><div class="rv"><div class="eyebrow-d">${t('nav_services')}</div><h2>${t('svc_title')}</h2><p class="lead">${t('feat_sub')}</p></div>
    <div class="fgrid">${[['pay', 'f1'], ['bank', 'f2'], ['msg', 'f3'], ['shield', 'f4'], ['door', 'f5'], ['chart', 'f6']].map(([ic, k], i) => h`<div class="fcard rv" style="--d:${i * 60}ms">${icon(ic)}<h3>${t(k + '_t')}</h3><p>${t(k + '_d')}</p></div>`)}</div></div></section>

  <section class="section" id="amenities"><div class="wrap"><div class="rv"><div class="eyebrow-d">${t('nav_amenities')}</div><h2>${t('amen_title')}</h2><p class="lead">${t('amen_sub')}</p></div><div class="agrid" id="agrid"><div class="skel" style="height:190px"></div><div class="skel" style="height:190px"></div><div class="skel" style="height:190px"></div></div></div></section>

  <section class="section alt" id="notices"><div class="wrap"><div class="rv"><div class="eyebrow-d">${t('nav_notices')}</div><h2>${t('notices_title')}</h2></div><div class="stack rv" id="nlist" style="margin-top:32px;max-width:820px"><div class="skel" style="height:80px"></div></div></div></section>

  <section class="section" id="contact"><div class="wrap" style="max-width:720px"><div class="rv"><div class="eyebrow-d">${t('nav_contact')}</div><h2>${t('contact_title')}</h2><p class="lead" style="margin-bottom:28px">${t('contact_sub')}</p></div>
    <form class="card stack rv" id="cform" novalidate><div class="grid2"><div class="field"><label for="c-n">${t('c_name')}</label><input class="input" id="c-n" required maxlength="80" autocomplete="name"></div><div class="field"><label for="c-p">${t('c_phone')}</label><input class="input" id="c-p" inputmode="numeric" maxlength="10" autocomplete="tel"></div></div><div class="field"><label for="c-m">${t('c_msg')}</label><textarea class="input" id="c-m" required maxlength="1000"></textarea></div><div class="errmsg" id="c-e"></div><button class="btn dark lg" type="submit" style="align-self:flex-start">${t('c_send')}</button></form></div></section></main>
  <footer class="foot"><div class="wrap"><img src="/logo.png" alt="NESTORA"><span>${t('foot_note')} · ${t('demo_banner')}</span></div></footer>`);

  // ---------- nav ----------
  const nav = $('#lnav'), track = $('#jtrack'), logo = $('.brand img'); let lastY = scrollY;
  const trackRange = () => track.offsetHeight - window.innerHeight;
  const progress = () => { const r = track.getBoundingClientRect(); const range = trackRange(); return range > 0 ? Math.min(1, Math.max(0, -r.top / range)) : 0; };
  const scrollToP = (p) => window.scrollTo({ top: track.offsetTop + p * trackRange(), behavior: reduced ? 'auto' : 'smooth' });
  $('#menu').onclick = () => { const o = nav.classList.toggle('open'); $('#menu').setAttribute('aria-expanded', o); onScroll(); };
  root.addEventListener('click', (e) => {
    const s = e.target.closest('[data-scroll]'); if (s) { e.preventDefault(); nav.classList.remove('open'); if (s.dataset.scroll === 'top') return window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }); $('#' + s.dataset.scroll)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' }); }
    const c = e.target.closest('[data-ch]'); if (c) scrollToP(CHAPTERS[+c.dataset.ch][1] + 0.01);
  });
  $('#jdown').onclick = () => scrollToP(Math.min(1, progress() + 0.2));
  root.addEventListener('change', (e) => { if (e.target.matches('[data-lang]')) setLang(e.target.value); });

  // ---------- cinematic image sequence ----------
  const jr = new Journey($('#jcanvas'), { count: 270, reduced, step: mobile ? 2 : 1 }); cleanups.push(() => jr.destroy());
  jr.load(); let ticking = false;
  const hero = $('#jhero'), shade = $('#jshade'), capG = $('#cap-gate'), capC = $('#cap-club'), down = $('#jdown');
  function onScroll() {
    const p = progress(); jr.progress = p;
    const inTrack = scrollY < track.offsetTop + trackRange() - 40; const goingDown = scrollY > lastY; lastY = scrollY;
    // nav: transparent over the film, tucks away while scrubbing down, solid once the film ends
    nav.classList.toggle('solid', !inTrack || nav.classList.contains('open')); nav.classList.toggle('tuck', inTrack && p > 0.06 && goingDown && !nav.classList.contains('open'));
    logo.src = nav.classList.contains('solid') && !nav.classList.contains('open') ? logo.dataset.dark : '/logo-light.png';
    const f = Math.max(0, 1 - p / 0.07); hero.style.opacity = f; hero.style.transform = `translateY(${(1 - f) * -28}px)`; hero.style.visibility = f <= 0 ? 'hidden' : 'visible'; shade.style.opacity = Math.max(0, 1 - p / 0.12);
    capG.classList.toggle('on', p >= 0.46 && p < 0.7); capC.classList.toggle('on', p >= 0.8); down.style.opacity = p < 0.97 ? 1 : 0;
    const ci = p >= 0.8 ? 2 : p >= 0.5 ? 1 : 0; $$('.jdots button').forEach((b, i) => b.setAttribute('aria-selected', i === ci));
  }
  const raf = () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; onScroll(); }); } };
  window.addEventListener('scroll', raf, { passive: true }); window.addEventListener('resize', raf); onScroll(); cleanups.push(() => { window.removeEventListener('scroll', raf); window.removeEventListener('resize', raf); });

  // ---------- genuine interactive 3D ----------
  const info = $('#info');
  const showTower = (tw) => {
    if (!tw) return info.classList.add('hide');
    const sample = { 7: 'T07-1203', 12: 'T12-0408', 21: 'T21-1601' }[tw.id];
    mount(info, h`<div class="row between"><b style="font:700 20px var(--display)">Tower ${tw.label}</b><span class="chip gold">${t('tower_sel')}</span></div><p class="small muted" style="margin:8px 0 12px">${tw.floors} floors · ${t('tower_flats')}</p>${sample ? h`<div class="small" style="margin-bottom:12px">Demo flat <b>${sample}</b> is in this tower.</div>` : ''}<a class="btn dark sm" href="#/login">${t('tower_open')}</a>`);
    info.classList.remove('hide');
  };
  const tw = new Township($('#v360c'), { onSelect: showTower }); tw.autoRotate = true; cleanups.push(() => tw.destroy());
  $('#chips').onclick = (e) => { const b = e.target.closest('[data-place]'); if (!b) return; $$('#chips button').forEach((x) => x.setAttribute('aria-pressed', x === b)); tw.autoRotate = false; tw.select(null); info.classList.add('hide'); tw.flyTo(b.dataset.place); };
  $('.v360-ctl').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.z) tw.zoom(+b.dataset.z); if (b.dataset.r) tw.rotate(+b.dataset.r); };

  // ---------- reveal on scroll + counters ----------
  const io = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.15 });
  $$('.rv').forEach((n) => { if (reduced) n.classList.add('in'); else io.observe(n); }); cleanups.push(() => io.disconnect());
  const co = new IntersectionObserver((es) => es.forEach((en) => { if (!en.isIntersecting) return; co.unobserve(en.target); const to = +en.target.dataset.count; if (reduced) return; const s = performance.now(); const f = (n) => { const q = Math.min(1, (n - s) / 1100); en.target.textContent = Math.round(to * (1 - Math.pow(1 - q, 3))).toLocaleString('en-IN'); if (q < 1) requestAnimationFrame(f); }; requestAnimationFrame(f); }), { threshold: 0.6 });
  $$('[data-count]').forEach((n) => co.observe(n)); cleanups.push(() => co.disconnect());

  // ---------- live data: amenities + notices come from the database ----------
  api('GET', '/public/amenities').then(({ amenities }) => mount($('#agrid'), h`${amenities.map((a, i) => h`<article class="acard rv in" style="--d:${i * 70}ms"><div class="eyebrow-d" style="margin-bottom:10px">${hr(a.openHour)} – ${hr(a.closeHour)}</div><h3>${a.name}</h3><p class="muted small" style="margin:8px 0 16px">${a.rules}</p><div class="row between"><b class="mono">${money(a.fee)}</b><span class="small muted">${t('per_slot')} · ${a.slotHours}h</span></div></article>`)}`)).catch(() => mount($('#agrid'), ''));
  api('GET', '/public/notices').then(({ notices }) => mount($('#nlist'), notices.length ? h`${notices.map((n) => h`<article class="ncard"><div class="row between wrap"><b>${n.title}</b><span class="tiny muted">${new Date(n.postedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span></div><p class="muted small" style="margin-top:6px">${n.body}</p></article>`)}` : h`<div class="muted">${t('no_notices')}</div>`)).catch(() => mount($('#nlist'), ''));

  // ---------- contact ----------
  $('#cform').onsubmit = async (e) => {
    e.preventDefault(); const err = $('#c-e'); err.textContent = '';
    const body = { name: $('#c-n').value.trim(), phone: $('#c-p').value.trim(), message: $('#c-m').value.trim() };
    if (body.name.length < 2 || body.message.length < 5) { err.textContent = `${t('c_name')} / ${t('c_msg')}`; return; }
    await busy(e.target.querySelector('button'), async () => { try { await api('POST', '/contact', body); toast(t('c_ok')); e.target.reset(); } catch (er) { err.textContent = er.message; } });
  };
}
