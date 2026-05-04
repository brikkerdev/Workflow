// Workflow — Tracks page: grid of cards + per-track roadmap view.

const ITER_GLYPHS = { planned: '◯', active: '●', done: '✓', abandoned: '×' };

function renderTracks() {
  if (STATE.viewedTrack) return renderTrackRoadmap();
  return renderTracksGrid();
}

function renderTracksGrid() {
  const view = document.getElementById('view-tracks');
  view.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'tracks-page';

  const allTracks = STATE.tracks.tracks || [];
  const tracks = STATE.search
    ? allTracks.filter(tr => {
        if (matchSearch(tr.slug, tr.fm?.title, tr.body)) return true;
        return (tr.iterations || []).some(it => matchSearch(it.id, it.slug, it.title, it.fm?.title));
      })
    : allTracks;

  // header
  const header = document.createElement('div');
  header.className = 'tracks-header';
  header.innerHTML = `
    <div>
      <h1>Tracks</h1>
      <div class="subtitle mono">${tracks.length} active</div>
    </div>
    <button class="btn btn-primary btn-lg" id="new-track-btn">+ New track</button>
  `;
  header.querySelector('#new-track-btn').addEventListener('click', () => openTrackForm(null));
  page.appendChild(header);

  if (!tracks.length) {
    const empty = document.createElement('div');
    empty.className = 'tracks-empty';
    empty.innerHTML = `<h2>No tracks</h2><p>click <span class="cmd">+ New track</span> or run <span class="cmd">/new-track</span></p>`;
    page.appendChild(empty);
    view.appendChild(page);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'tracks-grid';
  for (const tr of tracks) grid.appendChild(renderTrackCard(tr));
  page.appendChild(grid);

  view.appendChild(page);
}

function renderTrackCard(tr) {
  const counts = countIters(tr.iterations || []);
  const total = counts.planned + counts.active + counts.done + counts.abandoned;
  const doneFrac = total ? Math.round((counts.done * 100) / total) : 0;
  const preview = extractGoalPreview(tr.body || '');
  const title = tr.fm?.title || '';
  const archived = tr.fm?.status === 'archived';
  const shipped = tr.fm?.status === 'shipped';
  const activeIter = (tr.iterations || []).find(i => i.id === tr.active);
  const totalTasks = (tr.iterations || []).reduce((s, i) => s + (i.task_count || 0), 0);
  const totalDone = (tr.iterations || []).reduce((s, i) => s + (i.done_count || 0), 0);

  const card = document.createElement('div');
  card.className = 'track-card' + (archived ? ' archived' : '') + (shipped ? ' shipped' : '');
  card.dataset.slug = tr.slug;
  card.innerHTML = `
    <div class="track-card-head">
      <div class="track-card-titles">
        <div class="track-card-slug">${escapeHtml(tr.slug)}${shipped ? ' <span class="roadmap-shipped-badge">SHIPPED</span>' : ''}</div>
        ${title && title !== tr.slug ? `<div class="track-card-title">${escapeHtml(title)}</div>` : ''}
      </div>
      <div class="track-card-actions">
        <button class="iconbtn" title="New iteration" data-act="new-iter">+</button>
        <button class="iconbtn" title="Edit track" data-act="edit">✎</button>
        <button class="iconbtn" title="Archive track" data-act="archive">⌫</button>
      </div>
    </div>
    ${preview ? `<div class="track-card-preview">${escapeHtml(preview)}</div>` : '<div class="track-card-preview muted">no goal yet</div>'}
    <div class="track-card-meta">
      <span class="iter-counter c-planned"><span class="iter-counter-glyph">◯</span>${counts.planned}</span>
      <span class="iter-counter c-active"><span class="iter-counter-glyph">●</span>${counts.active}</span>
      <span class="iter-counter c-done"><span class="iter-counter-glyph">✓</span>${counts.done}</span>
      ${counts.abandoned ? `<span class="iter-counter"><span class="iter-counter-glyph">×</span>${counts.abandoned}</span>` : ''}
    </div>
    ${activeIter ? `<div class="track-card-active mono"><span class="iter-active-badge">HEAD</span> ${escapeHtml(activeIter.id)} · ${escapeHtml(activeIter.title || activeIter.slug || '')}</div>` : ''}
    <div class="track-card-bar"><i style="width:${doneFrac}%"></i></div>
    <div class="track-card-foot mono">${totalDone}/${totalTasks} tasks · ${counts.done}/${total} iter</div>
  `;

  card.addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'new-iter') openIterForm(tr.slug, null);
      else if (act === 'edit') openTrackForm(tr.slug);
      else if (act === 'archive') archiveTrack(tr.slug);
      return;
    }
    viewTrack(tr.slug);
  });

  return card;
}

// ─── Roadmap view ──────────────────────────────────────────────────────────

