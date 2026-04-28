// Tracks tab: list of tracks; each one expands into a vertical iteration
// timeline with full CRUD (create/edit/activate/archive/reorder).

const ITER_STATUS_GLYPH = {
  planned:   '◯',
  active:    '●',
  done:      '✓',
  abandoned: '×',
};

let TRACKS_EXPANDED = new Set();

function renderTracks() {
  const view = document.getElementById('view-tracks');
  view.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'tracks-view';

  // Top bar with "+ New track"
  const bar = document.createElement('div');
  bar.className = 'tracks-bar';
  bar.innerHTML = `
    <h2 class="tracks-title">Tracks</h2>
    <button class="primary-btn" id="new-track-btn">+ New track</button>
  `;
  bar.querySelector('#new-track-btn').addEventListener('click', () => openTrackForm(null));
  wrap.appendChild(bar);

  const tracks = STATE.tracks.tracks || [];
  if (!tracks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `no tracks. click <b>+ New track</b> or run <b>/new-track</b>.`;
    wrap.appendChild(empty);
    view.appendChild(wrap);
    return;
  }

  for (const tr of tracks) wrap.appendChild(renderTrackSection(tr));
  view.appendChild(wrap);
}

function renderTrackSection(tr) {
  const sec = document.createElement('div');
  sec.className = 'track-section';
  const expanded = TRACKS_EXPANDED.has(tr.slug);
  const counts = countIters(tr.iterations || []);
  const goal = extractGoalPreview(tr.body || '');

  sec.innerHTML = `
    <div class="track-h">
      <button class="track-toggle" data-act="toggle">${expanded ? '▾' : '▸'}</button>
      <span class="slug">${escapeHtml(tr.slug)}</span>
      ${tr.fm?.title ? `<span class="track-title">${escapeHtml(tr.fm.title)}</span>` : ''}
      <span class="track-counts">
        <span class="ct ct-planned">◯ ${counts.planned}</span>
        <span class="ct ct-active">● ${counts.active}</span>
        <span class="ct ct-done">✓ ${counts.done}</span>
      </span>
      <span class="track-goal">${escapeHtml(goal)}</span>
      <span class="track-h-actions">
        <button data-act="board" title="show in kanban">⊞</button>
        <button data-act="new-iter" title="new iteration">+ iter</button>
        <button data-act="edit" title="edit track">✎</button>
        <button data-act="archive" title="archive track">⌫</button>
      </span>
    </div>
    <div class="track-timeline ${expanded ? 'open' : ''}"></div>
  `;
  const tl = sec.querySelector('.track-timeline');
  if (expanded) renderTimeline(tl, tr);

  sec.addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'toggle') {
      if (TRACKS_EXPANDED.has(tr.slug)) TRACKS_EXPANDED.delete(tr.slug);
      else TRACKS_EXPANDED.add(tr.slug);
      renderTracks();
    } else if (act === 'new-iter') {
      openIterForm(tr.slug, null);
    } else if (act === 'edit') {
      openTrackForm(tr.slug);
    } else if (act === 'archive') {
      archiveTrack(tr.slug);
    } else if (act === 'board') {
      STATE.boardTrack = tr.slug;
      const sel = document.getElementById('board-track');
      if (sel) sel.value = tr.slug;
      setTab('iteration');
      refresh();
    }
  });

  return sec;
}

