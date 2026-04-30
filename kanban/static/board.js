// Workflow — board renderer (design markup: column / card / accent-strip / chips).

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
  const running = t.status === 'in-progress' || t.status === 'queued';
  card.className = 'card' + (running ? ' is-running' : '');
  card.draggable = true;
  card.tabIndex = 0;
  card.dataset.id = t.id;
  card.dataset.agent = t.assignee || 'user';

  const isUser = t.assignee === 'user';
  const ready = depsAllReady(t);
  const canStart = t.status === 'todo' && !isUser && ready;
  const queuedIds = new Set(((STATE.queue && STATE.queue.items) || []).map(q => q.task_id));
  const isQueued = queuedIds.has(t.id) || t.status === 'queued';
  const showStart = t.status === 'todo' && !isQueued;
  const showStop = !isUser && (isQueued || t.status === 'in-progress');
  const showVerify = t.status === 'verifying';

  // header
  const trackBadge = opts.showTrackBadge && t.track
    ? `<span class="card-id-track">${escapeHtml(t.track)}/${escapeHtml(String(t.iteration || ''))}</span>`
    : '';

  // meta chips
  const depChips = (t.deps || []).map(id => {
    const dt = STATE.taskIndex[id];
    const ok = dt && dt.status === 'done';
    return `<span class="chip ${ok ? 'chip-dep-ready' : 'chip-dep-wait'}">${ok ? '✓' : '·'} ${escapeHtml(id)}</span>`;
  }).join('');
  const estChip = t.estimate ? `<span class="chip chip-est">${escapeHtml(t.estimate)}</span>` : '';
  const attempts = Number(t.attempts || 0);
  const attemptsChip = attempts > 0
    ? `<span class="chip chip-dep-wait" title="rework attempts" style="color:var(--dot-blocked);border-color:rgba(239,68,68,0.30)">×${attempts}</span>`
    : '';
  const stats = t._stats || null;
  const tokTotal = stats ? (stats.input || 0) + (stats.output || 0) : 0;
  const tokChip = tokTotal
    ? `<span class="chip tok-badge" title="input ${stats.input} · output ${stats.output} · cache hit ${stats.cache_read}">${fmtTokShort(tokTotal)}</span>`
    : '';
  // Currently-working instance pin: reverse map current_task_id -> instance.
  const workingInst = (STATE.instances || []).find(i => i.current_task_id === t.id && i.status !== 'dead');
  const instChip = workingInst
    ? `<span class="chip chip-instance" title="${escapeHtml(workingInst.id)} (${escapeHtml(workingInst.status)})" style="background:${agentColor(workingInst.agent)}22;border-color:${agentColor(workingInst.agent)}66">⚙ ${escapeHtml(workingInst.name || workingInst.id)}</span>`
    : '';
  const metaInner = depChips + estChip + attemptsChip + tokChip + instChip;

  // attachments thumbs (up to 3)
  const atts = t._attachments || [];
  const thumbsHtml = atts.length
    ? `<div class="card-attachments">${atts.slice(0, 3).map(a => a && a.url
        ? `<div class="card-thumb" style="background-image:url('${escapeHtml(a.url)}');background-size:cover;background-position:center"></div>`
        : `<div class="card-thumb"></div>`).join('')}</div>`
    : '';

  // subtask progress — show for active work, hide for terminal `done`
  const subs = t._subtasks || [];
  const subDone = subs.filter(s => s.checked).length;
  const subHtml = (subs.length && t.status !== 'done')
    ? `<div class="subprog"><div class="subbar"><i style="width:${Math.round(subDone*100/subs.length)}%"></i></div><span class="subtxt">${subDone}/${subs.length}</span></div>`
    : '';

  // actions row
  const actionBtns = [];
  if (showStart) actionBtns.push(`<button class="card-start" ${ready ? '' : 'disabled'} data-act="start">▶ Start</button>`);
  if (showVerify) actionBtns.push(`<button class="card-verify" data-act="verify">✓ Verify</button>`);
  if (showStop) actionBtns.push(`<button class="card-stop" data-act="stop" title="${isQueued ? 'cancel queued dispatch' : 'reset to todo'}">${isQueued ? '■ Stop' : '↺ Reset'}</button>`);
  const actionsHtml = actionBtns.length ? `<div class="card-actions">${actionBtns.join('')}</div>` : '';

  card.innerHTML = `
    <div class="accent-strip"></div>
    <div class="card-header">
      ${trackBadge}
      <span class="card-id">${escapeHtml(t.id)}</span>
      <span class="card-status-dot"><span class="dot s-${escapeHtml(t.status || 'todo')}${t.status === 'in-progress' ? ' pulse' : ''}"></span></span>
    </div>
    <div class="card-title">${escapeHtml(t.title || '')}</div>
    ${subHtml}
    ${metaInner ? `<div class="card-meta">${metaInner}</div>` : ''}
    ${thumbsHtml}
    ${actionsHtml}
  `;

  card.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', t.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  card.addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      e.stopPropagation();
      if (btn.dataset.act === 'start' && !btn.disabled) dispatchTask(t.id);
      else if (btn.dataset.act === 'stop') stopTask(t.id);
      else if (btn.dataset.act === 'verify') openModal(t.id, { verify: true });
      return;
    }
    openModal(t.id);
  });

  return card;
}

