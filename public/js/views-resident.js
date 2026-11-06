import { h, raw, mount, $, $$, api, session, toast, openModal, confirmDialog, busy, money, dateFmt, dtFmt, timeFmt, mins, icon, chip, hourLabel } from './ui.js';
import { t } from './i18n.js';

const skel = (n = 3) => h`<div class="stack">${Array.from({ length: n }, () => h`<div class="skel" style="height:110px"></div>`)}</div>`;
const errBox = (e, retry) => h`<div class="banner bad"><div><b>${t('error')}</b><br>${e.message}</div>${retry ? h`<button class="btn sm" data-retry style="margin-left:auto">${t('retry')}</button>` : ''}</div>`;
export async function load(root, fn) {
  mount(root, skel());
  try { await fn(); } catch (e) { mount(root, errBox(e, true)); root.querySelector('[data-retry]')?.addEventListener('click', () => load(root, fn)); }
}
const head = (title, sub, right = '') => h`<div class="pagehead"><div><h1>${title}</h1>${sub ? h`<p>${sub}</p>` : ''}</div>${right}</div>`;
const stLabel = (s) => t('st_' + s);

// ================= HOME =================
export function homeView(root) {
  return load(root, async () => {
    const d = await api('GET', `/flats/${session.user.flatNo}/dashboard`);
    const m = d.maintenance; const kind = m.status === 'paid' ? 'ok' : m.status === 'overdue' ? 'bad' : 'warn';
    mount(root, h`
      ${head(h`${t('hello')}, ${d.resident?.name?.split(' ')[0] || session.user.name.split(' ')[0]}`, h`${t('flat')} ${d.flat.flatNo} · ${d.flat.area.toLocaleString('en-IN')} sq ft`)}
      <div class="grid3" style="margin-bottom:20px">
        <a class="tile" href="#/app/pay"><span class="k">${t('maint_due')}</span><span class="v">${m.outstanding > 0 ? money(m.outstanding) : t('all_paid')}</span>
          <span class="s">${m.status === 'overdue' ? h`<span class="chip bad">${m.daysOverdue} ${t('overdue_days')}</span>` : m.status === 'due' ? h`<span class="chip warn">${t('due_by')} ${dateFmt(m.oldestDueDate)}</span>` : h`<span class="chip ok">${t('all_paid')}</span>`}</span></a>
        <a class="tile" href="#/app/complaints"><span class="k">${t('open_complaints')}</span><span class="v">${d.openComplaints}</span><span class="s">${d.openComplaints ? d.openComplaintList.slice(0, 2).map((c) => h`${c.title} · ${stLabel(c.status)}<br>`) : t('none_open')}</span></a>
        <a class="tile" href="#/app/visitors"><span class="k">${t('visitors_today')}</span><span class="v">${d.visitorsToday}</span><span class="s">${d.pendingApprovals ? h`<span class="chip warn">${d.pendingApprovals} ${t('awaiting_you')}</span>` : ''}</span></a>
      </div>
      ${d.pendingApprovals ? h`<div class="banner warn" style="margin-bottom:20px"><div><b>${t('pending_approvals')}</b></div><a class="btn sm" href="#/app/visitors" style="margin-left:auto">${t('approve')}</a></div>` : ''}
      <h3 style="margin:28px 0 12px;font-size:15px;color:var(--muted)" class="small">${t('quick_actions')}</h3>
      <div class="actions">
        <a class="action primary" href="#/app/pay?pay=1">${icon('pay')}${t('pay_maint')}</a>
        <a class="action" href="#/app/complaints/new">${icon('plus')}${t('raise_complaint')}</a>
        <a class="action" href="#/app/complaints">${icon('msg')}${t('track_complaint')}</a>
        <a class="action" href="#/app/pay">${icon('file')}${t('view_bills')}</a>
      </div>
      <h3 style="margin:36px 0 12px">${t('notices')}</h3>
      <div class="card pad0">${d.notices.length ? d.notices.map((n) => h`<div style="padding:16px 20px;border-bottom:1px solid var(--line)"><div class="row between"><b>${n.title}</b><span class="tiny muted">${dateFmt(n.postedAt.slice(0, 10))}</span></div><p class="muted small" style="margin-top:4px">${n.body}</p></div>`) : h`<div class="empty">-</div>`}</div>`);
  });
}

