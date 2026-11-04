import { h, raw, mount, $, $$, api, session, toast, openModal, confirmDialog, busy, money, dateFmt, dtFmt, timeFmt, mins, hours, icon, chip } from './ui.js';
import { t } from './i18n.js';
import { load } from './views-resident.js';
import { parseBankStatement } from '/shared/csv.js';
import { groupedBars, hbars, donut, COLORS } from './charts.js';

const head = (title, sub, right = '') => h`<div class="pagehead"><div><h1>${title}</h1>${sub ? h`<p>${sub}</p>` : ''}</div>${right}</div>`;
const PRIOS = ['Low', 'Medium', 'High', 'Emergency'];
const METHOD = { groq_ai: 'AI (Groq)', keyword_fallback: 'Keyword fallback', manual: 'Corrected by staff' };
const CATS = ['Plumbing', 'Electrical', 'Lift', 'Security', 'Cleaning', 'Civil', 'Other'];
const STATUSES = ['open', 'assigned', 'in_progress', 'resolved', 'reopened', 'escalated'];
const SL = { open: 'Open', assigned: 'Assigned', in_progress: 'In progress', resolved: 'Resolved', reopened: 'Reopened', escalated: 'Escalated' };

// ================= HELP DESK =================
const filt = { status: '', category: '', urgency: '', review: '' };
let tick = null;
export function deskView(root) {
  clearInterval(tick);
  return load(root, async () => {
    const q = Object.entries(filt).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const [{ complaints, staff }, all] = await Promise.all([api('GET', '/complaints' + (q ? '?' + q : '')), api('GET', '/complaints')]);
    const open = all.complaints.filter((c) => c.status !== 'resolved');
    const crit = open.filter((c) => c.urgency === 'Emergency' || c.status === 'escalated');
    const review = open.filter((c) => c.needsReview);
    const overdue = open.filter((c) => c.response.state === 'overdue');
    const sel = (name, opts, label) => h`<select class="input" data-f="${name}" aria-label="${label}" style="min-height:40px;width:auto"><option value="">${label}</option>${opts.map(([v, l]) => h`<option value="${v}" ${filt[name] === v ? 'selected' : ''}>${l}</option>`)}</select>`;
    mount(root, h`${head('Help desk', 'Complaints, assignment and escalations')}
      ${crit.length ? h`<div class="banner bad" style="margin-bottom:16px"><div>${icon('alert')}</div><div><b>${crit.length} escalated / emergency</b> — ${crit.slice(0, 3).map((c) => h`<a href="#/app/desk" data-open="${c.id}" style="color:inherit;text-decoration:underline">${c.id} ${c.title}</a>`).reduce((a, x) => (a.length ? [...a, ' · ', x] : [x]), [])}</div></div>` : ''}
      <div class="grid4 keep2" style="margin-bottom:20px">
        <div class="tile"><span class="k">Open</span><span class="v">${open.length}</span></div>
        <div class="tile"><span class="k">Needs review</span><span class="v">${review.length}</span><span class="s">automatic suggestion unsure</span></div>
        <div class="tile"><span class="k">Response overdue</span><span class="v" style="color:${overdue.length ? 'var(--bad)' : 'inherit'}">${overdue.length}</span></div>
        <div class="tile"><span class="k">Emergency</span><span class="v" style="color:${crit.length ? 'var(--bad)' : 'inherit'}">${open.filter((c) => c.urgency === 'Emergency').length}</span></div></div>
      <div class="row wrap" style="margin-bottom:14px">${sel('status', STATUSES.map((s) => [s, SL[s]]), 'All statuses')}${sel('category', CATS.map((c) => [c, c]), 'All categories')}${sel('urgency', ['Emergency', 'High', 'Medium', 'Low'].map((c) => [c, c]), 'All urgencies')}<label class="chip ${filt.review ? 'dark' : ''}" style="cursor:pointer;min-height:40px;padding:0 14px"><input type="checkbox" data-f="review" ${filt.review ? 'checked' : ''} class="sr">Needs review only</label></div>
      <div class="card pad0 tablewrap">${complaints.length ? h`<table class="cards-on-mobile"><thead><tr><th>Complaint</th><th>Flat</th><th>Category</th><th>Urgency</th><th>Status</th><th>Assigned</th><th>Response</th></tr></thead><tbody>${complaints.map((c) => h`<tr class="click" data-open="${c.id}" tabindex="0"><td data-l="Complaint"><b>${c.title}</b><div class="tiny muted">${c.id} · ${dtFmt(c.createdAt)}</div>${c.needsReview ? h`<span class="chip warn" style="margin-top:4px">Review</span> ` : ''}${c.linkedTo ? h`<span class="chip" style="margin-top:4px">Linked to ${c.linkedTo}</span>` : ''}${c.linkedCount ? h` <span class="chip info" style="margin-top:4px">${c.linkedCount} similar</span>` : ''}</td><td data-l="Flat">${c.flatNo}</td><td data-l="Category">${c.category}</td><td data-l="Urgency">${chip(c.urgency)}</td><td data-l="Status">${chip(c.status)}</td><td data-l="Assigned">${c.assignee?.name || '-'}</td><td data-l="Response"><span class="timer ${c.response.state === 'overdue' ? 'over' : c.response.state === 'responded' ? 'ok' : ''}" data-resp="${c.respondBy}" data-state="${c.response.state}">${c.response.state === 'responded' ? 'Responded' : c.response.state === 'overdue' ? 'Overdue ' + mins(c.response.minutes) : mins(c.response.minutes) + ' left'}</span></td></tr>`)}</tbody></table>` : h`<div class="empty"><b>No complaints match</b>Clear the filters to see everything.</div>`}</div>`);
    root.onchange = (e) => { const f = e.target.dataset.f; if (!f) return; filt[f] = e.target.type === 'checkbox' ? (e.target.checked ? '1' : '') : e.target.value; deskView(root); };
    root.onclick = (e) => { const r = e.target.closest('[data-open]'); if (r) { e.preventDefault(); openComplaint(r.dataset.open, () => deskView(root)); } };
    root.onkeydown = (e) => { if (e.key === 'Enter') { const r = e.target.closest('tr[data-open]'); if (r) openComplaint(r.dataset.open, () => deskView(root)); } };
    // live response timers
    tick = setInterval(() => { if (!document.body.contains(root) || location.hash !== '#/app/desk') return clearInterval(tick); $$('[data-resp]', root).forEach((el) => { if (el.dataset.state === 'responded') return; const left = Math.round((Date.parse(el.dataset.resp) - Date.now()) / 60000); el.classList.toggle('over', left < 0); el.textContent = left < 0 ? 'Overdue ' + mins(left) : mins(left) + ' left'; }); }, 30000);
  });
}