function renderTimeline(container, tr) {
  container.innerHTML = '';
  const iters = tr.iterations || [];
  if (!iters.length) {
    container.innerHTML = `<div class="empty-iter">no iterations yet. click <b>+ iter</b>.</div>`;
    return;
  }

  // Drag-drop reorder for planned iterations.
  for (const it of iters) {
    const row = document.createElement('div');
    row.className = `iter-row iter-${it.status}`;
    row.draggable = it.status === 'planned';
    row.dataset.id = it.id;
    const isActive = tr.active === it.id;
    row.innerHTML = `
      <span class="iter-glyph" title="${it.status}">${ITER_STATUS_GLYPH[it.status] || '·'}</span>
      <span class="iter-id">${escapeHtml(it.id)}</span>
      <span class="iter-slug">${escapeHtml(it.slug)}</span>
      ${it.title ? `<span class="iter-title">${escapeHtml(it.title)}</span>` : ''}
      <span class="iter-meta">
        <span>${it.task_count} ${it.task_count === 1 ? 'task' : 'tasks'}</span>
        ${isActive ? `<span class="iter-active-tag">ACTIVE</span>` : ''}
      </span>
      <span class="iter-actions">
        ${it.status !== 'active' && it.status !== 'done' ? `<button data-iact="activate" data-iid="${it.id}" title="activate">▶</button>` : ''}
        ${isActive ? `<button data-iact="board" data-iid="${it.id}" title="open in kanban">⊞</button>` : ''}
        <button data-iact="edit" data-iid="${it.id}" title="edit">✎</button>
        ${it.status === 'planned' ? `<button data-iact="delete" data-iid="${it.id}" title="delete">×</button>` : ''}
        ${it.status !== 'done' && it.status !== 'abandoned' ? `<button data-iact="archive" data-iid="${it.id}" title="close (done)">⌫</button>` : ''}
      </span>
    `;

    row.addEventListener('dragstart', e => {
      if (it.status !== 'planned') { e.preventDefault(); return; }
      e.dataTransfer.setData('text/plain', it.id);
      row.classList.add('drag');
    });
    row.addEventListener('dragend', () => row.classList.remove('drag'));
    row.addEventListener('dragover', e => {
      if (it.status !== 'planned') return;
      e.preventDefault();
      row.classList.add('drop');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', async e => {
      e.preventDefault();
      row.classList.remove('drop');
      const fromId = e.dataTransfer.getData('text/plain');
      if (!fromId || fromId === it.id) return;
      await reorderIters(tr.slug, fromId, it.id);
    });

    row.addEventListener('click', e => {
      const b = e.target.closest('button[data-iact]');
      if (!b) return;
      e.stopPropagation();
      const iid = b.dataset.iid;
      const act = b.dataset.iact;
      if (act === 'activate') activateIter(tr.slug, iid);
      else if (act === 'edit') openIterForm(tr.slug, iid);
      else if (act === 'archive') archiveIter(tr.slug, iid);
      else if (act === 'delete') deleteIter(tr.slug, iid);
      else if (act === 'board') {
        STATE.boardTrack = tr.slug;
        const sel = document.getElementById('board-track');
        if (sel) sel.value = tr.slug;
        setTab('iteration');
        refresh();
      }
    });
    container.appendChild(row);
  }
}

function countIters(iters) {
  const c = { planned: 0, active: 0, done: 0, abandoned: 0 };
  for (const it of iters) c[it.status] = (c[it.status] || 0) + 1;
  return c;
}

function extractGoalPreview(body) {
  if (!body) return '';
  const startRe = /^##\s+Цель\s*$/m;
  const m = startRe.exec(body);
  if (!m) return '';
  const start = m.index + m[0].length;
  const tail = body.slice(start);
  const nxt = /^##\s+/m.exec(tail);
  const end = nxt ? start + nxt.index : body.length;
  return body.slice(start, end).trim().replace(/\s+/g, ' ').slice(0, 120);
}

// ---------- Track form ----------