// ================= PAY =================
let payTab = 'bills';
export function payView(root, params) {
  return load(root, async () => {
    const flat = session.user.flatNo;
    const [b, l, r] = await Promise.all([api('GET', `/flats/${flat}/bills`), api('GET', `/flats/${flat}/ledger`), api('GET', `/flats/${flat}/receipts`)]);
    const draw = () => {
      mount(root, h`
        ${head(t('pay_maint'), t('rate_note') + ' · ' + t('test_mode'), b.outstanding > 0 ? h`<button class="btn primary lg" data-pay>${t('pay_now')} · ${money(b.outstanding)}</button>` : h`<span class="chip ok">${t('all_paid')}</span>`)}
        <div class="tabs" role="tablist" style="margin-bottom:20px">${['bills', 'ledger', 'receipts'].map((k) => h`<button class="tab" role="tab" data-tab="${k}" aria-selected="${payTab === k}">${t(k)}</button>`)}</div>
        ${payTab === 'bills' ? billsTable(b) : payTab === 'ledger' ? ledgerTable(l) : receiptsTable(r)}`);
    };
    const billsTable = (b) => b.bills.length ? h`<div class="card pad0 tablewrap"><table class="cards-on-mobile"><thead><tr><th>${t('period')}</th><th class="num">${t('amount')}</th><th class="num">${t('paid')}</th><th class="num">${t('balance')}</th><th>${t('status')}</th></tr></thead><tbody>${b.bills.map((x) => h`<tr><td data-l="${t('period')}"><b>${new Date(x.period + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</b><div class="tiny muted">${x.area} sq ft × ₹${x.rate}${x.lateFee ? h` · ${t('late_fee')} ${money(x.lateFee)}` : ''}</div></td><td class="num" data-l="${t('amount')}">${money(x.amount)}</td><td class="num" data-l="${t('paid')}">${money(x.paid)}</td><td class="num" data-l="${t('balance')}">${money(x.due)}</td><td data-l="${t('status')}">${chip(x.status === 'unpaid' && x.daysOverdue > 0 ? 'overdue' : x.status, x.status === 'unpaid' && x.daysOverdue > 0 ? `${x.daysOverdue} ${t('overdue_days')}` : undefined)}</td></tr>`)}</tbody></table></div>` : h`<div class="empty"><b>${t('no_bills')}</b></div>`;
    const ledgerTable = (l) => h`<div class="card pad0 tablewrap"><table class="cards-on-mobile"><thead><tr><th>${t('date')}</th><th>${t('description')}</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">${t('balance')}</th></tr></thead><tbody>${l.rows.slice().reverse().map((e) => h`<tr><td data-l="${t('date')}">${dateFmt(e.date)}</td><td data-l="${t('description')}">${e.kind === 'bill' ? `Maintenance ${e.period}` : e.kind === 'late_fee' ? (e.note || 'Late fee') : `Payment${e.method ? ' · ' + e.method : ''}${e.receiptNo ? ' · ' + e.receiptNo : ''}`}</td><td class="num" data-l="Debit">${e.kind !== 'payment' ? money(e.amount) : ''}</td><td class="num" data-l="Credit">${e.kind === 'payment' ? money(e.amount) : ''}</td><td class="num" data-l="${t('balance')}"><b>${money(e.balance)}</b></td></tr>`)}</tbody></table></div>`;
    const receiptsTable = (r) => r.receipts.length ? h`<div class="card pad0 tablewrap"><table class="cards-on-mobile"><thead><tr><th>${t('receipt_no')}</th><th>${t('date')}</th><th>${t('method')}</th><th class="num">${t('amount')}</th><th></th></tr></thead><tbody>${r.receipts.map((e) => h`<tr><td data-l="${t('receipt_no')}"><b>${e.receiptNo}</b></td><td data-l="${t('date')}">${dateFmt(e.date)}</td><td data-l="${t('method')}">${e.method}</td><td class="num" data-l="${t('amount')}">${money(e.amount)}</td><td class="right"><button class="btn sm" data-receipt="${e.receiptNo}">${t('download_receipt')}</button></td></tr>`)}</tbody></table></div>` : h`<div class="empty"><b>${t('no_receipts')}</b></div>`;
    draw();
    root.onclick = (e) => {
      const tab = e.target.closest('[data-tab]'); if (tab) { payTab = tab.dataset.tab; draw(); return; }
      if (e.target.closest('[data-pay]')) checkout(b.outstanding, () => payView(root, {}));
      const rc = e.target.closest('[data-receipt]'); if (rc) printReceipt(r.receipts.find((x) => x.receiptNo === rc.dataset.receipt));
    };
    if (params?.pay && b.outstanding > 0) { history.replaceState(null, '', '#/app/pay'); checkout(b.outstanding, () => payView(root, {})); }
  });
}

function printReceipt(r) {
  const w = window.open('', '_blank'); if (!w) return toast('Allow pop-ups to print the receipt', 'bad');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  w.document.write(`<!doctype html><meta charset=utf-8><title>Receipt ${esc(r.receiptNo)}</title><body style="font:15px/1.6 system-ui;max-width:520px;margin:40px auto;padding:0 20px;color:#171C19"><h2 style="margin:0 0 4px;color:#124B39">NESTORA</h2><div style="color:#747C76">Maintenance payment receipt</div><hr style="border:0;border-top:1px solid #ddd;margin:20px 0"><table style="width:100%;font-size:15px"><tr><td>Receipt no.</td><td><b>${esc(r.receiptNo)}</b></td></tr><tr><td>Flat</td><td>${esc(r.flatNo)}</td></tr><tr><td>Date</td><td>${esc(r.date)}</td></tr><tr><td>Method</td><td>${esc(r.method)}</td></tr><tr><td>Amount</td><td><b>₹${Number(r.amount).toLocaleString('en-IN')}</b></td></tr></table><p style="margin-top:32px;font-size:12px;color:#747C76">Demo environment. This receipt was generated by a test-mode system and is not a legal receipt.</p><script>setTimeout(()=>print(),300)</script>`);
  w.document.close();
}

function checkout(outstanding, done) {
  const m = openModal(h`
    <div class="row between"><h3>${t('pay_maint')}</h3><span class="chip warn">${t('test_mode')}</span></div>
    <div class="banner warn" style="margin:14px 0">${t('test_note')}</div>
    <div class="stack">
      <div class="field"><label for="pay-amt">${t('pay_amount')}</label><input id="pay-amt" class="input mono" type="number" inputmode="decimal" min="1" max="${outstanding}" step="0.01" value="${outstanding}"><div class="hint">${t('total_due')}: ${money(outstanding)}</div><div class="errmsg" id="pay-err"></div></div>
      <div class="field"><label>${t('method')}</label><div class="seg" id="pay-method" role="group">${[['upi', 'pay_upi'], ['card', 'pay_card'], ['netbanking', 'pay_net']].map(([k, l], i) => h`<button type="button" data-m="${k}" aria-pressed="${i === 0}">${t(l)}</button>`)}</div></div>
      <button class="btn primary lg" id="pay-go">${t('confirm_pay')}</button>
      <button class="btn ghost" id="pay-fail">${t('simulate_fail')}</button>
    </div>`, { label: t('pay_maint') });
  let method = 'upi';
  $('#pay-method', m.el).onclick = (e) => { const b = e.target.closest('[data-m]'); if (!b) return; method = b.dataset.m; $$('[data-m]', m.el).forEach((x) => x.setAttribute('aria-pressed', x === b)); };
  const run = (outcome) => async (ev) => {
    const amt = Number($('#pay-amt', m.el).value); const err = $('#pay-err', m.el); err.textContent = '';
    if (!(amt > 0) || amt > outstanding + 0.005) { err.textContent = `1 - ${money(outstanding)}`; return; }
    await busy(ev.currentTarget, async () => {
      try {
        const s = await api('POST', '/payments/checkout', { amount: amt });
        const r = await api('POST', `/payments/${s.sessionId}/complete`, { method, outcome });
        if (r.status === 'paid') { m.close(); toast(`${t('pay_ok')} · ${r.receipt.receiptNo}`); done(); }
        else err.textContent = t('pay_failed');
      } catch (e) { err.textContent = e.message; }
    });
  };
  $('#pay-go', m.el).onclick = run('ok'); $('#pay-fail', m.el).onclick = run('fail');
}

// ================= COMPLAINTS =================
const CATS = ['Plumbing', 'Electrical', 'Lift', 'Security', 'Cleaning', 'Civil', 'Other'];
const PRIOS = ['Low', 'Medium', 'High', 'Emergency'];
export function complaintsView(root) {
  return load(root, async () => {
    const { complaints } = await api('GET', '/complaints');
    mount(root, h`${head(t('my_complaints'), '', h`<a class="btn primary" href="#/app/complaints/new">${icon('plus')}${t('new_complaint')}</a>`)}
      ${complaints.length ? h`<div class="stack sm">${complaints.map((c) => h`<a class="card" href="#/app/complaints/${c.id}" style="display:block;color:inherit"><div class="row between wrap"><div><b>${c.title}</b><div class="small muted">${c.id} · ${t('cat_' + c.category)} · ${dtFmt(c.createdAt)}</div></div><div class="row">${c.urgency === 'Emergency' ? chip('Emergency', t('urg_Emergency')) : ''}${chip(c.status, stLabel(c.status))}</div></div>${c.linkedTo ? h`<div class="tiny muted" style="margin-top:8px">${t('linked_note')}</div>` : ''}</a>`)}</div>` : h`<div class="empty"><b>${t('no_complaints')}</b>${t('all_good')}<div style="margin-top:16px"><a class="btn primary" href="#/app/complaints/new">${t('new_complaint')}</a></div></div>`}`);
  });
}

async function shrink(file, max = 960, q = 0.72) {
  const bmp = await createImageBitmap(file).catch(() => null); if (!bmp) throw new Error('That file is not an image');
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height)); const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', q);
}

