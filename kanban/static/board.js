// Workflow — board renderer (viewer + manual reordering only).
// Agents drive task status via /iterate; the kanban is now read-mostly:
// the user can drag a card between Todo and Done if they really need to,
// edit task metadata via the modal, and finalize the iteration to write
// CHECKLIST.md. No dispatch / queue / verify flow lives here anymore.

function fmtTokShort(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function depsAllReady(t) {
  const ds = depStatus(t.deps || []);
  return ds.unmet.length === 0;
}

function renderCard(t, opts = {}) {
  const card = document.createElement('div');
  card.className = 'card';
  card.draggable = true;
  card.tabIndex = 0;
  card.dataset.id = t.id;
  card.dataset.agent = t.assignee || 'user';
  card.style.setProperty('--card-stripe', window.agentColor(t.assignee || 'user'));

  const trackBadge = opts.showTrackBadge && t.track
    ? `<span class="card-id-track">${escapeHtml(t.track)}/${escapeHtml(String(t.iteration || ''))}</span>`
    : '';

  const depChips = (t.deps || []).map(id => {
    const ok = depStatusOf(id) === 'done';
    return `<span class="chip ${ok ? 'chip-dep-ready' : 'chip-dep-wait'}">${ok ? '✓' : '·'} ${escapeHtml(id)}</span>`;
  }).join('');
  const estChip = t.estimate ? `<span class="chip chip-est">${escapeHtml(t.estimate)}</span>` : '';
  const stats = t._stats || null;
  const tokTotal = stats ? (stats.input || 0) + (stats.output || 0) : 0;
  const tokChip = tokTotal
    ? `<span class="chip tok-badge" title="input ${stats.input} · output ${stats.output} · cache hit ${stats.cache_read}">${fmtTokShort(tokTotal)}</span>`
    : '';
  const metaInner = depChips + estChip + tokChip;

  const atts = t._attachments || [];
  const thumbsHtml = atts.length
    ? `<div class="card-attachments">${atts.slice(0, 3).map(a => a && a.url
        ? `<div class="card-thumb" style="background-image:url('${escapeHtml(a.url)}');background-size:cover;background-position:center"></div>`
        : `<div class="card-thumb"></div>`).join('')}</div>`
    : '';

  const subs = t._subtasks || [];
  const subDone = subs.filter(s => s.checked).length;
  const subHtml = (subs.length && t.status !== 'done')
    ? `<div class="subprog"><div class="subbar"><i style="width:${Math.round(subDone*100/subs.length)}%"></i></div><span class="subtxt">${subDone}/${subs.length}</span></div>`
    : '';

  card.innerHTML = `
    <div class="accent-strip"></div>
    <div class="card-header">
      ${trackBadge}
      <span class="card-id">${escapeHtml(t.id)}</span>
      <span class="card-status-dot"><span class="dot s-${escapeHtml(t.status || 'todo')}"></span></span>
    </div>
    <div class="card-title">${escapeHtml(t.title || '')}</div>
    ${subHtml}
    ${metaInner ? `<div class="card-meta">${metaInner}</div>` : ''}
    ${thumbsHtml}
  `;

  card.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', t.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  card.addEventListener('click', () => openModal(t.id));

  return card;
}

function buildKanbanInto(container, tasks, opts = {}) {
  container.innerHTML = '';
  container.className = 'board';
  const byCol = Object.fromEntries(COLUMNS.map(c => [c.key, []]));
  for (const t of tasks) byCol[colForTask(t)].push(t);

  for (const col of COLUMNS) {
    const node = document.createElement('div');
    node.className = 'column';
    node.dataset.col = col.key;

    const list = byCol[col.key];
    const empty = list.length === 0
      ? `<div class="column-empty">${col.key === 'todo' ? 'no tasks' : col.key === 'in-progress' ? 'nothing in progress' : 'no completed tasks'}</div>`
      : '';

    node.innerHTML = `
      <div class="column-head">
        <span class="column-name">${col.label}</span>
        <span class="column-count">${list.length}</span>
        <span class="column-kbd">${col.kbd}</span>
      </div>
      <div class="column-body" data-col="${col.key}">${empty}</div>
    `;
    const body = node.querySelector('.column-body');
    body.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      node.classList.add('drop-valid');
    });
    body.addEventListener('dragleave', () => node.classList.remove('drop-valid'));
    body.addEventListener('drop', async e => {
      e.preventDefault();
      node.classList.remove('drop-valid');
      const id = e.dataTransfer.getData('text/plain');
      if (!id) return;
      const t = STATE.taskIndex[id];
      if (!t) {
        showDragReason(`${id}: unknown — refresh`, e.clientX, e.clientY);
        return;
      }
      const newStatus = statusForCol(col.key);
      const onMove = opts.onMove || moveTask;
      await onMove(id, newStatus);
    });
    if (list.length) {
      for (const t of list) body.appendChild(renderCard(t, opts));
    }
    container.appendChild(node);
  }
}

let DRAG_REASON_TIMER = null;
function showDragReason(text, x, y) {
  let el = document.getElementById('drag-reason');
  if (!el) {
    el = document.createElement('div');
    el.id = 'drag-reason';
    el.className = 'drag-reason';
    document.body.appendChild(el);
  }
  el.style.left = (x + 14) + 'px';
  el.style.top  = (y + 14) + 'px';
  el.textContent = '✗ ' + text;
  clearTimeout(DRAG_REASON_TIMER);
  DRAG_REASON_TIMER = setTimeout(() => { el.remove(); }, 1400);
}