async function openComplaint(id, refresh) {
  const d = await api('GET', `/complaints/${id}`).catch((e) => (toast(e.message, 'bad'), null)); if (!d) return;
  const c = d.complaint; const staff = d.staff;
  const m = openModal(h`
    <div class="row between"><div><h3>${c.title}</h3><div class="small muted">${c.id} · Flat ${c.flatNo} · ${dtFmt(c.createdAt)}</div></div><button class="btn ghost sm" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="stack" style="margin-top:16px">
      ${c.safety?.triggered ? h`<div class="banner bad"><div>${icon('alert')}</div><div><b>Safety escalation: ${c.safety.labels.join(', ')}</b><br>Escalated to the duty manager by rule. This overrides the automatic category.</div></div>` : ''}
      <p>${c.description}</p>${c.photos?.length ? h`<div class="row wrap">${c.photos.map((p) => h`<img class="photo" src="${p}" alt="complaint photo">`)}</div>` : ''}
      <div class="card flat stack sm"><div class="row between wrap"><b class="small">Classification</b><span class="chip ${c.classificationMethod === 'groq_ai' ? 'info' : c.classificationMethod === 'manual' ? 'ok' : ''}" title="How this classification was produced">${METHOD[c.classificationMethod] || c.classificationMethod}${c.classificationModel ? ' · ' + c.classificationModel : ''}</span></div>
        <div class="row wrap small"><span class="chip">${c.aiCategory || '—'} · ${c.aiUrgency || '—'}${c.confidence != null ? ' · ' + Math.round(c.confidence * 100) + '% confidence' : ''}</span>${c.suggestedDepartment ? h`<span class="muted">Suggested department: <b>${c.suggestedDepartment}</b></span>` : ''}</div>
        ${c.reasons?.length ? h`<div class="tiny muted">Why: ${c.reasons.join('. ')}</div>` : ''}
        ${c.needsReview ? h`<div class="chip warn" style="align-self:flex-start;white-space:normal;height:auto;text-align:left;line-height:1.35;padding-block:6px">Manual review needed: ${c.reviewReasons.join('; ')}</div><button class="btn sm" id="confirm" style="align-self:flex-start">${icon('check')}Confirm classification is correct</button>` : h`<div class="chip ok" style="align-self:flex-start">${c.categoryConfirmedBy ? 'Confirmed or corrected by staff' : 'No review flags'}</div>`}${c.summary ? h`<div class="small"><span class="muted">Summary:</span> ${c.summary}</div>` : ''}
        ${c.corrections?.length ? h`<div class="stack sm"><b class="tiny muted">CORRECTION AUDIT TRAIL</b>${c.corrections.map((x) => h`<div class="tiny">${x.field}: <s>${x.oldValue || '—'}</s> → <b>${x.newValue}</b> · ${x.by} · ${dtFmt(x.at)}</div>`)}</div>` : ''}</div>
      <div class="field"><label>Category <span class="muted" style="font-weight:400">— one tap to change</span></label><div class="seg" id="cat">${CATS.map((x) => h`<button data-cat="${x}" aria-pressed="${c.category === x}">${x}</button>`)}</div></div>
      <div class="field"><label>Priority <span class="muted" style="font-weight:400">— an emergency raised by a safety rule cannot be lowered</span></label><div class="seg" id="prio">${PRIOS.map((x) => h`<button data-prio="${x}" aria-pressed="${c.urgency === x}">${x}</button>`)}</div></div>
      <div class="grid2"><div class="field"><label for="as">Assign to</label><select id="as" class="input"><option value="">Unassigned</option>${staff.filter((s) => s.team !== 'Duty').map((s) => h`<option value="${s.id}" ${c.assigneeId === s.id ? 'selected' : ''}>${s.name} · ${s.team}</option>`)}</select></div>
        <div class="field"><label for="st">Status</label><select id="st" class="input">${STATUSES.map((s) => h`<option value="${s}" ${c.status === s ? 'selected' : ''}>${SL[s]}</option>`)}</select></div></div>
      ${c.linkedTo || d.complaint.linkedFrom?.length ? h`<div class="card flat stack sm"><b class="small">Linked complaints</b>${c.linkedTo ? h`<div class="row between small"><span>Looks similar to <b>${c.linkedTo}</b> (linked, not closed)</span><button class="btn sm" id="unlink">Unlink</button></div>` : ''}${(d.complaint.linkedFrom || []).map((x) => h`<div class="small"><a href="#/app/desk" data-open="${x.id}">${x.id}</a> · ${x.flatNo} · ${x.title}</div>`)}</div>` : ''}
      ${c.rating ? h`<div class="small">Resident rating: <b>${c.rating}/5</b> ${c.ratingComment || ''}</div>` : ''}${c.reopenCount ? h`<div class="small">Reopened ${c.reopenCount}×</div>` : ''}
      <div><b class="small">History</b><div class="timeline" style="margin-top:10px">${c.history.map((x) => h`<div class="tl ${['Auto-triage', 'AI triage', 'Safety rule', 'Auto-assign', 'Auto-link'].includes(x.actor) ? 'sys' : ''}"><div class="small"><b>${x.action}</b> · ${x.actor} <span class="muted tiny">${dtFmt(x.at)}</span></div><div class="small muted">${x.detail}</div></div>`)}</div></div>
    </div>`, { drawer: true, label: c.title, onClose: refresh });
  const patch = async (path, body, ok) => { try { await api('PATCH', `/complaints/${id}/${path}`, body); toast(ok); m.close(); openComplaint(id, refresh); } catch (e) { toast(e.message, 'bad'); } };
  $('#cat', m.el).onclick = (e) => { const b = e.target.closest('[data-cat]'); if (b && b.dataset.cat !== c.category) patch('category', { category: b.dataset.cat }, `Category set to ${b.dataset.cat}`); };
  $('#prio', m.el).onclick = (e) => { const b = e.target.closest('[data-prio]'); if (b && b.dataset.prio !== c.urgency) patch('priority', { priority: b.dataset.prio }, `Priority set to ${b.dataset.prio}`); };
  $('#confirm', m.el)?.addEventListener('click', async () => { try { await api('POST', `/complaints/${id}/confirm`); toast('Classification confirmed'); m.close(); openComplaint(id, refresh); } catch (e) { toast(e.message, 'bad'); } });
  $('#as', m.el).onchange = (e) => e.target.value && patch('assign', { staffId: e.target.value }, 'Assigned');
  $('#st', m.el).onchange = (e) => patch('status', { status: e.target.value }, `Status: ${SL[e.target.value]}`);
  $('#unlink', m.el)?.addEventListener('click', async () => { await api('POST', `/complaints/${id}/unlink`); m.close(); openComplaint(id, refresh); });
  m.el.addEventListener('click', (e) => { const r = e.target.closest('[data-open]'); if (r) { e.preventDefault(); m.close(); openComplaint(r.dataset.open, refresh); } });
}

