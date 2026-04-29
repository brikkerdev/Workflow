// Workflow — Agents page (card grid). Each card shows the agent + a list of
// its live spawned instances with spawn / kill / respawn controls.

let AGENT_DETAIL_CACHE = null; // /api/agents response

async function fetchAgentDetails() {
  try {
    const r = await api('/api/agents');
    AGENT_DETAIL_CACHE = r.agents || [];
  } catch { AGENT_DETAIL_CACHE = []; }
}

function fmtTokens(n) {
  n = Number(n) || 0;
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function instanceRow(inst) {
  const taskHtml = inst.current_task_id
    ? `<a href="#" class="inst-task" data-task="${escapeHtml(inst.current_task_id)}">${escapeHtml(inst.current_task_id)}</a>`
    : `<span class="muted">idle</span>`;
  return `
    <div class="agent-instance" data-id="${escapeHtml(inst.id)}">
      <span class="dot s-${escapeHtml(inst.status)}" title="${escapeHtml(inst.status)}"></span>
      <span class="inst-id mono">${escapeHtml(inst.id)}</span>
      <span class="inst-task-cell">${taskHtml}</span>
      <span class="inst-tokens muted mono" data-tokens>${fmtTokens(inst.tokens_used)}</span>
      <div class="inst-actions">
        <button class="iconbtn" data-act="respawn" title="Mark for clean respawn">↻</button>
        <button class="iconbtn" data-act="kill" title="Kill instance + re-queue task">✕</button>
      </div>
    </div>
  `;
}

function bindInstanceActions(card, agent) {
  card.querySelectorAll('.inst-task').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      openModal(a.dataset.task);
    });
  });
  card.querySelectorAll('.agent-instance').forEach(row => {
    const id = row.dataset.id;
    row.querySelector('button[data-act="kill"]').addEventListener('click', async () => {
      const inst = (STATE.instances || []).find(x => x.id === id);
      if (!await confirmModal({
        title: 'Kill instance',
        message: `Kill <code>${escapeHtml(id)}</code>?${inst?.current_task_id ? ` Task <b>${escapeHtml(inst.current_task_id)}</b> will be re-queued.` : ''}`,
        confirmText: 'Kill',
        danger: true,
      })) return;
      try {
        await api(`/api/instance/${encodeURIComponent(id)}/kill`, { method: 'POST' });
        toast(`killed ${id}`, 'success');
        await refresh({ force: true });
      } catch (err) { toast(`kill failed: ${err.message}`, 'error'); }
    });
    row.querySelector('button[data-act="respawn"]').addEventListener('click', async () => {
      try {
        await api(`/api/instance/${encodeURIComponent(id)}/respawn`, { method: 'POST' });
        toast(`respawn requested for ${id}`, 'success');
        await refresh({ force: true });
      } catch (err) { toast(`respawn failed: ${err.message}`, 'error'); }
    });
  });
}