function viewTrack(slug) {
  STATE.viewedTrack = slug;
  STATE.viewedTrackData = null;
  if (location.hash !== `#track/${slug}`) location.hash = `#track/${slug}`;
  loadTrackRoadmap();
}

function exitTrackView() {
  STATE.viewedTrack = null;
  STATE.viewedTrackData = null;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  renderTracks();
}

async function loadTrackRoadmap() {
  const slug = STATE.viewedTrack;
  if (!slug) return;
  try {
    const r = await api(`/api/track/${encodeURIComponent(slug)}`);
    STATE.viewedTrackData = r;
  } catch (e) {
    toast(`load failed: ${e.message}`, 'error');
    exitTrackView();
    return;
  }
  renderTrackRoadmap();
}

function renderTrackRoadmap() {
  const view = document.getElementById('view-tracks');
  view.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'roadmap-page';

  const data = STATE.viewedTrackData;
  if (!data) {
    page.innerHTML = `<div class="tracks-empty"><h2>Loading…</h2></div>`;
    view.appendChild(page);
    loadTrackRoadmap();
    return;
  }
  const tr = data.track || {};
  const slug = STATE.viewedTrack;
  const iters = data.iterations || [];
  const activeId = data.active;
  const shipped = tr.fm?.status === 'shipped';
  const allClosed = iters.length > 0 && iters.every(it => it.status === 'done' || it.status === 'abandoned');
  const canVerify = allClosed && !shipped;

  const header = document.createElement('div');
  header.className = 'roadmap-header';
  header.innerHTML = `
    <button class="iconbtn roadmap-back" title="Back to tracks">←</button>
    <div class="roadmap-title-block">
      <div class="roadmap-slug mono">${escapeHtml(slug)}${shipped ? ' <span class="roadmap-shipped-badge">SHIPPED</span>' : ''}</div>
      ${tr.fm?.title ? `<div class="roadmap-title">${escapeHtml(tr.fm.title)}</div>` : ''}
    </div>
    <div class="roadmap-actions">
      ${canVerify ? `<button class="btn btn-primary" data-act="verify">✓ Verify track</button>` : ''}
      ${shipped ? `<button class="btn btn-ghost" data-act="verify">View checklist</button>` : ''}
      <button class="btn btn-ghost" data-act="new-iter">+ Iteration</button>
      <button class="btn btn-ghost" data-act="edit">✎ Edit</button>
      <button class="btn btn-ghost" data-act="archive">⌫ Archive</button>
    </div>
  `;
  header.querySelector('.roadmap-back').addEventListener('click', exitTrackView);
  header.querySelector('[data-act="new-iter"]').addEventListener('click', () => openIterForm(slug, null));
  header.querySelector('[data-act="edit"]').addEventListener('click', () => openTrackForm(slug));
  header.querySelector('[data-act="archive"]').addEventListener('click', () => archiveTrack(slug));
  const vbtn = header.querySelector('[data-act="verify"]');
  if (vbtn) vbtn.addEventListener('click', () => openTrackChecklist(slug, { shipped }));
  page.appendChild(header);

  if (!iters.length) {
    const empty = document.createElement('div');
    empty.className = 'tracks-empty';
    empty.innerHTML = `<h2>No iterations</h2><p>click <span class="cmd">+ Iteration</span> to add the first one</p>`;
    page.appendChild(empty);
    view.appendChild(page);
    return;
  }

  const rail = document.createElement('div');
  rail.className = 'roadmap-rail';
  for (let i = 0; i < iters.length; i++) {
    rail.appendChild(renderRoadmapNode(slug, iters[i], i === 0, i === iters.length - 1, activeId));
  }
  rail.addEventListener('wheel', e => {
    if (e.shiftKey) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if (e.target.closest('.rm-tasks')) {
      const ul = e.target.closest('.rm-tasks');
      if (ul.scrollHeight > ul.clientHeight) return;
    }
    rail.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  page.appendChild(rail);

  view.appendChild(page);
}

function renderRoadmapNode(trackSlug, it, isFirst, isLast, activeId) {
  const node = document.createElement('div');
  const isActive = (it.id === activeId) || it.status === 'active';
  node.className = `roadmap-node s-${it.status}` + (isActive ? ' is-active' : '');

  const tasks = it.tasks || [];
  const doneCount = tasks.filter(t => t.status === 'done').length;
  const openTasks = tasks.filter(t => t.status !== 'done');
  const onlyUserTasks = openTasks.length > 0 && openTasks.every(t => (t.assignee || 'user') === 'user');
  const lock = it.iterate_lock || null;
  const startDisabled = !tasks.length || onlyUserTasks || !!lock;
  const startTitle = !tasks.length
    ? 'No tasks in iteration'
    : lock
      ? `/iterate already running (started ${lock.at}) — close that terminal or unlock`
      : onlyUserTasks
        ? 'All open tasks are assigned to user — nothing to orchestrate'
        : `Open terminal and run /iterate ${trackSlug} ${it.id}`;
  const taskItems = tasks.length
    ? tasks.map(t => `
        <li class="rm-task s-${t.status}" data-task="${escapeHtml(t.id)}" title="${escapeHtml(t.title || '')}">
          <span class="dot s-${t.status}${t.status === 'in-progress' ? ' pulse' : ''}"></span>
          <span class="rm-task-id mono">${escapeHtml(t.id)}</span>
          <span class="rm-task-title">${escapeHtml(t.title || '')}</span>
        </li>`).join('')
    : '<li class="rm-task-empty muted">no tasks</li>';

  node.innerHTML = `
    <div class="rm-line ${isFirst ? 'no-left' : ''} ${isLast ? 'no-right' : ''}">
      <span class="rm-bullet"></span>
    </div>
    <div class="rm-card">
      <div class="rm-head">
        <span class="rm-id mono">${escapeHtml(it.id)}</span>
        <span class="rm-slug mono">${escapeHtml(it.slug)}</span>
        ${isActive ? `<span class="iter-active-badge">HEAD</span>` : ''}
        ${it.status === 'abandoned' ? `<span class="iter-tag-abandoned">abandoned</span>` : ''}
        ${lock ? `<span class="rm-lock-badge" title="iterate terminal running since ${escapeHtml(lock.at)}">⚙ LOCKED</span>` : ''}
      </div>
      ${it.title && it.title !== it.slug ? `<div class="rm-title">${escapeHtml(it.title)}</div>` : ''}
      <div class="rm-meta mono">${doneCount}/${tasks.length} done · ${escapeHtml(it.status)}</div>
      <ul class="rm-tasks">${taskItems}</ul>
      ${isActive ? `<button class="rm-start-circle" data-act="iterate"${startDisabled ? ' disabled' : ''} title="${escapeHtml(startTitle)}">▶</button>` : ''}
      <div class="rm-card-actions">
        ${it.status === 'planned' ? `<button class="iconbtn" data-act="activate" title="Activate">▶</button>` : ''}
        ${lock ? `<button class="iconbtn" data-act="unlock" title="Clear .iterate.lock (use if the terminal crashed)">⊘</button>` : ''}
        <button class="iconbtn" data-act="edit" title="Edit">✎</button>
        ${(it.status !== 'done' && it.status !== 'abandoned') ? `<button class="iconbtn" data-act="archive" title="Close as done">✓</button>` : ''}
        ${it.status === 'planned' && tasks.length === 0 ? `<button class="iconbtn" data-act="delete" title="Delete">×</button>` : ''}
      </div>
    </div>
  `;

  node.addEventListener('click', e => {
    const taskEl = e.target.closest('.rm-task[data-task]');
    if (taskEl) {
      e.stopPropagation();
      openModal(taskEl.dataset.task);
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'activate') activateIter(trackSlug, it.id);
    else if (act === 'edit') openIterForm(trackSlug, it.id);
    else if (act === 'archive') archiveIter(trackSlug, it.id);
    else if (act === 'delete') deleteIter(trackSlug, it.id);
    else if (act === 'iterate') iterateInTerminal(trackSlug, it.id);
    else if (act === 'unlock') unlockIteration(trackSlug, it.id);
  });

  return node;
}

// Per-iteration debounce: even though the server holds an .iterate.lock, the
// UI can race ahead before SSE refreshes the lock state, so keep a short
// in-memory window per iter.
const ITERATE_DEBOUNCE = new Map();
const ITERATE_DEBOUNCE_MS = 10_000;

async function iterateInTerminal(track, id) {
  const key = `${track}/${id}`;
  const last = ITERATE_DEBOUNCE.get(key) || 0;
  if (Date.now() - last < ITERATE_DEBOUNCE_MS) {
    toast('already launching — wait a moment', 'warn');
    return;
  }
  ITERATE_DEBOUNCE.set(key, Date.now());
  try {
    await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}/iterate`, { method: 'POST' });
    toast(`terminal launched · /iterate ${track} ${id}`, 'success');
    await refresh();
  } catch (e) {
    ITERATE_DEBOUNCE.delete(key);
    toast(`launch failed: ${e.message}`, 'error');
  }
}

async function unlockIteration(track, id) {
  if (!await confirmModal({
    title: 'Unlock iteration',
    message: `Clear the <code>.iterate.lock</code> for iter <b>${escapeHtml(id)}</b>?<br><span style="color:var(--fg-2);font-size:11px">Use only if the previous /iterate terminal crashed. If it's still running, you'll get a double-orchestrator race.</span>`,
    confirmText: 'Unlock',
    danger: true,
  })) return;
  try {
    await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}/iterate-lock`, { method: 'DELETE' });
    toast('unlocked', 'success');
    await refresh();
  } catch (e) { toast(`unlock failed: ${e.message}`, 'error'); }
}