export function newComplaintView(root) {
  const photos = [];
  let aiState = { status: 'idle', result: null, error: null }; // status: 'idle' | 'loading' | 'success' | 'error' | 'fallback'
  let analyzeTimer = null;
  let lastAnalyzedText = '';

  const renderAiBox = () => {
    const el = $('#c-ai-box');
    if (!el) return;
    if (aiState.status === 'idle') {
      mount(el, h`<div class="tiny muted" style="margin-top:4px"><span class="chip" style="font-size:11px">AI</span> Enter details to receive automated category, priority, and summary suggestions.</div>`);
      return;
    }
    if (aiState.status === 'loading') {
      mount(el, h`<div class="card flat pad0" style="padding:14px;background:var(--soft);border:1px dashed var(--line-strong);border-radius:12px;margin-top:4px">
        <div class="row"><span class="spinner dk"></span><span class="small"><b>${t('ai_analyzing')}</b></span></div>
      </div>`);
      return;
    }
    if (aiState.status === 'error') {
      mount(el, h`<div class="banner bad" style="margin-top:4px">
        <div class="row between wrap grow">
          <div><b>${t('error')}</b><br><span class="small">${aiState.error || 'AI analysis failed'}</span></div>
          <button type="button" class="btn sm" id="c-ai-retry" style="margin-left:auto">${t('retry')}</button>
        </div>
      </div>`);
      $('#c-ai-retry')?.addEventListener('click', () => runAnalyze(true));
      return;
    }
    // success or fallback
    const res = aiState.result;
    if (!res) return;
    const isGroq = res.method === 'groq_ai';
    mount(el, h`
      ${!isGroq ? h`<div class="banner warn" style="margin-top:4px;margin-bottom:8px">
        <div>${icon('alert')}</div>
        <div class="grow"><b>${t('ai_fallback_notice')}</b><div class="tiny">${res.fallbackReason ? `Reason: ${res.fallbackReason}` : 'Automated keyword classifier active'}</div></div>
      </div>` : ''}
      <div class="card flat stack sm" style="padding:16px;background:var(--soft);border:1px solid var(--line-strong);border-radius:12px;margin-top:4px">
        <div class="row between wrap">
          <div class="row">
            <span class="chip ${isGroq ? 'info' : 'warn'}">${isGroq ? (res.model ? `AI · ${res.model}` : 'AI (Groq)') : 'Keyword Fallback'}</span>
            <span class="small" style="font-weight:700">${t('ai_suggestions')}</span>
          </div>
          ${res.confidence != null ? h`<span class="tiny muted">${Math.round(res.confidence * 100)}% confidence</span>` : ''}
        </div>
        ${res.safety?.triggered ? h`<div class="banner bad" style="margin:4px 0"><div>${icon('alert')}</div><div><b>Safety Escalation (${res.safety.labels.join(', ')})</b><br>${t('safety_banner')}</div></div>` : ''}
        ${res.summary ? h`<div class="small" style="background:#fff;padding:8px 12px;border-radius:8px;border:1px solid var(--line)"><b>${t('ai_summary')}:</b> ${res.summary}</div>` : ''}
        <div class="row wrap small">
          <div>${t('ai_suggested_cat')}: <b>${t('cat_' + res.category)}</b></div>
          <span>·</span>
          <div>${t('ai_suggested_prio')}: <b class="${res.priority === 'Emergency' ? 'bad' : ''}">${t('urg_' + res.priority)}</b></div>
        </div>
        ${res.explanation ? h`<div class="tiny muted">${res.explanation}</div>` : ''}
        ${res.needsReview ? h`<div class="chip warn" style="white-space:normal;height:auto;padding:6px 10px;line-height:1.35;align-self:flex-start">${t('ai_manual_review')}${res.reviewReasons?.length ? `: ${res.reviewReasons.join('; ')}` : ''}</div>` : ''}
      </div>
    `);
  };

  const runAnalyze = async (force = false) => {
    const desc = $('#c-desc')?.value.trim() || '';
    const title = $('#c-title')?.value.trim() || '';
    if (desc.length < 5) return;
    const key = `${title}:::${desc}`;
    if (!force && key === lastAnalyzedText) return;
    lastAnalyzedText = key;
    aiState = { status: 'loading', result: null, error: null };
    renderAiBox();
    try {
      const res = await api('POST', '/complaints/analyze', {
        title,
        description: desc,
        category: $('#c-cat')?.value || null,
      });
      aiState = { status: res.method === 'keyword_fallback' ? 'fallback' : 'success', result: res, error: null };
      renderAiBox();
      if (res.category && CATS.includes(res.category)) {
        $('#c-cat').value = res.category;
      }
      if (res.priority && PRIOS.includes(res.priority)) {
        $('#c-prio').value = res.priority;
      }
      if (res.safety?.triggered) {
        $('#c-prio').value = 'Emergency';
      }

      // Check for similar duplicate complaints
      try {
        const dupRes = await api('POST', '/complaints/duplicates/suggest', {
          title,
          description: desc,
          category: $('#c-cat')?.value || res.category || null,
        });
        duplicates = dupRes.candidates || [];
        renderDupBox();
      } catch {
        duplicates = [];
        renderDupBox();
      }
    } catch (err) {
      aiState = { status: 'error', result: null, error: err.message };
      renderAiBox();
    }
  };

  let duplicates = [];
  const renderDupBox = () => {
    const el = $('#c-dup-box');
    if (!el) return;
    if (!duplicates.length) { el.innerHTML = ''; return; }
    mount(el, h`
      <div class="card stack sm" style="background:#fffbeb;border:1px solid #fde68a;margin-top:10px">
        <div class="row" style="color:#b45309;font-weight:700">
          ${icon('alert')} <span>${t('dup_warning')} (${duplicates.length})</span>
        </div>
        <div class="small muted">${t('dup_similar_found')}</div>
        <div class="stack" style="gap:6px">
          ${duplicates.map((d) => h`
            <div style="background:#fff;border:1px solid #fef3c7;border-radius:6px;padding:8px 10px">
              <div class="row between">
                <b>[${d.id}] ${d.title}</b>
                <span class="chip sm info">${t('cat_' + d.category)} · ${stLabel(d.status)}</span>
              </div>
              <div class="tiny muted" style="margin-top:4px">${d.explanation || ''} (${t('dup_similarity')}: ${Math.round((d.similarity || 0) * 100)}%)</div>
            </div>
          `)}
        </div>
        <div class="tiny muted" style="font-style:italic">${t('dup_proceed_anyway')}</div>
      </div>
    `);
  };

  mount(root, h`${head(t('new_complaint'), '')}
    <form class="card stack" id="cf" novalidate style="max-width:640px">
      <div class="field"><label for="c-title">${t('title')}</label><input id="c-title" class="input" maxlength="120" required autocomplete="off"><div class="errmsg" data-e="title"></div></div>
      <div class="field">
        <div class="row between">
          <label for="c-desc">${t('details')}</label>
          <button type="button" class="btn sm ghost" id="c-ai-trigger" style="min-height:28px;padding:2px 8px;font-size:12px">${icon('refresh')}${t('ai_btn_analyze')}</button>
        </div>
        <textarea id="c-desc" class="input" maxlength="2000" required></textarea>
        <div class="errmsg" data-e="desc"></div>
        <div id="c-ai-box"></div>
        <div id="c-dup-box"></div>
      </div>
      <div class="grid2">
        <div class="field"><label for="c-cat">${t('category')}</label><select id="c-cat" class="input"><option value="">${t('auto_category')}</option>${CATS.map((c) => h`<option value="${c}">${t('cat_' + c)}</option>`)}</select></div>
        <div class="field"><label for="c-prio">${t('priority')}</label><select id="c-prio" class="input">${PRIOS.map((p) => h`<option value="${p}">${t('urg_' + p)}</option>`)}</select></div>
      </div>
      <div class="field"><label>${t('photos')}</label><div class="row wrap" id="c-photos"></div><label class="btn" style="align-self:flex-start">${icon('cam')}${t('add_photo')}<input type="file" accept="image/*" id="c-file" class="sr"></label></div>
      <div class="row" style="justify-content:flex-end"><a class="btn" href="#/app/complaints">${t('cancel')}</a><button class="btn primary" type="submit" id="c-go">${t('submit')}</button></div>
    </form>`);

  renderAiBox();

  const draw = () => mount($('#c-photos'), h`${photos.map((p, i) => h`<div style="position:relative"><img class="photo" src="${p}" alt="photo ${i + 1}"><button type="button" class="btn sm" data-rm="${i}" style="position:absolute;top:-8px;right:-8px;min-height:28px;padding:0 8px" aria-label="Remove">×</button></div>`)}`);
  $('#c-photos').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { photos.splice(+b.dataset.rm, 1); draw(); } };
  $('#c-file').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; if (photos.length >= 3) return toast('Up to 3 photos', 'bad'); try { photos.push(await shrink(f)); draw(); } catch (er) { toast(er.message, 'bad'); } };

  $('#c-desc').addEventListener('input', () => {
    clearTimeout(analyzeTimer);
    if ($('#c-desc').value.trim().length >= 5) {
      analyzeTimer = setTimeout(() => runAnalyze(false), 700);
    }
  });
  $('#c-desc').addEventListener('blur', () => {
    clearTimeout(analyzeTimer);
    if ($('#c-desc').value.trim().length >= 5) runAnalyze(false);
  });
  $('#c-ai-trigger').addEventListener('click', () => {
    const desc = $('#c-desc').value.trim();
    if (desc.length < 5) return toast('Enter problem details (5+ characters) first', 'bad');
    runAnalyze(true);
  });

  $('#c-prio').addEventListener('change', () => {
    if (aiState.result?.safety?.triggered && $('#c-prio').value !== 'Emergency') {
      $('#c-prio').value = 'Emergency';
      toast(t('ai_safety_locked'), 'bad');
    }
  });

  $('#cf').onsubmit = async (e) => {
    e.preventDefault(); const title = $('#c-title').value.trim(), desc = $('#c-desc').value.trim();
    $$('[data-e]').forEach((x) => (x.textContent = '')); let bad = false;
    if (title.length < 3) { $('[data-e=title]').textContent = 'Please enter a short title (3+ characters)'; bad = true; }
    if (desc.length < 5) { $('[data-e=desc]').textContent = 'Please describe the problem (5+ characters)'; bad = true; }
    if (bad) return;
    const cat = $('#c-cat').value || null;
    let prio = $('#c-prio').value || null;
    if (aiState.result?.safety?.triggered) prio = 'Emergency';
    const summary = aiState.result?.summary || null;
    await busy($('#c-go'), async () => {
      try {
        const r = await api('POST', '/complaints', { title, description: desc, category: cat, priority: prio, summary, photos });
        complaintResult(root, r.complaint);
      } catch (er) { toast(er.message, 'bad'); }
    });
  };
}