async function openTrackForm(slug) {
  let t = null;
  if (slug) {
    try {
      const r = await api(`/api/track/${encodeURIComponent(slug)}`);
      t = r.track;
    } catch (e) {
      toast(`load failed: ${e.message}`, 'error');
      return;
    }
  }
  const isNew = !t;
  const html = `
    <div class="form-row"><label>Slug</label><input id="tf-slug" ${isNew ? '' : 'readonly'} value="${escapeHtml(t?.slug || '')}" placeholder="kebab-case"></div>
    <div class="form-row"><label>Title</label><input id="tf-title" value="${escapeHtml(t?.fm?.title || '')}" placeholder="human title"></div>
    ${!isNew ? `<div class="form-row"><label>Status</label><select id="tf-status"><option value="active" ${t.fm?.status !== 'archived' ? 'selected' : ''}>active</option><option value="archived" ${t.fm?.status === 'archived' ? 'selected' : ''}>archived</option></select></div>` : ''}
    <div class="form-row form-row-top"><label>Body (markdown)</label><textarea id="tf-body" rows="14" placeholder="## Цель\n...\n\n## Scope\n- ...\n\n## Заметки">${escapeHtml(t?.body || '')}</textarea></div>
  `;
  openFormModal(isNew ? 'New track' : `Edit track · ${t.slug}`, html, async () => {
    const slug2 = (document.getElementById('tf-slug').value || '').trim().toLowerCase();
    const title = document.getElementById('tf-title').value || '';
    const body = document.getElementById('tf-body').value || '';
    const status = document.getElementById('tf-status')?.value;
    if (isNew) {
      await api('/api/tracks', { method: 'POST', body: JSON.stringify({ slug: slug2, title, body }) });
      toast(`track ${slug2} created`);
    } else {
      const patch = { title, body };
      if (status) patch.status = status;
      await api(`/api/track/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      toast(`track ${slug} saved`);
    }
    closeFormModal();
    await refresh();
  });
}

async function archiveTrack(slug) {
  if (!confirm(`Archive track "${slug}"? It moves to .workflow/archive/tracks/.`)) return;
  try {
    const r = await api(`/api/track/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    toast(`archived → ${r.archived_to}`);
    await refresh();
  } catch (e) { toast(`archive failed: ${e.message}`, 'error'); }
}

// ---------- Iteration form ----------

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
    <div class="form-row"><label>Track</label><input value="${escapeHtml(trackSlug)}" readonly></div>
    <div class="form-row"><label>Slug</label><input id="if-slug" value="${escapeHtml(it?.slug || '')}" placeholder="kebab-case (e.g. tooltips-mvp)"></div>
    <div class="form-row"><label>Title</label><input id="if-title" value="${escapeHtml(it?.fm?.title || it?.title || '')}" placeholder="human title"></div>
    <div class="form-row"><label>Status</label>
      <select id="if-status">
        <option value="planned"   ${(!it || it.status === 'planned') ? 'selected' : ''}>planned</option>
        <option value="active"    ${it?.status === 'active' ? 'selected' : ''}>active</option>
        <option value="done"      ${it?.status === 'done' ? 'selected' : ''}>done</option>
        <option value="abandoned" ${it?.status === 'abandoned' ? 'selected' : ''}>abandoned</option>
      </select>
    </div>
    <div class="form-row form-row-top"><label>README markdown</label><textarea id="if-body" rows="18">${escapeHtml(it?.body || defaultBody)}</textarea></div>
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
      toast(`iter ${slug2} created`);
    } else {
      const patch = { title, status, body };
      if (slug2 !== it.slug) patch.slug = slug2;
      await api(`/api/track/${encodeURIComponent(trackSlug)}/iteration/${encodeURIComponent(iterId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      toast(`iter ${iterId} saved`);
    }
    closeFormModal();
    await refresh();
  });
}

async function activateIter(track, id) {
  try {
    await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}/activate`, { method: 'POST' });
    toast(`iter ${id} activated in ${track}`);
    await refresh();
  } catch (e) { toast(`activate failed: ${e.message}`, 'error'); }
}

async function archiveIter(track, id) {
  if (!confirm(`Close iter ${id} as done?`)) return;
  try {
    await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}/archive`, {
      method: 'POST', body: JSON.stringify({ status: 'done' }),
    });
    toast(`iter ${id} closed`);
    await refresh();
  } catch (e) { toast(`archive failed: ${e.message}`, 'error'); }
}

async function deleteIter(track, id) {
  if (!confirm(`Delete planned iter ${id}? (only allowed for empty planned iterations)`)) return;
  try {
    await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast(`iter ${id} deleted`);
    await refresh();
  } catch (e) { toast(`delete failed: ${e.message}`, 'error'); }
}

async function reorderIters(track, fromId, toId) {
  // Move fromId to toId's position. Build new order from current list.
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
    toast('reordered');
    await refresh();
  } catch (e) { toast(`reorder failed: ${e.message}`, 'error'); }
}

// ---------- Generic form modal ----------

let FORM_SUBMIT = null;

function openFormModal(title, innerHtml, onSubmit) {
  FORM_SUBMIT = onSubmit;
  document.getElementById('form-title').textContent = title;
  document.getElementById('form-body').innerHTML = innerHtml;
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
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('form-bg').classList.contains('open')) closeFormModal();
  });
}

window.renderTracks = renderTracks;
window.bindFormModal = bindFormModal;
window.openTrackForm = openTrackForm;
window.openIterForm = openIterForm;
window.closeFormModal = closeFormModal;
