function renderAgents() {
  const view = document.getElementById('view-agents');
  view.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'agents-view';

  const agents = STATE.board.agents || [];
  if (!agents.length) {
    view.innerHTML = `<div class="empty">no agents registered in <b>.claude/agents/</b></div>`;
    return;
  }

  const tasks = allTasks();
  const queuedIds = new Set((STATE.queue.items || []).map(q => q.task_id));

  for (const name of agents) {
    const mine = tasks.filter(t => t.assignee === name);
    const inProgress = mine.filter(t => t.status === 'in-progress');
    const review = mine.filter(t => t.status === 'review');
    const todos = mine.filter(t => t.status === 'todo');
    const queuedTodos = todos.filter(t => queuedIds.has(t.id));
    const blocked = mine.filter(t => t.status === 'blocked');
    const done = mine.filter(t => t.status === 'done');

    let state, klass, current;
    if (inProgress.length) { state = 'running'; klass = 'busy'; current = inProgress[0]; }
    else if (review.length) { state = 'review'; klass = 'review'; current = review[0]; }
    else if (queuedTodos.length) { state = 'queued'; klass = 'busy'; current = queuedTodos[0]; }
    else { state = 'idle'; klass = 'idle'; current = null; }

    const card = document.createElement('div');
    card.className = 'agent-card ' + klass;
    const currHtml = current
      ? `<div class="a-current" data-tid="${current.id}">
           <div><span class="tid">${escapeHtml(current.id)}</span>${escapeHtml(current.title || '')}</div>
           <div class="src">${escapeHtml(current._source || '')} · ${escapeHtml(current.status)}</div>
         </div>`
      : `<div class="a-current empty">no active task</div>`;

    const aColor = agentColor(name);
    card.style.setProperty('--agent', aColor);
    card.innerHTML = `
      <div class="a-h">
        <span class="a-avatar" style="color:${aColor};background:${agentColorSoft(name, 0.12)};border-color:${agentColorSoft(name, 0.4)}">${agentIcon(name, 13, 1.4)}</span>
        <span class="a-name">${escapeHtml(name)}</span>
        <span class="a-state">${state}</span>
      </div>
      ${currHtml}
      <div class="a-counters">
        <span>todo<b>${todos.length}</b></span>
        <span>queued<b>${queuedTodos.length}</b></span>
        <span>review<b>${review.length}</b></span>
        <span>blocked<b>${blocked.length}</b></span>
        <span>done<b>${done.length}</b></span>
      </div>
    `;

    const cur = card.querySelector('.a-current[data-tid]');
    if (cur) cur.addEventListener('click', () => openModal(cur.dataset.tid));
    wrap.appendChild(card);
  }

  view.appendChild(wrap);
}

window.renderAgents = renderAgents;