function complaintResult(root, c) {
  mount(root, h`${head(t('new_complaint'), c.id)}<div class="stack" style="max-width:640px">
    ${c.safety?.triggered ? h`<div class="banner bad"><div>${icon('alert')}</div><div><b>${c.safety.labels.join(', ')}</b><br>${t('safety_banner')}</div></div>` : ''}
    <div class="card stack sm"><div class="row between wrap"><b>${c.title}</b>${chip(c.status, stLabel(c.status))}</div>
      <div class="small muted">${t('suggested')}: ${t('cat_' + c.category)} · ${t('urgency')}: ${t('urg_' + c.urgency)}</div><div class="tiny muted">${t('suggested_note')}</div>
      <div class="small">${c.assignee ? h`${t('assigned_to')}: <b>${c.assignee.name}</b>` : t('not_assigned')}</div>
      ${c.linkedTo ? h`<div class="banner">${t('linked_note')}</div>` : ''}</div>
    <div class="row"><a class="btn primary" href="#/app/complaints/${c.id}">${t('track_complaint')}</a><a class="btn" href="#/app/home">${t('nav_home')}</a></div></div>`);
}

export function complaintDetailView(root, id) {
  return load(root, async () => {
    const { complaint: c } = await api('GET', `/complaints/${id}`);
    const resp = c.response; let rating = 0;
    mount(root, h`${head(c.title, h`${c.id} · ${t('cat_' + c.category)}`, h`<div class="row">${c.urgency === 'Emergency' ? chip('Emergency', t('urg_Emergency')) : ''}${chip(c.status, stLabel(c.status))}</div>`)}
      <div class="grid2" style="align-items:start">
        <div class="stack">
          ${c.safety?.triggered ? h`<div class="banner bad"><div>${icon('alert')}</div><div>${t('safety_banner')}</div></div>` : ''}
          <div class="card stack sm"><p>${c.description}</p>${c.photos?.length ? h`<div class="row wrap">${c.photos.map((p, i) => h`<img class="photo" src="${p}" alt="photo ${i + 1}">`)}</div>` : ''}
            <div class="small muted">${t('suggested')}: ${t('cat_' + c.category)} · ${t('urg_' + c.urgency)}. ${t('suggested_note')}</div></div>
          ${c.status === 'resolved' ? (c.rating ? h`<div class="card"><b>${t('rate_thanks')}</b><div class="stars" aria-label="${c.rating} of 5">${[1, 2, 3, 4, 5].map((n) => h`<span class="star ${n <= c.rating ? 'on' : ''}" style="cursor:default">★</span>`)}</div></div>` : h`<div class="card stack sm"><b>${t('rate_resolution')}</b><div class="stars" id="stars">${[1, 2, 3, 4, 5].map((n) => h`<button class="star" data-s="${n}" aria-label="${n}">★</button>`)}</div><div class="row"><button class="btn primary" id="rate-go" disabled>${t('submit')}</button><button class="btn" id="reopen">${t('reopen')}</button></div></div>`) : ''}
        </div>
        <div class="stack">
          <div class="card stack sm"><div class="row between"><span class="muted small">${t('assigned_to')}</span><b>${c.assignee ? c.assignee.name : t('not_assigned')}</b></div>
            <div class="row between"><span class="muted small">${resp.state === 'responded' ? t('responded') : resp.state === 'overdue' ? t('response_overdue') : t('response_due')}</span><span class="timer ${resp.state === 'overdue' ? 'over' : 'ok'}">${resp.minutes !== null && resp.state !== 'responded' ? mins(resp.minutes) : resp.minutes !== null ? mins(resp.minutes) : '-'}</span></div></div>
          <div class="card"><h3 style="margin-bottom:14px">${t('timeline')}</h3><div class="timeline">${c.history.map((x) => h`<div class="tl ${x.actor === 'Auto-triage' || x.actor === 'Safety rule' || x.actor === 'Auto-assign' || x.actor === 'Auto-link' ? 'sys' : ''}"><div class="small"><b>${x.action}</b> · ${x.actor}</div><div class="small muted">${x.detail}</div><div class="tiny muted">${dtFmt(x.at)}</div></div>`)}</div></div>
        </div></div>`);
    $('#stars')?.addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (!b) return; rating = +b.dataset.s; $$('#stars .star').forEach((s, i) => s.classList.toggle('on', i < rating)); $('#rate-go').disabled = false; });
    $('#rate-go')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { try { await api('POST', `/complaints/${id}/rate`, { rating }); toast(t('rate_thanks')); complaintDetailView(root, id); } catch (er) { toast(er.message, 'bad'); } }));
    $('#reopen')?.addEventListener('click', () => {
      const m = openModal(h`<h3>${t('reopen')}</h3><div class="field" style="margin:14px 0"><label for="ro-why">${t('reopen_why')}</label><textarea id="ro-why" class="input" autofocus></textarea></div><div class="row" style="justify-content:flex-end"><button class="btn" data-close>${t('cancel')}</button><button class="btn primary" id="ro-go">${t('reopen')}</button></div>`);
      $('#ro-go', m.el).onclick = (e) => busy(e.currentTarget, async () => { const why = $('#ro-why', m.el).value.trim(); if (why.length < 3) return toast('Please add a reason', 'bad'); try { await api('POST', `/complaints/${id}/reopen`, { reason: why }); m.close(); complaintDetailView(root, id); } catch (er) { toast(er.message, 'bad'); } });
    });
  });
}

