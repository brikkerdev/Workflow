// Renders 5-column kanban board + drag/drop, card actions.

function renderCard(t) {
  const dep = depStatus(t.deps);
  const blocked = t.status === 'blocked';
  const card = document.createElement('div');
  card.className = 'card' + (blocked ? ' blocked' : '');
  card.draggable = true;
  card.dataset.id = t.id;

  const isUser = t.assignee === 'user';
  const canDispatch = t.status === 'todo' && !isUser && dep.unmet.length === 0;
  const aColor = agentColor(t.assignee);
  card.style.setProperty('--agent', aColor);
  card.style.setProperty('--agent-soft', agentColorSoft(t.assignee, 0.14));

  const depsHtml = (t.deps && t.deps.length)
    ? `<span class="it ${dep.unmet.length ? 'unmet' : ''}" title="${escapeHtml(t.deps.join(', '))}">${Icons.link(10, 1.3)}${escapeHtml(t.deps.join(', '))}</span>`
    : '';
  const estHtml = t.estimate
    ? `<span class="it">${Icons.clock(10, 1.3)}${escapeHtml(t.estimate)}</span>`
    : '';

  const showStart = t.status === 'todo' && !isUser;

  card.innerHTML = `
    <div class="head">
      <span class="id">${escapeHtml(t.id)}</span>
      <span class="dot" data-s="${escapeHtml(t.status || 'todo')}"></span>
    </div>
    <div class="title">${escapeHtml(t.title || '')}</div>
    <div class="foot">
      <span class="agent ${isUser ? 'user' : ''}" style="color:${aColor}">${agentIcon(t.assignee || '', 11, 1.4)}${escapeHtml(t.assignee || '—')}</span>
      <span class="meta">${depsHtml}${estHtml}</span>
    </div>
    <div class="actions">
      ${showStart ? `<button class="start" ${canDispatch ? '' : 'disabled'} data-act="start">▶ Start</button>` : ''}
      <button class="open" data-act="open">Open</button>
    </div>
  `;

  card.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', t.id);
    card.dataset.drag = '1';
  });
  card.addEventListener('dragend', () => { delete card.dataset.drag; });

  card.addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      e.stopPropagation();
      if (btn.dataset.act === 'open') openModal(t.id);
      else if (btn.dataset.act === 'start' && !btn.disabled) dispatchTask(t.id);
      return;
    }
    openModal(t.id);
  });

  return card;
}

function buildKanbanInto(container, tasks, opts = {}) {
  container.innerHTML = '';
  container.className = 'board';
  const byStatus = Object.fromEntries(COLS.map(s => [s, []]));
  for (const t of tasks) (byStatus[t.status] || byStatus.todo).push(t);

  for (const status of COLS) {
    const col = document.createElement('div');
    col.className = 'col';
    col.dataset.status = status;
    col.innerHTML = `
      <div class="col-h">
        <div class="col-h-left">
          <span class="title">${COL_TITLE[status]}</span>
          <span class="count">${byStatus[status].length}</span>
        </div>
        <button class="add" title="add task" tabindex="-1">${Icons.plus(10, 1.5)}</button>
      </div>
      <div class="col-body" data-status="${status}"></div>
    `;
    const body = col.querySelector('.col-body');
    body.addEventListener('dragover', e => { e.preventDefault(); body.classList.add('drop'); });
    body.addEventListener('dragleave', () => body.classList.remove('drop'));
    body.addEventListener('drop', async e => {
      e.preventDefault();
      body.classList.remove('drop');
      const id = e.dataTransfer.getData('text/plain');
      if (!id) return;
      const onMove = opts.onMove || moveTask;
      await onMove(id, status);
    });
    for (const t of byStatus[status]) body.appendChild(renderCard(t));
    container.appendChild(col);
  }
}

async function moveTask(id, newStatus) {
  const t = STATE.taskIndex[id];
  if (!t || t.status === newStatus) return;
  try {
    await api(`/api/task/${id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
    toast(`${id} → ${newStatus}`);
    await refresh();
  } catch (e) {
    toast(`${id}: ${e.message}`, 'error');
    await refresh();
  }
}

async function dispatchTask(id) {
  try {
    const r = await api(`/api/task/${id}/dispatch`, { method: 'POST' });
    toast(`${id} queued · run /queue (queue: ${r.queue_size})`);
    await refresh();
  } catch (e) {
    toast(`${id}: ${e.message}`, 'error');
  }
}

function renderBoard() {
  const view = document.getElementById('view-iteration');
  view.innerHTML = '';
  if (!STATE.board.iteration) {
    view.innerHTML = `<div class="empty">no active iteration. run <b>/new-iter</b> in Claude.</div>`;
    return;
  }
  const board = document.createElement('div');
  buildKanbanInto(board, STATE.board.tasks || []);
  view.appendChild(board);
}

window.renderCard = renderCard;
window.buildKanbanInto = buildKanbanInto;
window.moveTask = moveTask;
window.dispatchTask = dispatchTask;
window.renderBoard = renderBoard;