// ================= PAYMENTS / RECONCILIATION =================
let recFilter = 'attention';
export function paymentsView(root) {
  return load(root, async () => {
    const [{ txns, counts, files }, { flats }] = await Promise.all([api('GET', '/bank/transactions'), api('GET', '/flats')]);
    const pendingStatus = (x) => !x.postedReceipt && !x.rejected;
    const list = txns.filter((x) => (recFilter === 'all' ? true : recFilter === 'attention' ? pendingStatus(x) && x.status !== 'duplicate' && x.status !== 'matched' : recFilter === 'posted' ? x.postedReceipt : recFilter === 'matched' ? x.status === 'matched' && pendingStatus(x) : x.status === recFilter));
    const cnt = (k) => counts[k] || 0; const attention = txns.filter((x) => pendingStatus(x) && !['duplicate', 'matched'].includes(x.status)).length; const readyMatched = txns.filter((x) => x.status === 'matched' && pendingStatus(x)).length;
    mount(root, h`${head('Bank reconciliation', 'Upload a statement. Clear payments are matched; anything uncertain waits here for a person.', h`<a class="btn" href="/samples/bank-statement-sample.csv" download>${icon('download')}Sample CSV</a>`)}
      <div class="card stack" id="up" style="margin-bottom:24px"><div class="drop" id="drop" tabindex="0" role="button">${icon('up')}<div style="margin-top:8px"><b>Drop a bank statement CSV here</b> or click to choose</div><div class="small muted" style="margin-top:4px">Required columns: Date, Description, Credit. Optional: Reference, UPI ID, Debit.</div></div><input type="file" id="file" accept=".csv,text/csv" class="sr"><div id="preview"></div></div>
      <div class="banner" style="margin-bottom:20px"><div>${icon('shield')}</div><div><b>Safety rule:</b> only an exact amount with a payment reference counts as <i>Matched</i>. Uploading never posts anything. Uncertain rows are never posted to a flat automatically.</div></div>
      <div class="row wrap" style="margin-bottom:14px;justify-content:space-between"><div class="seg" id="rf">${[['attention', `Needs attention (${attention})`], ['matched', `Matched (${readyMatched})`], ['posted', `Posted (${cnt('posted')})`], ['duplicate', `Duplicates (${cnt('duplicate')})`], ['all', 'All']].map(([k, l]) => h`<button data-rf="${k}" aria-pressed="${recFilter === k}">${l}</button>`)}</div>${readyMatched ? h`<button class="btn dark" id="autopost">Post ${readyMatched} exact match${readyMatched > 1 ? 'es' : ''}</button>` : ''}</div>
      <div class="card pad0 tablewrap">${list.length ? h`<table class="cards-on-mobile"><thead><tr><th>Date / amount</th><th>Bank narration</th><th>Result</th><th>Why</th><th></th></tr></thead><tbody>${list.map((x) => h`<tr><td data-l="Amount"><b class="mono">${money(x.amount)}</b><div class="tiny muted">${dateFmt(x.date)} · ${x.id}</div></td><td data-l="Narration"><div class="small">${x.description}</div><div class="tiny muted">${[x.reference && 'Ref ' + x.reference, x.upi].filter(Boolean).join(' · ')}</div></td><td data-l="Result">${x.postedReceipt ? h`${chip('posted', 'Posted')}<div class="tiny muted">${x.postedFlat} · ${x.postedReceipt}</div>` : x.rejected ? chip('rejected') : h`${chip(x.status)}${x.flatNo ? h`<div class="tiny muted" style="margin-top:4px">${x.flatNo} · ${Math.round(x.confidence * 100)}% confidence</div>` : ''}`}</td><td data-l="Why" class="small" style="max-width:300px">${(x.reasons || []).map((r) => h`<div>${r}</div>`)}</td><td class="right" style="white-space:nowrap">${x.postedReceipt || x.rejected || x.status === 'duplicate' ? '' : x.status === 'matched' || x.status === 'partial' ? h`<button class="btn sm primary" data-ap="${x.id}" data-flat="${x.flatNo}">Approve</button> <button class="btn sm" data-rj="${x.id}">Reject</button>` : h`<button class="btn sm primary" data-as="${x.id}" data-sg="${x.flatNo || ''}">Assign to flat</button> <button class="btn sm" data-rj="${x.id}">Reject</button>`}</td></tr>`)}</tbody></table>` : h`<div class="empty"><b>${txns.length ? 'Nothing here' : 'No bank transactions yet'}</b>${txns.length ? 'Everything in this view has been handled.' : 'Upload a statement to start.'}</div>`}</div>
      ${files.length ? h`<div class="small muted" style="margin-top:14px">${files.length} file(s) imported · latest ${files[files.length - 1].filename} (${files[files.length - 1].total} credits)</div>` : ''}`);

    const input = $('#file'); let csvText = null, fname = '';
    const showPreview = (text, name) => {
      csvText = text; fname = name; const p = parseBankStatement(text); const box = $('#preview');
      if (!p.ok) { mount(box, h`<div class="banner bad" style="margin-top:16px"><div><b>Cannot import this file.</b><br>Missing required column(s): <b>${p.missing.join(', ')}</b>${p.headers ? h`<br><span class="small">Found: ${p.headers.join(', ')}</span>` : ''}</div></div>`); csvText = null; return; }
      const credits = p.rows.filter((r) => r.credit > 0);
      mount(box, h`<div class="stack sm" style="margin-top:16px"><div class="row between wrap"><div><b>${fname}</b> · ${credits.length} credit row(s), ${p.rows.length - credits.length} debit row(s) ignored${p.errors.length ? h`, <span style="color:var(--bad)">${p.errors.length} row(s) with errors</span>` : ''}</div><div class="row"><button class="btn" id="cancel-up">Cancel</button><button class="btn primary" id="do-up" ${credits.length ? '' : 'disabled'}>Import and match</button></div></div>
        ${p.errors.length ? h`<div class="banner warn">${p.errors.slice(0, 3).map((e) => h`<div>Line ${e.line}: ${e.error}</div>`)}</div>` : ''}
        <div class="tablewrap card flat pad0"><table><thead><tr><th>Date</th><th>Description</th><th>Reference</th><th>UPI ID</th><th class="num">Credit</th></tr></thead><tbody>${credits.slice(0, 6).map((r) => h`<tr><td>${dateFmt(r.date)}</td><td>${r.description}</td><td>${r.reference}</td><td>${r.upi}</td><td class="num">${money(r.credit)}</td></tr>`)}</tbody></table></div>${credits.length > 6 ? h`<div class="tiny muted">Showing 6 of ${credits.length}</div>` : ''}</div>`);
      $('#cancel-up').onclick = () => { csvText = null; mount(box, ''); };
      $('#do-up').onclick = (e) => busy(e.currentTarget, async () => { try { const r = await api('POST', '/bank/upload', { csv: csvText, filename: fname }); toast(`Imported ${r.file.total}: ${r.file.counts.matched} matched, ${r.file.counts.partial} partial, ${r.file.counts.needs_review} to review, ${r.file.counts.unmatched} unmatched, ${r.file.counts.duplicate} duplicate`); recFilter = 'attention'; paymentsView(root); } catch (er) { mount(box, h`<div class="banner bad" style="margin-top:16px">${er.message}</div>`); } });
    };
    const read = (f) => { const rd = new FileReader(); rd.onload = () => showPreview(String(rd.result), f.name); rd.readAsText(f); };
    $('#drop').onclick = () => input.click(); $('#drop').onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && input.click();
    input.onchange = (e) => e.target.files[0] && read(e.target.files[0]);
    $('#drop').ondragover = (e) => { e.preventDefault(); $('#drop').classList.add('on'); }; $('#drop').ondragleave = () => $('#drop').classList.remove('on');
    $('#drop').ondrop = (e) => { e.preventDefault(); $('#drop').classList.remove('on'); e.dataTransfer.files[0] && read(e.dataTransfer.files[0]); };
    $('#rf').onclick = (e) => { const b = e.target.closest('[data-rf]'); if (b) { recFilter = b.dataset.rf; paymentsView(root); } };
    $('#autopost')?.addEventListener('click', async (e) => { if (!(await confirmDialog({ title: `Post ${readyMatched} exact match(es)?`, body: 'Only rows with an exact amount and a payment reference are posted. Everything else stays in the queue.', confirm: 'Post to ledgers' }))) return; await busy(e.target, async () => { try { const r = await api('POST', '/bank/auto-post'); toast(`${r.posted} payment(s) posted`); paymentsView(root); } catch (er) { toast(er.message, 'bad'); } }); });
    root.onclick = async (e) => {
      const ap = e.target.closest('[data-ap]'), as = e.target.closest('[data-as]'), rj = e.target.closest('[data-rj]');
      if (ap) { if (!(await confirmDialog({ title: 'Post this payment?', body: `${money(txns.find((x) => x.id === ap.dataset.ap).amount)} will be posted to flat ${ap.dataset.flat}'s ledger.`, confirm: 'Post' }))) return; try { await api('POST', `/bank/transactions/${ap.dataset.ap}/approve`, {}); toast('Posted to ledger'); paymentsView(root); } catch (er) { toast(er.message, 'bad'); } }
      if (as) { const x = txns.find((y) => y.id === as.dataset.as); const m = openModal(h`<h3>Assign ${money(x.amount)} to a flat</h3><p class="small muted" style="margin:8px 0 16px">${x.description}${x.reasons?.length ? ' — ' + x.reasons.join('; ') : ''}</p><div class="field"><label for="fl">Flat</label><select id="fl" class="input"><option value="">Choose a flat</option>${flats.map((f) => h`<option value="${f.flatNo}" ${f.flatNo === as.dataset.sg ? 'selected' : ''}>${f.flatNo} · outstanding ${money(f.outstanding)}</option>`)}</select></div><div class="row" style="justify-content:flex-end;margin-top:20px"><button class="btn" data-close>Cancel</button><button class="btn primary" id="fl-go">Post to this flat</button></div>`); $('#fl-go', m.el).onclick = async (ev) => { const flatNo = $('#fl', m.el).value; if (!flatNo) return toast('Choose a flat first', 'bad'); await busy(ev.currentTarget, async () => { try { await api('POST', `/bank/transactions/${x.id}/approve`, { flatNo, note: 'Manually assigned' }); m.close(); toast('Posted to ledger'); paymentsView(root); } catch (er) { toast(er.message, 'bad'); } }); }; }
      if (rj) { if (!(await confirmDialog({ title: 'Reject this transaction?', body: 'It will be removed from the queue and nothing will be posted.', danger: true, confirm: 'Reject' }))) return; try { await api('POST', `/bank/transactions/${rj.dataset.rj}/reject`, { reason: 'Rejected by accounts' }); paymentsView(root); } catch (er) { toast(er.message, 'bad'); } }
    };
  });
}