// ================= VISITORS =================
export function visitorsView(root) {
  return load(root, async () => {
    const [v, g] = await Promise.all([api('GET', '/visitors'), api('GET', '/guest-codes')]);
    const pend = v.visitors.filter((x) => x.status === 'pending');
    const today = new Date().toISOString().slice(0, 10);
    mount(root, h`${head(t('tab_visitors'), t('photo_notice'))}
      ${pend.length ? h`<div class="card" style="margin-bottom:24px;border-color:#f0dcae;background:#fffaf0"><h3 style="margin-bottom:14px">${t('pending_approvals')}</h3><div class="stack sm">${pend.map((x) => h`<div class="row wrap" style="padding:10px 0">${x.photo ? h`<img class="photo" src="${x.photo}" alt="${x.name}">` : h`<div class="photo" style="display:grid;place-items:center;background:var(--soft)">${icon('users')}</div>`}<div class="grow"><b>${x.name}</b><div class="small muted">${x.purpose} · ${x.phone}</div><div class="tiny muted">${timeFmt(x.createdAt)}</div></div><button class="btn danger" data-d="deny" data-id="${x.id}">${t('deny')}</button><button class="btn primary" data-d="approve" data-id="${x.id}">${t('approve')}</button></div>`)}</div></div>` : ''}
      <div class="grid2" style="align-items:start">
        <div class="card pad0"><div style="padding:18px 20px;border-bottom:1px solid var(--line)"><h3>${t('today_visitors')}</h3></div>${v.visitors.length ? v.visitors.map((x) => h`<div class="row" style="padding:14px 20px;border-bottom:1px solid var(--line)"><div class="grow"><b>${x.name}</b><div class="tiny muted">${x.purpose} · ${timeFmt(x.createdAt)}${x.exitAt ? ' → ' + timeFmt(x.exitAt) : ''}</div></div>${chip(x.status)}</div>`) : h`<div class="empty">${t('no_visitors')}</div>`}</div>
        <div class="card stack"><h3>${t('guest_codes')}</h3>
          <form id="gc" class="stack sm"><div class="field"><label for="gc-name">${t('guest_name')}</label><input id="gc-name" class="input" required maxlength="80"></div><div class="field"><label for="gc-date">${t('code_date')}</label><input id="gc-date" type="date" class="input" min="${today}" value="${today}" required></div><button class="btn primary" type="submit">${t('new_code')}</button></form>
          <div class="stack sm">${g.codes.map((c) => h`<div class="row" style="padding:10px 14px;border:1px solid var(--line);border-radius:12px"><div class="grow"><b class="mono" style="font-size:20px;letter-spacing:.12em">${c.code}</b><div class="tiny muted">${c.guestName} · ${dateFmt(c.date)}</div></div>${c.used ? chip('', t('used')) : chip('ok', t('unused'))}</div>`)}</div></div>
      </div>`);
    root.onclick = async (e) => { const b = e.target.closest('[data-d]'); if (!b) return; await busy(b, async () => { try { await api('POST', `/visitors/${b.dataset.id}/decision`, { decision: b.dataset.d }); toast(b.dataset.d === 'approve' ? t('approve') : t('deny')); visitorsView(root); } catch (er) { toast(er.message, 'bad'); } }); };
    $('#gc').onsubmit = async (e) => { e.preventDefault(); try { const r = await api('POST', '/guest-codes', { guestName: $('#gc-name').value, date: $('#gc-date').value }); openModal(h`<h3>${t('new_code')}</h3><div class="center" style="padding:24px 0"><div class="mono" style="font:800 52px var(--display);letter-spacing:.14em;color:var(--forest)">${r.guestCode.code}</div><p class="muted" style="margin-top:8px">${t('code_made')}</p></div><button class="btn primary" style="width:100%" data-close>${t('close')}</button>`); visitorsView(root); } catch (er) { toast(er.message, 'bad'); } };
  });
}