function countIters(iters) {
  const c = { planned: 0, active: 0, done: 0, abandoned: 0 };
  for (const it of iters) c[it.status] = (c[it.status] || 0) + 1;
  return c;
}

function extractGoalPreview(body) {
  if (!body) return '';
  const m = /^##\s+Цель\s*$/m.exec(body);
  if (!m) return '';
  const start = m.index + m[0].length;
  const tail = body.slice(start);
  const nxt = /^##\s+/m.exec(tail);
  const end = nxt ? start + nxt.index : body.length;
  return body.slice(start, end).trim().replace(/\s+/g, ' ').slice(0, 120);
}

// ─── Track form ─────────────────────────────────────────────────────────────

async function openTrackForm(slug) {
  let t = null;
  if (slug) {
    try { const r = await api(`/api/track/${encodeURIComponent(slug)}`); t = r.track; }
    catch (e) { toast(`load failed: ${e.message}`, 'error'); return; }
  }
  const isNew = !t;
  const html = `
    <div class="form-row"><label>Slug</label><input class="input mono" id="tf-slug" ${isNew ? '' : 'readonly'} value="${escapeHtml(t?.slug || '')}" placeholder="kebab-case"></div>
    <div class="form-row"><label>Title</label><input class="input" id="tf-title" value="${escapeHtml(t?.fm?.title || '')}" placeholder="human title"></div>
    ${!isNew ? `<div class="form-row"><label>Status</label><select class="input" id="tf-status"><option value="active" ${t.fm?.status !== 'archived' ? 'selected' : ''}>active</option><option value="archived" ${t.fm?.status === 'archived' ? 'selected' : ''}>archived</option></select></div>` : ''}
    <div class="form-row"><label>Body</label><textarea class="textarea mono" id="tf-body" placeholder="## Цель\n...\n\n## Scope\n- ...\n\n## Заметки">${escapeHtml(t?.body || '')}</textarea></div>
  `;
  openFormModal(isNew ? 'New track' : `Edit track · ${t.slug}`, html, async () => {
    const slug2 = (document.getElementById('tf-slug').value || '').trim().toLowerCase();
    const title = document.getElementById('tf-title').value || '';
    const body = document.getElementById('tf-body').value || '';
    const status = document.getElementById('tf-status')?.value;
    if (isNew) {
      await api('/api/tracks', { method: 'POST', body: JSON.stringify({ slug: slug2, title, body }) });
      toast(`track ${slug2} created`, 'success');
    } else {
      const patch = { title, body };
      if (status) patch.status = status;
      await api(`/api/track/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      toast(`track ${slug} saved`, 'success');
    }
    closeFormModal();
    await refresh();
  });
}

async function archiveTrack(slug) {
  if (!await confirmModal({
    title: 'Archive track',
    message: `Archive track <b>${escapeHtml(slug)}</b>? Moves to <code>.workflow/archive/tracks/</code>.`,
    confirmText: 'Archive',
    danger: true,
  })) return;
  try {
    const r = await api(`/api/track/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    toast(`archived → ${r.archived_to}`, 'success');
    await refresh();
  } catch (e) { toast(`archive failed: ${e.message}`, 'error'); }
}

// ─── Iteration form ─────────────────────────────────────────────────────────

async function openIterForm(trackSlug, iterId) {
  const isNew = !iterId;
  let it = null;
  if (!isNew) {
    try {
      const r = await api(`/api/track/${encodeURIComponent(trackSlug)}`);
      it = (r.iterations || []).find(x => x.id === iterId);
      if (!it) { toast('iteration not found', 'error'); return; }
    } catch (e) { toast(`load failed: ${e.message}`, 'error'); return; }
  }
  const defaultBody = `## Цель\n(одно-два предложения что итерация выдаёт на выходе)\n\n## Scope\nЧто входит:\n- ...\nЧто НЕ входит:\n- ...\n\n## Exit criteria\n- [ ] Все таски done\n- [ ] (конкретное наблюдаемое условие)\n\n## Заметки\n`;

  const html = `
    <div class="form-row"><label>Track</label><input class="input mono" value="${escapeHtml(trackSlug)}" readonly></div>
    <div class="form-row"><label>Slug</label><input class="input mono" id="if-slug" value="${escapeHtml(it?.slug || '')}" placeholder="kebab-case"></div>
    <div class="form-row"><label>Title</label><input class="input" id="if-title" value="${escapeHtml(it?.fm?.title || it?.title || '')}" placeholder="human title"></div>
    <div class="form-row"><label>Status</label>
      <select class="input" id="if-status">
        <option value="planned"   ${(!it || it.status === 'planned') ? 'selected' : ''}>planned</option>
        <option value="active"    ${it?.status === 'active' ? 'selected' : ''}>active</option>
        <option value="done"      ${it?.status === 'done' ? 'selected' : ''}>done</option>
        <option value="abandoned" ${it?.status === 'abandoned' ? 'selected' : ''}>abandoned</option>
      </select>
    </div>
    <div class="form-row"><label>README</label><textarea class="textarea mono" id="if-body">${escapeHtml(it?.body || defaultBody)}</textarea></div>
  `;
  openFormModal(isNew ? `New iteration · ${trackSlug}` : `Edit iter ${iterId} · ${trackSlug}`, html, async () => {
    const slug2 = (document.getElementById('if-slug').value || '').trim().toLowerCase();
    const title = document.getElementById('if-title').value || '';
    const status = document.getElementById('if-status').value;
    const body = document.getElementById('if-body').value || '';
    if (isNew) {
      await api(`/api/track/${encodeURIComponent(trackSlug)}/iterations`, {
        method: 'POST',
        body: JSON.stringify({ slug: slug2, title, status, body }),
      });
      toast(`iter ${slug2} created`, 'success');
    } else {
      const patch = { title, status, body };
      if (slug2 !== it.slug) patch.slug = slug2;
      await api(`/api/track/${encodeURIComponent(trackSlug)}/iteration/${encodeURIComponent(iterId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      toast(`iter ${iterId} saved`, 'success');
    }
    closeFormModal();
    await refresh();
  });
}

async function activateIter(track, id) {
  try {
    await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}/activate`, { method: 'POST' });
    toast(`iter ${id} activated in ${track}`, 'success');
    await refresh();
  } catch (e) { toast(`activate failed: ${e.message}`, 'error'); }
}

async function archiveIter(track, id) {
  if (!await confirmModal({
    title: 'Close iteration',
    message: `Close iter <b>${escapeHtml(id)}</b> in <b>${escapeHtml(track)}</b> as <b>done</b>?`,
    confirmText: 'Close as done',
  })) return;
  try {
    await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}/archive`, {
      method: 'POST', body: JSON.stringify({ status: 'done' }),
    });
    toast(`iter ${id} closed`, 'success');
    await refresh();
  } catch (e) { toast(`archive failed: ${e.message}`, 'error'); }
}

async function deleteIter(track, id) {
  if (!await confirmModal({
    title: 'Delete iteration',
    message: `Delete planned iter <b>${escapeHtml(id)}</b>?<br><span style="color:var(--fg-2);font-size:11px">Only allowed for empty planned iterations.</span>`,
    confirmText: 'Delete',
    danger: true,
  })) return;
  try {
    await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast(`iter ${id} deleted`, 'success');
    await refresh();
  } catch (e) { toast(`delete failed: ${e.message}`, 'error'); }
}

// ─── Auto-iteration close + checklist ──────────────────────────────────────

async function startIter(track, id, force = false) {
  if (!await confirmModal({
    title: force ? 'Re-dispatch iteration' : 'Start iteration',
    message: force
      ? `Re-dispatch every <b>todo</b> task in iter <b>${escapeHtml(id)}</b>? Already-running tasks are untouched; this picks up todos added after the first start.`
      : `Dispatch every <b>todo</b> task in iter <b>${escapeHtml(id)}</b> to its agent? Agents will start pulling tasks from the queue immediately.`,
    confirmText: force ? 'Re-dispatch' : 'Dispatch all',
  })) return;
  try {
    const r = await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}/start`, {
      method: 'POST', body: JSON.stringify(force ? { force: true } : {}),
    });
    const skipped = (r.skipped || []).length;
    const queued = (r.queued || []).length;
    const pending = (r.pending || []).length;
    const head = `queued ${queued}${pending ? ` · pending ${pending} (auto-dispatch when deps complete)` : ''}`;
    if (skipped) {
      const reasons = r.skipped.slice(0, 3).map(s => `${s.id}: ${s.reason}`).join('; ');
      toast(`${head} · skipped ${skipped} (${reasons}${skipped > 3 ? '…' : ''})`, (queued || pending) ? 'success' : 'error');
    } else {
      toast(head, 'success');
    }
    await refresh();
  } catch (e) { toast(`start failed: ${e.message}`, 'error'); }
}

// ─── Finalize iteration modal ─────────────────────────────────────────────
//
// Verification surface for an iteration. Server already committed each task
// (auto_verify tasks: auto-approved on submit; manual tasks: committed on
// user approve via the Verify panel). Finalize itself just runs the user
// through "How to verify" per task and writes CHECKLIST.md.

async function openFinalizeModal(track, id) {
  let info;
  try {
    info = await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}/finalize-info`);
  } catch (e) {
    toast(`finalize-info failed: ${e.message}`, 'error');
    return;
  }

  const tasks = info.tasks || [];
  const incomplete = info.incomplete || [];
  const closed = tasks.filter(t => t.status === 'done');

  const checklistState = []; // [{taskId, line, checked}]
  for (const t of closed) {
    const verify = (t.verify || '').trim();
    if (verify) {
      for (const raw of verify.split('\n')) {
        const line = raw.replace(/^[-*]\s*\[[ xX]\]\s*/, '').trim();
        if (line) checklistState.push({ taskId: t.id, line, checked: false });
      }
    } else {
      checklistState.push({ taskId: t.id, line: '(no manual steps — auto-verify only)', checked: false, autoOnly: true });
    }
  }

  const renderChecklist = () => {
    const byTask = new Map();
    for (let i = 0; i < checklistState.length; i++) {
      const it = checklistState[i];
      if (!byTask.has(it.taskId)) byTask.set(it.taskId, []);
      byTask.get(it.taskId).push({ ...it, idx: i });
    }
    const parts = [];
    for (const t of closed) {
      const items = byTask.get(t.id) || [];
      parts.push(`<div class="fin-task"><div class="fin-task-head"><span class="mono">${escapeHtml(t.id)}</span> <span>${escapeHtml(t.title)}</span> <span class="muted">· ${escapeHtml(t.status)}</span></div>`);
      for (const it of items) {
        if (it.autoOnly) {
          parts.push(`<div class="fin-item muted">${escapeHtml(it.line)}</div>`);
        } else {
          parts.push(`<label class="fin-item"><input type="checkbox" data-fin-idx="${it.idx}" ${it.checked ? 'checked' : ''}> <span>${escapeHtml(it.line)}</span></label>`);
        }
      }
      parts.push('</div>');
    }
    return parts.join('');
  };

  const renderSummary = () => {
    const parts = [];
    for (const t of tasks) {
      const tag = t.status === 'done' ? '✓'
                : t.status === 'verifying' ? '…'
                : t.status;
      const cls = t.status === 'done' ? 'fin-summary-ok'
                : t.status === 'verifying' ? 'fin-summary-pending'
                : 'fin-summary-pending';
      parts.push(`<div class="fin-summary-row ${cls}"><span class="fin-summary-tag">${escapeHtml(tag)}</span> <span class="mono">${escapeHtml(t.id)}</span> <span>${escapeHtml(t.title)}</span> <span class="muted">${escapeHtml(t.status)}${t.attempts ? ` · ×${t.attempts}` : ''}</span></div>`);
    }
    return parts.join('');
  };

  const incompleteBlock = incomplete.length ? `
    <div class="fin-warn">
      <div class="fin-warn-head">⚠ ${incomplete.length} task${incomplete.length > 1 ? 's' : ''} not closed</div>
      <ul class="fin-warn-list">
        ${incomplete.map(t => `<li><span class="mono">${escapeHtml(t.id)}</span> · ${escapeHtml(t.status)} · ${escapeHtml(t.title)}</li>`).join('')}
      </ul>
      <label class="fin-ack"><input type="checkbox" id="fin-ack"> I understand. Closing the iteration anyway leaves these tasks behind.</label>
    </div>
  ` : '';

  const rootInfo = info.root_branch
    ? `<div class="fin-root muted">ROOT branch: <code>${escapeHtml(info.root_branch)}</code></div>`
    : '';

  const totalItems = () => checklistState.filter(it => !it.autoOnly).length;
  const checkedItems = () => checklistState.filter(it => !it.autoOnly && it.checked).length;
  const progressLine = () => `${checkedItems()} / ${totalItems()} verified${closed.length < tasks.length ? ` · ${tasks.length - closed.length} not closed` : ''}`;

  const body = `
    <div class="fin-head">
      <div><b>iter ${escapeHtml(info.iteration.id)}</b>${info.iteration.title ? ` · ${escapeHtml(info.iteration.title)}` : ''}</div>
      ${rootInfo}
    </div>

    <div class="fin-section">
      <div class="fin-section-head">Verification checklist <span class="fin-progress" id="fin-progress">${progressLine()}</span></div>
      <div class="fin-checklist">${renderChecklist() || '<div class="muted">no closed tasks yet</div>'}</div>
    </div>

    <div class="fin-section">
      <div class="fin-section-head">Iteration summary</div>
      <div class="fin-summary">${renderSummary()}</div>
    </div>

    ${incompleteBlock}
  `;

  openFormModal(`Finalize iteration ${id}`, body, async () => {
    const ackEl = document.getElementById('fin-ack');
    const ackIncomplete = !!(ackEl && ackEl.checked);
    if (incomplete.length && !ackIncomplete) { toast('confirm incomplete tasks first', 'error'); return; }
    if (totalItems() > 0 && checkedItems() < totalItems()) {
      const yes = await confirmModal({
        title: 'Checklist not fully verified',
        message: `${checkedItems()} of ${totalItems()} items ticked. Close iteration anyway?`,
        confirmText: 'Close anyway',
      });
      if (!yes) return;
    }
    const r = await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}/finalize`, {
      method: 'POST', body: JSON.stringify({ ack_incomplete: ackIncomplete }),
    });
    closeFormModal();
    const closedCount = (r.closed || []).length;
    toast(`iteration finalized · ${closedCount} task${closedCount === 1 ? '' : 's'} closed`, 'success');
    await refresh();
  }, { size: 'xl', confirmText: 'Finalize iteration' });

  // Live checkbox / progress wiring.
  const root = document.getElementById('form-body');
  root.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox][data-fin-idx]');
    if (cb) {
      const idx = Number(cb.dataset.finIdx);
      if (!Number.isNaN(idx) && checklistState[idx]) {
        checklistState[idx].checked = cb.checked;
        const prog = document.getElementById('fin-progress');
        if (prog) prog.textContent = progressLine();
      }
    }
  });
}

