// Workflow — Agents page (design markup: agent-row grid).

function renderAgents() {
  const view = document.getElementById('view-agents');
  view.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'agents-page';

  const agents = STATE.board.agents || [];
  const header = document.createElement('div');
  header.className = 'tracks-header';
  header.innerHTML = `
    <div>
      <h1>Agents</h1>
      <div class="subtitle mono">${agents.length} configured</div>
    </div>
  `;
  page.appendChild(header);

  if (!agents.length) {
    const empty = document.createElement('div');
    empty.className = 'tracks-empty';
    empty.innerHTML = `<h2>No agents</h2><p>register them in <span class="cmd">.claude/agents/</span></p>`;
    page.appendChild(empty);
    view.appendChild(page);
    return;
  }

  const tasks = allTasks();
  const queuedIds = new Set((STATE.queue.items || []).map(q => q.task_id));

  const list = document.createElement('div');
  list.className = 'agents-list';
  for (const name of agents) {
    const mine = tasks.filter(t => t.assignee === name);
    const inProgress = mine.filter(t => t.status === 'in-progress');
    const review = mine.filter(t => t.status === 'review');
    const todos = mine.filter(t => t.status === 'todo');
    const queuedTodos = todos.filter(t => queuedIds.has(t.id));
    const done = mine.filter(t => t.status === 'done');

    const aColor = agentColor(name);
    const desc = inProgress.length
      ? `working: ${escapeHtml(inProgress[0].id)} ${escapeHtml(inProgress[0].title || '')}`
      : review.length
        ? `awaiting review on ${escapeHtml(review[0].id)}`
        : queuedTodos.length
          ? `${queuedTodos.length} queued`
          : `idle`;
    const tools = [
      todos.length    ? `todo:${todos.length}` : null,
      queuedTodos.length ? `queued:${queuedTodos.length}` : null,
      review.length   ? `review:${review.length}` : null,
      done.length     ? `done:${done.length}` : null,
    ].filter(Boolean);

    const row = document.createElement('div');
    row.className = 'agent-row';
    row.innerHTML = `
      <div class="agent-swatch" style="background:${aColor}"></div>
      <div class="agent-slug">${escapeHtml(name)}</div>
      <div class="agent-desc">${desc}</div>
      <div class="agent-tools">${tools.map(t => `<span class="tool-tag">${escapeHtml(t)}</span>`).join('')}</div>
      <button class="iconbtn" title="Open active task" data-tid="${escapeHtml(inProgress[0]?.id || review[0]?.id || queuedTodos[0]?.id || '')}">✎</button>
    `;
    const btn = row.querySelector('button[data-tid]');
    if (btn && btn.dataset.tid) {
      btn.addEventListener('click', () => openModal(btn.dataset.tid));
    } else if (btn) {
      btn.disabled = true;
      btn.style.opacity = 0.4;
    }
    list.appendChild(row);
  }
  page.appendChild(list);

  view.appendChild(page);
}

window.renderAgents = renderAgents;
