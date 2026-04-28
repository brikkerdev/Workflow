// Workflow — Agents page (design markup: agent-row grid + edit/create form).

let AGENT_DETAIL_CACHE = null; // /api/agents response

async function fetchAgentDetails() {
  try {
    const r = await api('/api/agents');
    AGENT_DETAIL_CACHE = r.agents || [];
  } catch { AGENT_DETAIL_CACHE = []; }
}

function renderAgents() {
  const view = document.getElementById('view-agents');
  view.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'agents-page';

  const allAgents = STATE.board.agents || [];
  const agents = STATE.search ? allAgents.filter(a => matchSearch(a)) : allAgents;

  // header with + New agent button
  const header = document.createElement('div');
  header.className = 'tracks-header';
  header.innerHTML = `
    <div>
      <h1>Agents</h1>
      <div class="subtitle mono">${allAgents.length} configured</div>
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

  // load detail metadata once per render
  fetchAgentDetails().then(() => {
    const detailBySlug = Object.fromEntries((AGENT_DETAIL_CACHE || []).map(a => [a.slug, a]));
    page.querySelectorAll('.agent-row').forEach(row => {
      const slug = row.dataset.slug;
      const det = detailBySlug[slug];
      if (det) {
        const desc = row.querySelector('.agent-desc');
        if (desc && det.description) desc.textContent = det.description;
      }
    });
  });

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
      ? `working on ${escapeHtml(inProgress[0].id)} · ${escapeHtml((inProgress[0].title || '').slice(0, 60))}`
      : review.length
        ? `awaiting review on ${escapeHtml(review[0].id)}`
        : queuedTodos.length
          ? `${queuedTodos.length} queued`
          : todos.length
            ? `${todos.length} backlog`
            : `idle`;
    const tools = [
      todos.length    ? `todo:${todos.length}` : null,
      queuedTodos.length ? `queued:${queuedTodos.length}` : null,
      review.length   ? `review:${review.length}` : null,
      done.length     ? `done:${done.length}` : null,
    ].filter(Boolean);

    const row = document.createElement('div');
    row.className = 'agent-row';
    row.dataset.slug = name;
    row.innerHTML = `
      <div class="agent-swatch" style="background:${aColor}"></div>
      <div class="agent-slug">${escapeHtml(name)}</div>
      <div class="agent-desc">${desc}</div>
      <div class="agent-tools">${tools.map(t => `<span class="tool-tag">${escapeHtml(t)}</span>`).join('')}</div>
      <button class="iconbtn" title="Edit agent" data-act="edit">✎</button>
    `;
    row.querySelector('button[data-act="edit"]').addEventListener('click', e => {
      e.stopPropagation();
      openAgentForm(name);
    });
    list.appendChild(row);
  }
  page.appendChild(list);

  view.appendChild(page);
}

// ─── Agent editor ──────────────────────────────────────────────────────────

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
window.openAgentForm = openAgentForm;