function renderAgents() {
  const view = document.getElementById('view-agents');
  view.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'agents-page';

  const allAgents = STATE.board.agents || [];
  const agents = STATE.search ? allAgents.filter(a => matchSearch(a)) : allAgents;

  const liveCount = (STATE.instances || []).filter(i => i.status !== 'dead').length;

  const header = document.createElement('div');
  header.className = 'tracks-header';
  header.innerHTML = `
    <div>
      <h1>Agents</h1>
      <div class="subtitle mono">${allAgents.length} configured · ${liveCount} live instance${liveCount === 1 ? '' : 's'}</div>
    </div>
    <button class="btn btn-primary btn-lg" id="new-agent-btn">+ New agent</button>
  `;
  header.querySelector('#new-agent-btn').addEventListener('click', () => openAgentForm(null));
  page.appendChild(header);

  if (!allAgents.length) {
    const empty = document.createElement('div');
    empty.className = 'tracks-empty';
    empty.innerHTML = `<h2>No agents</h2><p>click <span class="cmd">+ New agent</span> or drop .md files into <span class="cmd">.claude/agents/</span></p>`;
    page.appendChild(empty);
    view.appendChild(page);
    return;
  }

  const tasks = allTasks();
  const queuedIds = new Set((STATE.queue.items || []).map(q => q.task_id));

  fetchAgentDetails().then(() => {
    const detailBySlug = Object.fromEntries((AGENT_DETAIL_CACHE || []).map(a => [a.slug, a]));
    page.querySelectorAll('.agent-card').forEach(card => {
      const slug = card.dataset.slug;
      const det = detailBySlug[slug];
      if (det) {
        const desc = card.querySelector('.agent-desc');
        if (desc && det.description && !desc.dataset.live) desc.textContent = det.description;
      }
    });
  });

  const grid = document.createElement('div');
  grid.className = 'agents-grid';

  for (const name of agents) {
    const mine = tasks.filter(t => t.assignee === name);
    const inProgress = mine.filter(t => t.status === 'in-progress');
    const review = mine.filter(t => t.status === 'review' || t.status === 'verifying');
    const todos = mine.filter(t => t.status === 'todo');
    const queuedTodos = todos.filter(t => queuedIds.has(t.id));
    const done = mine.filter(t => t.status === 'done');

    const aColor = agentColor(name);
    const myInstances = (STATE.instances || []).filter(i => i.agent === name && i.status !== 'dead');

    const liveLine = inProgress.length
      ? `working on ${escapeHtml(inProgress[0].id)}`
      : review.length
        ? `awaiting review on ${escapeHtml(review[0].id)}`
        : queuedTodos.length
          ? `${queuedTodos.length} queued`
          : todos.length
            ? `${todos.length} backlog`
            : `idle`;

    const stat = (label, n) => n
      ? `<span class="agent-stat"><span class="agent-stat-n">${n}</span><span class="agent-stat-l">${label}</span></span>`
      : '';

    const card = document.createElement('div');
    card.className = 'agent-card';
    card.dataset.slug = name;
    card.innerHTML = `
      <div class="agent-card-head">
        <div class="agent-swatch" style="background:${aColor}"></div>
        <div class="agent-name mono">${escapeHtml(name)}</div>
        <div class="agent-card-actions">
          <button class="btn btn-primary" data-act="spawn" title="Open a new terminal running this agent in auto-loop">▶ Spawn</button>
          <button class="iconbtn" data-act="edit" title="Edit agent">✎</button>
        </div>
      </div>
      <div class="agent-desc">${liveLine}</div>
      <div class="agent-stats">
        ${stat('todo', todos.length)}
        ${stat('queued', queuedTodos.length)}
        ${stat('in-progress', inProgress.length)}
        ${stat('review', review.length)}
        ${stat('done', done.length)}
      </div>
      <div class="agent-instances-wrap" ${myInstances.length ? '' : 'hidden'}>
        <div class="agent-instances-head muted">
          ${myInstances.length} live · click ✕ to kill, ↻ to respawn
        </div>
        <div class="agent-instances">${myInstances.map(instanceRow).join('')}</div>
      </div>
    `;
    card.querySelector('button[data-act="edit"]').addEventListener('click', e => {
      e.stopPropagation();
      openAgentForm(name);
    });
    card.querySelector('button[data-act="spawn"]').addEventListener('click', async e => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api('/api/instance/spawn', { method: 'POST', body: JSON.stringify({ agent: name }) });
        toast(`spawned ${name}`, 'success');
        await refresh({ force: true });
      } catch (err) { toast(`spawn failed: ${err.message}`, 'error'); }
      finally { btn.disabled = false; }
    });
    bindInstanceActions(card, name);
    grid.appendChild(card);
  }
  page.appendChild(grid);
  view.appendChild(page);
}

// In-place token updater: called on heartbeat-only refreshes so the card
// doesn't get torn down. Reads STATE.instances which the polling refresh
// already updated.
function patchInstanceTokens() {
  for (const inst of (STATE.instances || [])) {
    const cell = document.querySelector(`.agent-instance[data-id="${CSS.escape(inst.id)}"] [data-tokens]`);
    if (cell) cell.textContent = fmtTokens(inst.tokens_used);
  }
}