function buildKanbanInto(container, tasks, opts = {}) {
  container.innerHTML = '';
  container.className = 'board';
  const byCol = Object.fromEntries(COLUMNS.map(c => [c.key, []]));
  for (const t of tasks) byCol[colForStatus(t.status)].push(t);

  for (const col of COLUMNS) {
    const node = document.createElement('div');
    node.className = 'column';
    node.dataset.col = col.key;

    const list = byCol[col.key];
    const empty = list.length === 0
      ? `<div class="column-empty">${col.key === 'backlog' ? 'no backlog' : col.key === 'review' ? 'nothing to review' : col.key === 'blocked' ? 'no blockers' : col.key === 'done' ? 'no completed tasks' : 'empty'}</div>`
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
      const newStatus = statusForCol(col.key);
      if (t && !depsAllReady(t) && (col.key === 'in-progress' || col.key === 'review' || col.key === 'done')) {
        showDragReason(`${id}: unmet deps`, e.clientX, e.clientY);
        return;
      }
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
  if (!t || t.status === newStatus) return;
  const prevStatus = t.status;
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

async function dispatchTask(id) {
  const task = STATE.taskIndex[id];
  const currentAssignee = task?.assignee || 'user';
  const agents = STATE.board?.agents || [];

  // If task already has a real agent assigned, dispatch directly.
  if (currentAssignee !== 'user' && agents.includes(currentAssignee)) {
    await _doDispatch(id, null);
    return;
  }

  // Otherwise open agent picker.
  await openAgentPicker(id, currentAssignee);
}

async function openAgentPicker(taskId, currentAssignee) {
  const agents = STATE.board?.agents || [];
  if (!agents.length) { toast('No agents configured', 'error'); return; }

  // Fetch descriptions once
  let details = [];
  try { const r = await api('/api/agents'); details = r.agents || []; } catch {}
  const bySlug = Object.fromEntries(details.map(a => [a.slug, a]));

  let selected = agents.includes(currentAssignee) ? currentAssignee : agents[0];

  const rows = agents.map(name => {
    const det = bySlug[name];
    const desc = det?.description || '';
    const model = det?.fm?.model || 'inherit';
    const color = agentColor(name);
    return `<div class="picker-row${name === selected ? ' picker-selected' : ''}" data-agent="${escapeHtml(name)}" tabindex="0">
      <span class="agent-swatch" style="background:${color};width:10px;height:10px;border-radius:50%;display:inline-block;flex-shrink:0"></span>
      <span class="picker-name">${escapeHtml(name)}</span>
      <span class="picker-model mono" style="font-size:0.75em;opacity:0.6">${escapeHtml(model)}</span>
      <span class="picker-desc" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0.75">${escapeHtml(desc)}</span>
    </div>`;
  }).join('');

  const html = `<div class="agent-picker" style="display:flex;flex-direction:column;gap:4px">${rows}</div>`;

  const task = STATE.taskIndex[taskId];
  openFormModal(`Dispatch ${taskId} · ${task?.title || ''}`, html, async () => {
    await _doDispatch(taskId, selected === currentAssignee ? null : selected);
    closeFormModal();
  }, { size: 'md', confirmText: '▶ Dispatch' });

  // wire up selection after modal renders
  setTimeout(() => {
    document.querySelectorAll('.picker-row').forEach(row => {
      const activate = () => {
        document.querySelectorAll('.picker-row').forEach(r => r.classList.remove('picker-selected'));
        row.classList.add('picker-selected');
        selected = row.dataset.agent;
      };
      row.addEventListener('click', activate);
      row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') activate(); });
    });
  }, 0);
}

async function _doDispatch(id, newAssignee) {
  try {
    if (newAssignee) {
      await api(`/api/task/${id}`, { method: 'PATCH', body: JSON.stringify({ assignee: newAssignee }) });
    }
    const r = await api(`/api/task/${id}/dispatch`, { method: 'POST' });
    toast(`${id} queued · run /queue (queue: ${r.queue_size})`, 'success');
    await refresh();
  } catch (e) { toast(`${id}: ${e.message}`, 'error'); }
}

async function stopTask(id) {
  try {
    const r = await api(`/api/task/${id}/dispatch`, { method: 'DELETE' });
    const bits = [];
    if (r.trigger_removed) bits.push('trigger removed');
    if (r.reverted_to_todo) bits.push('reverted to todo');
    toast(`${id} stopped · ${bits.join(', ')}`, 'success');
    await refresh();
  } catch (e) { toast(`${id}: ${e.message}`, 'error'); }
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
  const inProg = tasks.filter(t => t.status === 'in-progress' || t.status === 'queued').length;
  const pct = total ? Math.round(done * 100 / total) : 0;

  // Exit criteria are a separate signal — user-checked binary items in the
  // iteration README. Show them as a side counter, not the main progress bar
  // (otherwise the bar sits at 0% until the user manually ticks them, even
  // when every task is done).
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
  const startBtn = isActive
    ? `<button class="btn btn-sm" id="board-start-iter" title="Dispatch every todo task in this iteration to its agent">▷ Start iteration</button>`
    : '';
  wrap.innerHTML = `
    <div class="board-title-row">
      <span class="board-iter-glyph" style="color:var(--iter-active)">●</span>
      ${trackPart}
      <span class="board-title" style="color:var(--fg-1)">${escapeHtml(iter.id || '')} ${escapeHtml(iter.slug || '')}</span>
      <span class="board-iter-meta">— ${escapeHtml(title)}</span>
      <span class="board-iter-actions">${startBtn}</span>
    </div>
    <div class="board-progress">
      <span class="label">Tasks</span>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span>${done} / ${total} done${inProg ? ` · ${inProg} active` : ''}${critTotal ? ` · exit ${critDone}/${critTotal}` : ''}</span>
    </div>
  `;
  if (isActive) {
    const btn = wrap.querySelector('#board-start-iter');
    if (btn) btn.addEventListener('click', () => startBoardIteration(track, iter.id));
  }
  return wrap;
}

async function startBoardIteration(track, iterId) {
  if (!track) { toast('no track context — open a specific track to start its iteration', 'error'); return; }
  if (!await confirmModal({
    title: 'Start iteration',
    message: `Dispatch every <b>todo</b> task in iter <b>${escapeHtml(iterId)}</b> to its agent? Agents will start pulling tasks from the queue immediately.`,
    confirmText: 'Dispatch all',
  })) return;
  try {
    const r = await api(`/api/track/${encodeURIComponent(track)}/iteration/${encodeURIComponent(iterId)}/start`, {
      method: 'POST', body: JSON.stringify({}),
    });
    const skipped = (r.skipped || []).length;
    const queued = (r.queued || []).length;
    if (skipped) {
      const reasons = r.skipped.slice(0, 3).map(s => `${s.id}: ${s.reason}`).join('; ');
      toast(`queued ${queued} · skipped ${skipped} (${reasons}${skipped > 3 ? '…' : ''})`, queued ? 'success' : 'error');
    } else {
      toast(`queued ${queued} tasks`, 'success');
    }
    await refresh();
  } catch (e) { toast(`start failed: ${e.message}`, 'error'); }
}

function buildAggregateHeader(actives) {
  const wrap = document.createElement('div');
  wrap.className = 'board-header';
  const tasks = STATE.board.tasks || [];
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const inProg = tasks.filter(t => t.status === 'in-progress' || t.status === 'queued').length;
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
      <span>${done} / ${total} done${inProg ? ` · ${inProg} active` : ''}</span>
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
window.dispatchTask = dispatchTask;
window.stopTask = stopTask;
window.renderBoard = renderBoard;
window.depsAllReady = depsAllReady;