// Parse markdown checklist lines into a tree of headings + items.
function parseChecklistMd(md) {
  const lines = md.split('\n');
  const out = []; // [{ kind: 'h'|'item'|'p', level, text, checked? }]
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let m;
    if ((m = /^(#{1,4})\s+(.+?)\s*$/.exec(ln))) {
      out.push({ kind: 'h', level: m[1].length, text: m[2] });
    } else if ((m = /^([-*])\s+\[( |x|X)\]\s+(.+?)\s*$/.exec(ln))) {
      out.push({ kind: 'item', text: m[3], checked: m[2].toLowerCase() === 'x', _orig: ln });
    } else if (ln.trim()) {
      out.push({ kind: 'p', text: ln });
    } else {
      out.push({ kind: 'br' });
    }
  }
  return out;
}

function renderChecklistHtml(nodes) {
  const parts = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'h') {
      parts.push(`<h${Math.min(n.level + 1, 6)} class="ck-h">${escapeHtml(n.text)}</h${Math.min(n.level + 1, 6)}>`);
    } else if (n.kind === 'item') {
      parts.push(`<label class="ck-item"><input type="checkbox" data-idx="${i}" ${n.checked ? 'checked' : ''}> <span>${escapeHtml(n.text)}</span></label>`);
    } else if (n.kind === 'p') {
      parts.push(`<div class="ck-p">${escapeHtml(n.text)}</div>`);
    } else {
      parts.push('<div class="ck-br"></div>');
    }
  }
  return parts.join('');
}