// ─── Agent editor (unchanged, but kept here so the file is self-contained) ──

async function openAgentForm(slug) {
  let a = null;
  if (slug) {
    try { a = await api(`/api/agent/${encodeURIComponent(slug)}`); }
    catch (e) { toast(`load failed: ${e.message}`, 'error'); return; }
  }
  const isNew = !a;
  const desc = a?.fm?.description || '';
  const model = a?.fm?.model || 'inherit';
  const tools = a?.fm?.tools || '';
  const body = a?.body || '';

  const html = `
    <div class="form-row"><label>Slug</label><input class="input mono" id="ag-slug" ${isNew ? '' : 'readonly'} value="${escapeHtml(a?.slug || '')}" placeholder="kebab-case"></div>
    <div class="form-row"><label>Description</label><input class="input" id="ag-desc" value="${escapeHtml(desc)}" placeholder="when to invoke this agent"></div>
    <div class="form-row"><label>Model</label>
      <select class="input" id="ag-model">
        <option value="inherit"          ${model === 'inherit' || !model ? 'selected' : ''}>inherit</option>
        <option value="claude-opus-4-7"  ${model === 'claude-opus-4-7' ? 'selected' : ''}>opus-4.7</option>
        <option value="claude-sonnet-4-6" ${model === 'claude-sonnet-4-6' ? 'selected' : ''}>sonnet-4.6</option>
        <option value="claude-haiku-4-5" ${model === 'claude-haiku-4-5' ? 'selected' : ''}>haiku-4.5</option>
      </select>
    </div>
    <div class="form-row"><label>Tools</label><input class="input mono" id="ag-tools" value="${escapeHtml(tools)}" placeholder="Read, Edit, Bash (comma-separated, blank = all)"></div>
    <div class="form-row"><label>Role / Body</label><textarea class="textarea mono" id="ag-body" placeholder="# slug\n\n(role description, conventions, escalation rules)">${escapeHtml(body)}</textarea></div>
    ${!isNew ? `<div class="form-row"><label></label><button class="btn btn-danger" id="ag-delete" type="button">Delete agent</button></div>` : ''}
  `;
  openFormModal(isNew ? 'New agent' : `Edit agent · ${a.slug}`, html, async () => {
    const slug2 = (document.getElementById('ag-slug').value || '').trim().toLowerCase();
    const description = document.getElementById('ag-desc').value || '';
    const modelV = document.getElementById('ag-model').value;
    const toolsV = (document.getElementById('ag-tools').value || '').trim();
    const bodyV = document.getElementById('ag-body').value || '';
    const payload = { description, model: modelV, tools: toolsV, body: bodyV };
    if (isNew) {
      await api('/api/agents', { method: 'POST', body: JSON.stringify({ slug: slug2, ...payload }) });
      toast(`agent ${slug2} created`, 'success');
    } else {
      await api(`/api/agent/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      toast(`agent ${slug} saved`, 'success');
    }
    closeFormModal();
    AGENT_DETAIL_CACHE = null;
    await refresh();
  }, { size: 'xl' });

  if (!isNew) {
    setTimeout(() => {
      document.getElementById('ag-delete')?.addEventListener('click', async () => {
        if (!await confirmModal({
          title: 'Delete agent',
          message: `Delete agent <b>${escapeHtml(slug)}</b>? Removes <code>.claude/agents/${escapeHtml(slug)}.md</code>.`,
          confirmText: 'Delete',
          danger: true,
        })) return;
        try {
          await api(`/api/agent/${encodeURIComponent(slug)}`, { method: 'DELETE' });
          toast(`agent ${slug} deleted`, 'success');
          closeFormModal();
          AGENT_DETAIL_CACHE = null;
          await refresh();
        } catch (e) { toast(`delete failed: ${e.message}`, 'error'); }
      });
    }, 0);
  }
}

window.renderAgents = renderAgents;
window.patchInstanceTokens = patchInstanceTokens;
window.openAgentForm = openAgentForm;
