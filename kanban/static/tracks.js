// Workflow — Tracks page (design markup: track-section / track-head grid / iter-row s-status).

const ITER_GLYPHS = { planned: '◯', active: '●', done: '✓', abandoned: '×' };

function renderTracks() {
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
  if (STATE.search) {
    // auto-expand matching tracks during search
    for (const t of tracks) STATE.expandedTracks.add(t.slug);
  }

  // header
  const header = document.createElement('div');
  header.className = 'tracks-header';
  const archivedCount = 0; // backend doesn't expose archived list
  header.innerHTML = `
    <div>
      <h1>Tracks</h1>
      <div class="subtitle mono">${tracks.length} active${archivedCount ? ' · ' + archivedCount + ' archived' : ''}</div>
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

  const list = document.createElement('div');
  list.className = 'tracks-list';
  for (const tr of tracks) list.appendChild(renderTrackSection(tr));
  page.appendChild(list);

  view.appendChild(page);
}

function renderTrackSection(tr) {
  const expanded = STATE.expandedTracks.has(tr.slug);
  const sec = document.createElement('div');
  sec.className = 'track-section' + (expanded ? ' expanded' : '');

  const counts = countIters(tr.iterations || []);
  const preview = extractGoalPreview(tr.body || '');
  const title = tr.fm?.title || '';

  const head = document.createElement('div');
  head.className = 'track-head';
  head.innerHTML = `
    <span class="track-toggle">▸</span>
    <span class="track-slug">${escapeHtml(tr.slug)}</span>
    <div style="display:flex;align-items:center;gap:14px;min-width:0">
      ${title ? `<span class="track-title">${escapeHtml(title)}</span>` : ''}
      ${preview ? `<span class="track-preview">${escapeHtml(preview)}</span>` : ''}
    </div>
    <div class="track-meta">
      <span class="iter-counter c-planned"><span class="iter-counter-glyph">◯</span>${counts.planned}</span>
      <span class="iter-counter c-active"><span class="iter-counter-glyph">●</span>${counts.active}</span>
      <span class="iter-counter c-done"><span class="iter-counter-glyph">✓</span>${counts.done}</span>
    </div>
    <div class="track-actions">
      <button class="iconbtn" title="Open in board" data-act="board">⊞</button>
      <button class="iconbtn" title="New iteration" data-act="new-iter">+</button>
      <button class="iconbtn" title="Edit track" data-act="edit">✎</button>
      <button class="iconbtn" title="Archive track" data-act="archive">⌫</button>
    </div>
  `;
  head.addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'board') {
        STATE.boardTrack = tr.slug;
        setTab('iteration');
        refresh();
      } else if (act === 'new-iter') openIterForm(tr.slug, null);
      else if (act === 'edit') openTrackForm(tr.slug);
      else if (act === 'archive') archiveTrack(tr.slug);
      return;
    }
    // toggle
    if (STATE.expandedTracks.has(tr.slug)) STATE.expandedTracks.delete(tr.slug);
    else STATE.expandedTracks.add(tr.slug);
    renderTracks();
  });
  sec.appendChild(head);

  if (expanded) {
    const body = document.createElement('div');
    body.className = 'track-body';
    const iters = tr.iterations || [];
    if (!iters.length) {
      body.innerHTML = `<div class="iter-empty">no iterations yet. click <b>+</b> on the right.</div>`;
    } else {
      for (const it of iters) body.appendChild(renderIterRow(tr, it));
    }
    sec.appendChild(body);
  }

  return sec;
}

function renderIterRow(tr, it) {
  const row = document.createElement('div');
  row.className = `iter-row s-${it.status}`;
  row.dataset.id = it.id;

  const isPlanned = it.status === 'planned';
  row.draggable = isPlanned;

  const isActive = tr.active === it.id || it.status === 'active';
  const taskCount = it.task_count || 0;

  const actBtns = [];
  if (isPlanned) actBtns.push(`<button class="iconbtn" data-act="activate" title="Activate">▶</button>`);
  if (isActive) actBtns.push(`<button class="iconbtn" data-act="board" title="Open in board">⊞</button>`);
  actBtns.push(`<button class="iconbtn" data-act="edit" title="Edit">✎</button>`);
  if (isPlanned && taskCount === 0) actBtns.push(`<button class="iconbtn" data-act="delete" title="Delete">×</button>`);
  if (it.status !== 'done' && it.status !== 'abandoned') actBtns.push(`<button class="iconbtn" data-act="archive" title="Archive (close as done)">⌫</button>`);

  const started = it.fm?.started || it.started || '';
  const relTime = relativeDate(started);
  const doneCount = (typeof it.done_count === 'number') ? it.done_count : null;

  // Title prefers free-form fm.title, falls back to slug derivation
  const title = it.title || it.fm?.title || '';
  const sub = title && title !== it.slug ? title : '';

  // Build meta segments (git-log-style: id · started · tasks · relative)
  const meta = [];
  if (started) meta.push(`<span title="started">${escapeHtml(started)}</span>`);
  if (taskCount > 0) {
    const taskLabel = doneCount != null
      ? `${doneCount}/${taskCount} done`
      : `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`;
    meta.push(`<span>${taskLabel}</span>`);
  } else {
    meta.push(`<span class="muted">no tasks</span>`);
  }
  if (relTime) meta.push(`<span class="muted">${escapeHtml(relTime)}</span>`);

  row.innerHTML = `
    <div class="iter-rail"><span class="iter-bullet">${ITER_GLYPHS[it.status] || '·'}</span></div>
    <div class="iter-body">
      <div class="iter-headline">
        <span class="iter-id">${escapeHtml(it.id)}</span>
        <span class="iter-slug">${escapeHtml(it.slug)}</span>
        ${sub ? `<span class="iter-sep">·</span><span class="iter-title">${escapeHtml(sub)}</span>` : ''}
        ${isActive ? `<span class="iter-active-badge">HEAD</span>` : ''}
        ${it.status === 'abandoned' ? `<span class="iter-tag-abandoned">abandoned</span>` : ''}
      </div>
      <div class="iter-meta">${meta.join('<span class="iter-meta-sep">·</span>')}</div>
    </div>
    <div class="iter-actions">${actBtns.join('')}</div>
  `;

  if (isPlanned) {
    row.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ track: tr.slug, id: it.id }));
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
  }
  row.addEventListener('dragover', e => {
    if (!isPlanned) return;
    e.preventDefault();
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', async e => {
    e.preventDefault();
    row.classList.remove('drop-target');
    if (!isPlanned) return;
    let data;
    try { data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}'); } catch { return; }
    if (data.track !== tr.slug || !data.id || data.id === it.id) return;
    await reorderIters(tr.slug, data.id, it.id);
  });

  row.addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'activate') activateIter(tr.slug, it.id);
    else if (act === 'edit') openIterForm(tr.slug, it.id);
    else if (act === 'archive') archiveIter(tr.slug, it.id);
    else if (act === 'delete') deleteIter(tr.slug, it.id);
    else if (act === 'board') {
      STATE.boardTrack = tr.slug;
      setTab('iteration');
      refresh();
    }
  });

  return row;
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
window.bindFormModal = bindFormModal;
window.openTrackForm = openTrackForm;
window.openIterForm = openIterForm;
window.closeFormModal = closeFormModal;