// ================= ADMIN (billing, late fee, notices, demo tools) =================
export function adminView(root) {
  return load(root, async () => {
    const [{ config, lateFeeModes }, { flats }, notes, enq] = await Promise.all([api('GET', '/config'), api('GET', '/flats'), api('GET', '/notifications'), api('GET', '/enquiries')]);
    const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
    const lf = config.lateFee;
    mount(root, h`${head('Admin', 'Billing settings, bill runs, notices and demo tools')}
      <div class="grid2" style="align-items:start">
        <form class="card stack" id="cfg"><h3>Billing settings</h3>
          <div class="grid2"><div class="field"><label for="rate">Rate (₹ per sq ft per month)</label><input id="rate" class="input mono" type="number" step="0.01" min="0.01" value="${config.ratePerSqft}"></div><div class="field"><label for="due">Due after (days)</label><input id="due" class="input" type="number" min="0" max="60" value="${config.dueDays}"></div></div>
          <div class="field"><label for="lfm">Late fee rule (per society bye-laws)</label><select id="lfm" class="input">${lateFeeModes.map((m) => h`<option value="${m}" ${lf.mode === m ? 'selected' : ''}>${{ none: 'None (not configured)', flat: 'Flat fee once overdue', percent_per_month: '% of unpaid per month', percent_per_annum: '% per annum (simple interest, per day)' }[m]}</option>`)}</select></div>
          <div class="grid2"><div class="field"><label for="lfg">Grace period (days)</label><input id="lfg" class="input" type="number" min="0" value="${lf.graceDays}"></div><div class="field"><label for="lfv">Value (₹ or %)</label><input id="lfv" class="input" type="number" step="0.01" min="0" value="${lf.value}"></div></div>
          <div class="hint">NESTORA does not assume a legal formula. Enter exactly what your bye-laws specify. With "None", no late fee is ever added.</div><button class="btn primary" type="submit" style="align-self:flex-start">Save settings</button></form>
        <div class="stack">
          <div class="card stack sm"><h3>Monthly bills</h3><p class="small muted">Creates one bill per flat = area × ₹${config.ratePerSqft}. Running it twice for the same month creates nothing new.</p><div class="row"><input id="period" class="input" type="month" value="${nextMonth}" style="max-width:200px" aria-label="Billing month"><button class="btn primary" id="gen">Generate bills</button></div></div>
          <div class="card stack sm"><h3>Late fees</h3><p class="small muted">Posts one late-fee charge per overdue bill using the rule on the left. ${lf.mode === 'none' ? 'Nothing will be posted until a rule is configured.' : ''}</p><button class="btn" id="late">Apply late fees now</button></div>
          <form class="card stack sm" id="nt"><h3>Post a notice</h3><input class="input" id="nt-t" placeholder="Title" maxlength="100" required><textarea class="input" id="nt-b" placeholder="Message" maxlength="1000" required style="min-height:80px"></textarea><button class="btn" type="submit" style="align-self:flex-start">Publish notice</button></form>
        </div></div>
      <h3 style="margin:32px 0 12px">Flats</h3>
      <div class="card pad0 tablewrap"><table class="cards-on-mobile"><thead><tr><th>Flat</th><th class="num">Area</th><th class="num">Outstanding</th><th class="num">Days overdue</th></tr></thead><tbody>${flats.map((f) => h`<tr><td data-l="Flat"><b>${f.flatNo}</b>${f.demo ? h` <span class="chip">demo</span>` : ''}</td><td class="num" data-l="Area">${f.area}</td><td class="num" data-l="Outstanding">${money(f.outstanding)}</td><td class="num" data-l="Overdue">${f.daysOverdue || '-'}</td></tr>`)}</tbody></table></div>
      <div class="grid2" style="margin-top:28px;align-items:start">
        <div class="card stack sm"><h3>Outgoing messages (mock)</h3><p class="tiny muted">No SMS or push is actually sent. This log shows what would have been sent.</p>${notes.notifications.length ? notes.notifications.slice(0, 6).map((n) => h`<div class="small" style="padding:6px 0;border-top:1px solid var(--line)"><span class="chip">${n.channel}</span> ${n.message}<div class="tiny muted">${dtFmt(n.at)} → ${n.to}</div></div>`) : h`<div class="muted small">None yet</div>`}</div>
        <div class="stack"><div class="card stack sm"><h3>Website enquiries</h3>${enq.enquiries.length ? enq.enquiries.slice(0, 4).map((x) => h`<div class="small" style="padding:6px 0;border-top:1px solid var(--line)"><b>${x.name}</b> ${x.phone} <div class="muted">${x.message}</div></div>`) : h`<div class="muted small">None yet</div>`}</div>
          <div class="card stack sm"><h3>Demo tools</h3><div class="row wrap"><button class="btn" id="purge">Delete visitor photos older than 90 days</button><button class="btn danger" id="reset">Reset demo data</button></div></div></div></div>`);
    $('#cfg').onsubmit = async (e) => { e.preventDefault(); try { await api('PUT', '/config', { ratePerSqft: +$('#rate').value, dueDays: +$('#due').value, lateFee: { mode: $('#lfm').value, graceDays: +$('#lfg').value, value: +$('#lfv').value } }); toast('Settings saved'); adminView(root); } catch (er) { toast(er.message, 'bad'); } };
    $('#gen').onclick = (e) => busy(e.currentTarget, async () => { try { const r = await api('POST', '/bills/generate', { period: $('#period').value }); toast(`${r.created} bill(s) created, ${r.skipped} already existed`); adminView(root); } catch (er) { toast(er.message, 'bad'); } });
    $('#late').onclick = (e) => busy(e.currentTarget, async () => { try { const r = await api('POST', '/latefees/apply'); toast(r.note || `${r.posted} late fee(s) posted`); adminView(root); } catch (er) { toast(er.message, 'bad'); } });
    $('#nt').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/notices', { title: $('#nt-t').value, body: $('#nt-b').value }); toast('Notice published'); $('#nt').reset(); } catch (er) { toast(er.message, 'bad'); } };
    $('#purge').onclick = async () => { const r = await api('POST', '/visitors/purge'); toast(`${r.deleted} photo(s) deleted`); };
    $('#reset').onclick = async () => { if (await confirmDialog({ title: 'Reset all demo data?', body: 'Bills, payments, complaints and bank transactions return to the seeded sample data.', danger: true, confirm: 'Reset' })) { await api('POST', '/demo/reset'); toast('Demo data reset'); adminView(root); } };
  });
}