async function moveTask(id, newStatus) {
  const t = STATE.taskIndex[id];
  if (!t) return;
  const prevStatus = t.status;
  if (prevStatus === newStatus) return;
  try {
    await api(`/api/task/${id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
    toast(`${id} → ${newStatus}`, 'success', {
      undo: true,
      onUndo: async () => {
        try {
          await api(`/api/task/${id}`, { method: 'PATCH', body: JSON.stringify({ status: prevStatus }) });
          toast(`${id} reverted → ${prevStatus}`, 'success');
          await refresh();
        } catch (e) { toast(`undo failed: ${e.message}`, 'error'); }
      },
    });
    await refresh();
  } catch (e) {
    toast(`${id}: ${e.message}`, 'error');
    await refresh();
  }
}

function buildBoardHeader(iter) {
  if (!iter) return null;
  const wrap = document.createElement('div');
  wrap.className = 'board-header';
  const title = iter.fm?.title || iter.slug || iter.id;
  const track = STATE.boardTrack || iter.track || '';
  const tasks = STATE.board.tasks || [];
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const pct = total ? Math.round(done * 100 / total) : 0;

  let critTotal = 0, critDone = 0;
  const body = iter.readme || '';
  const m = /##\s+Exit criteria\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(body);
  if (m) {
    const lines = m[1].split('\n').filter(l => /^\s*-\s*\[[ xX]\]/.test(l));
    critTotal = lines.length;
    critDone = lines.filter(l => /\[[xX]\]/.test(l)).length;
  }

  const trackPart = track ? `<span class="board-title">${escapeHtml(track)}</span><span class="muted mono t-12">/</span>` : '';
  const isActive = iter.status === 'active';
  const finalizeBtn = isActive
    ? `<button class="btn btn-sm" id="board-finalize-iter" title="Review the iteration's verification checklist">✓ Finalize</button>`
    : '';
  wrap.innerHTML = `
    <div class="board-title-row">
      <span class="board-iter-glyph" style="color:var(--iter-active)">●</span>
      ${trackPart}
      <span class="board-title" style="color:var(--fg-1)">${escapeHtml(iter.id || '')} ${escapeHtml(iter.slug || '')}</span>
      <span class="board-iter-meta">— ${escapeHtml(title)}</span>
      <span class="board-iter-actions">${finalizeBtn}</span>
    </div>
    <div class="board-progress">
      <span class="label">Tasks</span>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span>${done} / ${total} done${critTotal ? ` · exit ${critDone}/${critTotal}` : ''}</span>
    </div>
  `;
  if (isActive) {
    const finalizeEl = wrap.querySelector('#board-finalize-iter');
    if (finalizeEl) finalizeEl.addEventListener('click', () => openFinalizeModal(track, iter.id));
  }
  return wrap;
}

function buildAggregateHeader(actives) {
  const wrap = document.createElement('div');
  wrap.className = 'board-header';
  const tasks = STATE.board.tasks || [];
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const pct = total ? Math.round(done * 100 / total) : 0;
  wrap.innerHTML = `
    <div class="board-title-row">
      <span class="board-iter-glyph" style="color:var(--iter-active)">●</span>
      <span class="board-title">All active iterations</span>
      <span class="board-iter-meta muted">— ${actives.length} ${actives.length === 1 ? 'track' : 'tracks'} · cards show track/iter prefix</span>
    </div>
    <div class="board-progress">
      <span class="label">Progress</span>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span>${done} / ${total} done</span>
    </div>
  `;
  return wrap;
}

function renderBoard() {
  const view = document.getElementById('view-iteration');
  view.innerHTML = '';
  const iter = STATE.board.iteration;
  const actives = STATE.board.actives || [];

  if (!iter && !actives.length) {
    view.innerHTML = `
      <div class="init">
        <div class="init-card">
          <h2>No active iteration</h2>
          <p class="lede">Create a track and iteration to start tracking work.</p>
          <div class="init-cmd"><span class="pr">$</span><span>workflow</span> · run <span class="mono">/new-track</span> in Claude</div>
        </div>
      </div>
    `;
    return;
  }

  if (iter) view.appendChild(buildBoardHeader(iter));
  else view.appendChild(buildAggregateHeader(actives));

  const all = STATE.board.tasks || [];
  const filtered = all.filter(t => matchSearch(t.id, t.title, t.assignee, t.track, (t.deps || []).join(' ')));

  const board = document.createElement('div');
  buildKanbanInto(board, filtered, { showTrackBadge: !STATE.boardTrack });
  view.appendChild(board);

  if (STATE.search && filtered.length === 0) {
    const note = document.createElement('div');
    note.className = 'empty';
    note.style.padding = '40px';
    note.innerHTML = `no matches for <b>${escapeHtml(STATE.search)}</b>`;
    view.appendChild(note);
  }
}

window.renderCard = renderCard;
window.buildKanbanInto = buildKanbanInto;
window.moveTask = moveTask;
window.renderBoard = renderBoard;
window.depsAllReady = depsAllReady;