// ================= BOOKING =================
let bookDate = null;
export function bookView(root) {
  const today = new Date().toISOString().slice(0, 10); bookDate ||= today;
  return load(root, async () => {
    const [a, bk] = await Promise.all([api('GET', `/amenities?date=${bookDate}`), api('GET', '/bookings')]);
    const max = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    mount(root, h`${head(t('book_title'), '', h`<div class="field" style="min-width:180px"><label for="bk-date">${t('pick_date')}</label><input id="bk-date" class="input" type="date" min="${today}" max="${max}" value="${bookDate}"></div>`)}
      <div class="stack">${a.amenities.map((am) => h`<div class="card stack sm"><div class="row between wrap"><div><h3>${am.name}</h3><div class="small muted">${t('fee')}: ${money(am.fee)} · ${t('rules')}: ${am.rules}</div></div></div><div class="row wrap">${am.slots.map((s) => h`<button class="btn sm" ${s.taken ? 'disabled' : ''} data-book="${am.id}" data-h="${s.startHour}" title="${s.taken ? t('slot_taken') : t('book_slot')}">${hourLabel(s.startHour)}-${hourLabel(s.endHour)}${s.taken ? ' · ' + t('slot_taken') : ''}</button>`)}</div></div>`)}</div>
      <h3 style="margin:32px 0 12px">${t('my_bookings')}</h3>
      <div class="card pad0">${bk.bookings.length ? bk.bookings.map((b) => h`<div class="row wrap" style="padding:14px 20px;border-bottom:1px solid var(--line)"><div class="grow"><b>${b.amenityName}</b><div class="small muted">${dateFmt(b.date)} · ${hourLabel(b.startHour)}-${hourLabel(b.endHour)} · ${money(b.fee)}</div></div>${b.status === 'booked' ? h`<span class="chip ok">${t('booked')}</span><button class="btn sm" data-cancel="${b.id}">${t('cancel_booking')}</button>` : h`<span class="chip">${t('cancelled')}</span>`}</div>`) : h`<div class="empty">-</div>`}</div>`);
    $('#bk-date').onchange = (e) => { bookDate = e.target.value || today; bookView(root); };
    root.onclick = async (e) => {
      const b = e.target.closest('[data-book]'); const c = e.target.closest('[data-cancel]');
      if (b) { const am = a.amenities.find((x) => x.id === b.dataset.book); const hr = +b.dataset.h; if (!(await confirmDialog({ title: am.name, body: `${dateFmt(bookDate)} · ${hourLabel(hr)}-${hourLabel(hr + am.slotHours)} · ${t('fee')} ${money(am.fee)}`, confirm: t('book_slot') }))) return; try { await api('POST', '/bookings', { amenityId: am.id, date: bookDate, startHour: hr }); toast(t('booking_ok')); bookView(root); } catch (er) { toast(er.message, 'bad'); bookView(root); } }
      if (c) { if (!(await confirmDialog({ title: t('cancel_booking'), body: '', danger: true, confirm: t('cancel_booking') }))) return; try { await api('POST', `/bookings/${c.dataset.cancel}/cancel`); bookView(root); } catch (er) { toast(er.message, 'bad'); } }
    };
  });
}