// ================= COMMITTEE =================
export function committeeView(root) {
  return load(root, async () => {
    const a = await api('GET', '/analytics'); const f = a.finance, c = a.complaints, r = a.reconciliation;
    const ageing = [['Not yet due', a.ageing.current, COLORS.grey], ['1–30 days', a.ageing.d1_30, COLORS.champagne], ['31–60 days', a.ageing.d31_60, COLORS.warn], ['60+ days', a.ageing.d60plus, COLORS.bad]];
    mount(root, h`${head('Committee dashboard', `As of ${dateFmt(a.asOf)} · all figures are calculated from ledger and complaint records`, h`<a class="btn dark" id="exp" href="#">${icon('download')}Monthly report (CSV)</a>`)}
      ${a.note ? h`<div class="banner" style="margin-bottom:20px">${a.note}</div>` : ''}
      <div class="grid4 keep2" style="margin-bottom:20px">
        <div class="tile"><span class="k">Total billed</span><span class="v">${money(f.billedTotal)}</span></div><div class="tile"><span class="k">Collected</span><span class="v">${money(f.collectedTotal)}</span><span class="s">${f.collectionPct}% of billed</span></div>
        <div class="tile"><span class="k">Outstanding dues</span><span class="v" style="color:${f.outstanding ? 'var(--bad)' : 'inherit'}">${money(f.outstanding)}</span><span class="s">${f.flatsWithDues} of ${f.totalFlats} flats</span></div><div class="tile"><span class="k">Collection rate</span><span class="v">${f.collectionPct}%</span><div class="bar"><i style="width:${f.collectionPct}%"></i></div></div></div>
      <div class="grid2" style="margin-bottom:20px;align-items:start"><div class="card stack"><h3>Monthly collection</h3>${groupedBars(a.monthly)}</div>
        <div class="card stack"><h3>Dues ageing</h3>${hbars(ageing.map(([label, x]) => ({ label, value: x.amount, sub: `· ${x.flats} flat${x.flats === 1 ? '' : 's'}` })), { fmt: money, colors: ageing.map((x) => x[2]) })}</div></div>
      <div class="grid4 keep2" style="margin-bottom:20px">
        <div class="tile"><span class="k">Open complaints</span><span class="v">${c.open}</span><span class="s">${c.emergency} emergency · ${c.overdueResponse} response overdue</span></div><div class="tile"><span class="k">Avg resolution</span><span class="v">${c.avgResolutionHours ? hours(c.avgResolutionHours) : '-'}</span></div>
        <div class="tile"><span class="k">Reopened</span><span class="v">${c.reopenedPct}%</span><span class="s">${c.reopened} of ${c.total} complaints</span></div><div class="tile"><span class="k">Avg rating</span><span class="v">${c.ratedCount ? c.avgRating.toFixed(1) + ' / 5' : '-'}</span><span class="s">${c.ratedCount} rated</span></div></div>
      <div class="grid2" style="align-items:start"><div class="card stack"><h3>Complaint performance by category</h3>${c.categories.length ? hbars(c.categories.map((x) => ({ label: x.category, value: x.total, sub: `· ${x.open} open · ${x.avgResolutionHours ? hours(x.avgResolutionHours) + ' avg' : 'no resolved'}` })), { color: COLORS.forest }) : h`<div class="empty">No complaints yet</div>`}</div>
        <div class="card stack"><h3>Bank reconciliation</h3>${r.total ? donut([{ label: 'Matched', value: r.matched, color: COLORS.primary }, { label: 'Partial', value: r.partial, color: COLORS.champagne }, { label: 'Needs review', value: r.needsReview, color: COLORS.warn }, { label: 'Unmatched', value: r.unmatched, color: COLORS.bad }, { label: 'Duplicate', value: r.duplicate, color: COLORS.grey }], { center: 'transactions' }) : h`<div class="empty">No bank statement imported yet</div>`}<div class="small muted">${r.posted} posted to ledgers (${money(r.postedAmount)}) · ${r.pendingReview} awaiting review</div></div></div>`);
    $('#exp').onclick = async (e) => { e.preventDefault(); const res = await fetch('/api/reports/monthly.csv', { headers: { Authorization: 'Bearer ' + session.token } }); const blob = await res.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `nestora-report-${a.period}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); toast('Report downloaded'); };
  });
}