function checklistToMd(nodes) {
  const lines = [];
  for (const n of nodes) {
    if (n.kind === 'h') lines.push(`${'#'.repeat(n.level)} ${n.text}`);
    else if (n.kind === 'item') lines.push(`- [${n.checked ? 'x' : ' '}] ${n.text}`);
    else if (n.kind === 'p') lines.push(n.text);
    else lines.push('');
  }
  return lines.join('\n');
}

async function openTrackChecklist(slug, opts = {}) {
  const shipped = !!opts.shipped;
  let r;
  try {
    r = await api(`/api/track/${encodeURIComponent(slug)}/checklist`);
  } catch (e) {
    toast(`load failed: ${e.message}`, 'error');
    return;
  }
  let nodes = parseChecklistMd(r.content || '');
  const totalItems = () => nodes.filter(n => n.kind === 'item').length;
  const checkedItems = () => nodes.filter(n => n.kind === 'item' && n.checked).length;

  const renderBody = () => `
    <div class="ck-progress">${checkedItems()} / ${totalItems()} verified${shipped ? ' · shipped' : ''}</div>
    <div class="ck-list">${renderChecklistHtml(nodes)}</div>
  `;

  openFormModal(`Verify track · ${slug}`, renderBody(), async () => {
    const md = checklistToMd(nodes);
    try {
      await api(`/api/track/${encodeURIComponent(slug)}/checklist`, {
        method: 'PUT', body: JSON.stringify({ content: md }),
      });
    } catch (e) { toast(`save failed: ${e.message}`, 'error'); return; }
    if (shipped) { toast('saved', 'success'); closeFormModal(); return; }
    if (totalItems() > 0 && checkedItems() === totalItems()) {
      closeFormModal();
      const yes = await confirmModal({
        title: 'Ship track',
        message: `Every item checked. Mark track <b>${escapeHtml(slug)}</b> as <b>shipped</b>?`,
        confirmText: 'Ship',
      });
      if (yes) {
        try {
          await api(`/api/track/${encodeURIComponent(slug)}/ship`, { method: 'POST', body: JSON.stringify({}) });
          toast(`track ${slug} shipped`, 'success');
          await refresh();
          if (STATE.viewedTrack === slug) await loadTrackRoadmap();
        } catch (e) { toast(`ship failed: ${e.message}`, 'error'); }
      }
    } else {
      toast('checklist saved', 'success');
      closeFormModal();
    }
  }, { size: 'lg', confirmText: shipped ? 'Save' : 'Save progress' });

  const body = document.getElementById('form-body');
  body.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox][data-idx]');
    if (!cb) return;
    const idx = Number(cb.dataset.idx);
    if (Number.isNaN(idx) || !nodes[idx]) return;
    nodes[idx].checked = cb.checked;
    const prog = body.querySelector('.ck-progress');
    if (prog) prog.textContent = `${checkedItems()} / ${totalItems()} verified${shipped ? ' · shipped' : ''}`;
  });
}