// ================= AI RESIDENT CHATBOT =================
export function chatView(root) {
  let messages = [
    { role: 'assistant', content: t('chat_welcome') },
  ];
  let loading = false;

  const quickQuestions = [
    'What is my complaint status?',
    'How do I pay maintenance?',
    'What are the clubhouse hours?',
    'How do I approve visitors?',
  ];

  const render = () => {
    mount(root, h`
      <div style="max-width:760px;margin:0 auto">
        ${head(t('chat_title'), t('chat_subtitle'), h`<span class="chip info">${icon('bot')} Read-Only AI</span>`)}

        <div class="card stack sm" style="padding:16px;min-height:460px;display:flex;flex-direction:column;justify-content:space-between">
          <!-- Chat messages area -->
          <div id="chat-messages" style="display:flex;flex-direction:column;gap:12px;overflow-y:auto;max-height:480px;padding:4px 2px" role="log" aria-live="polite">
            ${messages.map((m) => {
              const isUser = m.role === 'user';
              return h`
                <div style="display:flex;justify-content:${isUser ? 'flex-end' : 'flex-start'};gap:8px">
                  ${!isUser ? h`<div class="avatar" style="width:28px;height:28px;font-size:12px;background:var(--forest);flex-shrink:0" aria-hidden="true">${icon('bot')}</div>` : ''}
                  <div style="max-width:82%;padding:10px 14px;border-radius:${isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px'};background:${isUser ? 'var(--primary)' : 'var(--soft)'};color:${isUser ? '#fff' : 'var(--text)'};font-size:14px;line-height:1.45;word-break:break-word;white-space:pre-wrap">
                    ${m.content}
                  </div>
                </div>
              `;
            })}
            ${loading ? h`
              <div style="display:flex;justify-content:flex-start;gap:8px">
                <div class="avatar" style="width:28px;height:28px;font-size:12px;background:var(--forest);flex-shrink:0" aria-hidden="true">${icon('bot')}</div>
                <div style="padding:10px 14px;border-radius:16px 16px 16px 4px;background:var(--soft);color:var(--muted);font-size:13px;display:flex;align-items:center;gap:8px">
                  <span class="spinner dk" style="width:14px;height:14px;border-width:2px"></span>
                  <span>${t('chat_thinking')}</span>
                </div>
              </div>
            ` : ''}
          </div>

          <!-- Quick prompt pills -->
          <div class="row wrap" style="gap:6px;padding:8px 0 4px">
            ${quickQuestions.map((q) => h`
              <button type="button" class="chip" data-quick="${q}" style="cursor:pointer;border:1px solid var(--line-strong);background:#fff">
                ${q}
              </button>
            `)}
          </div>

          <!-- Input bar -->
          <form id="chat-form" style="display:flex;gap:8px;align-items:flex-end;margin-top:6px">
            <textarea id="chat-input" class="input" rows="1" maxlength="500" placeholder="${t('chat_placeholder')}" style="min-height:44px;max-height:100px;padding:10px 12px;resize:none" ${loading ? 'disabled' : ''}></textarea>
            <button class="btn primary" type="submit" id="chat-submit" style="min-height:44px;min-width:44px;padding:0 16px" ${loading ? 'disabled' : ''} aria-label="${t('chat_send')}">
              ${icon('arrowr')}
            </button>
          </form>

          <div class="tiny muted center" style="margin-top:4px">
            ${t('chat_readonly_note')}
          </div>
        </div>
      </div>
    `);

    const box = $('#chat-messages');
    if (box) box.scrollTop = box.scrollHeight;
    $('#chat-input')?.focus();
  };

  const send = async (text) => {
    const q = (text || '').trim();
    if (!q || loading) return;
    const priorHistory = messages.slice(-10);
    messages.push({ role: 'user', content: q });
    loading = true;
    render();

    try {
      const res = await api('POST', '/chat', {
        message: q,
        history: priorHistory,
      });
      messages.push({ role: 'assistant', content: res.reply || t('chat_error') });
    } catch (e) {
      const errMsg = e.status === 429 ? e.message : (e.status === 401 ? 'Please sign in to access the assistant.' : t('chat_error'));
      messages.push({ role: 'assistant', content: errMsg });
    } finally {
      loading = false;
      render();
    }
  };

  root.onclick = (e) => {
    const qBtn = e.target.closest('[data-quick]');
    if (qBtn && !loading) {
      send(qBtn.dataset.quick);
    }
  };

  root.onsubmit = (e) => {
    if (e.target.id === 'chat-form') {
      e.preventDefault();
      const val = $('#chat-input')?.value;
      if (val) send(val);
    }
  };

  root.onkeydown = (e) => {
    if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const val = $('#chat-input')?.value;
      if (val) send(val);
    }
  };

  render();
}