async function openIterChecklist(track, id) {
  let r;
  try {
    r = await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}/checklist`);
  } catch (e) {
    toast(`no checklist: ${e.message}`, 'error');
    return;
  }
  let nodes = parseChecklistMd(r.content || '');
  const totalItems = () => nodes.filter(n => n.kind === 'item').length;
  const checkedItems = () => nodes.filter(n => n.kind === 'item' && n.checked).length;

  const renderBody = () => `
    <div class="ck-progress">${checkedItems()} / ${totalItems()} verified</div>
    <div class="ck-list">${renderChecklistHtml(nodes)}</div>
  `;

  openFormModal(`Verify checklist · iter ${id}`, renderBody(), async () => {
    const md = checklistToMd(nodes);
    await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}/checklist`, {
      method: 'PUT', body: JSON.stringify({ content: md }),
    });
    if (totalItems() > 0 && checkedItems() === totalItems()) {
      // All boxes ticked — offer to mark iteration done.
      closeFormModal();
      const yes = await confirmModal({
        title: 'All verified',
        message: `Every checklist item is ticked. Mark iter <b>${escapeHtml(id)}</b> as <b>done</b>?`,
        confirmText: 'Mark done',
      });
      if (yes) {
        await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}/archive`, {
          method: 'POST', body: JSON.stringify({ status: 'done' }),
        });
        toast(`iter ${id} done`, 'success');
        await refresh();
      }
    } else {
      toast('checklist saved', 'success');
      closeFormModal();
    }
  }, { size: 'lg', confirmText: 'Save' });

  // Wire checkbox toggles to update local state and progress counter live.
  const body = document.getElementById('form-body');
  body.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox][data-idx]');
    if (!cb) return;
    const idx = Number(cb.dataset.idx);
    if (Number.isNaN(idx) || !nodes[idx]) return;
    nodes[idx].checked = cb.checked;
    const prog = body.querySelector('.ck-progress');
    if (prog) prog.textContent = `${checkedItems()} / ${totalItems()} verified`;
  });
}

async function reorderIters(track, fromId, toId) {
  const tr = (STATE.tracks.tracks || []).find(t => t.slug === track);
  if (!tr) return;
  const ids = (tr.iterations || []).map(it => it.id);
  const fromIdx = ids.indexOf(fromId);
  const toIdx = ids.indexOf(toId);
  if (fromIdx < 0 || toIdx < 0) return;
  ids.splice(fromIdx, 1);
  ids.splice(toIdx, 0, fromId);
  try {
    await api(`/api/track/${encodeURIComponent(track)}/iterations/reorder`, {
      method: 'POST', body: JSON.stringify({ order: ids }),
    });
    toast('reordered', 'success');
    await refresh();
  } catch (e) { toast(`reorder failed: ${e.message}`, 'error'); }
}

// ─── Generic form modal ─────────────────────────────────────────────────────

let FORM_SUBMIT = null;

function openFormModal(title, innerHtml, onSubmit, opts = {}) {
  FORM_SUBMIT = onSubmit;
  document.getElementById('form-title').textContent = title;
  document.getElementById('form-body').innerHTML = innerHtml;
  const m = document.querySelector('#form-bg .modal');
  if (m) {
    m.classList.toggle('modal-sm',   opts.size === 'sm');
    m.classList.toggle('modal-md',   opts.size === 'md');
    m.classList.toggle('modal-lg',   opts.size === 'lg' || !opts.size);
    m.classList.toggle('modal-xl',   opts.size === 'xl');
  }
  const saveBtn = document.getElementById('form-save');
  if (saveBtn) saveBtn.textContent = opts.confirmText || 'Save';
  document.getElementById('form-bg').classList.add('open');
}

function closeFormModal() {
  document.getElementById('form-bg').classList.remove('open');
  FORM_SUBMIT = null;
}

async function submitFormModal() {
  if (!FORM_SUBMIT) return;
  try { await FORM_SUBMIT(); }
  catch (e) { toast(`save failed: ${e.message}`, 'error'); }
}

function bindFormModal() {
  document.getElementById('form-cancel').addEventListener('click', closeFormModal);
  document.getElementById('form-save').addEventListener('click', submitFormModal);
  document.getElementById('form-bg').addEventListener('click', e => {
    if (e.target.id === 'form-bg') closeFormModal();
  });
}

window.renderTracks = renderTracks;
window.viewTrack = viewTrack;
window.exitTrackView = exitTrackView;
window.loadTrackRoadmap = loadTrackRoadmap;
window.bindFormModal = bindFormModal;
window.openTrackForm = openTrackForm;
window.openIterForm = openIterForm;
window.openFinalizeModal = openFinalizeModal;
window.openTrackChecklist = openTrackChecklist;
window.closeFormModal = closeFormModal;
