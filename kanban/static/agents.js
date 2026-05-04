// Workflow — Agents page: CRUD over .claude/agents/*.md.
// Live instances and spawn controls are gone — orchestrator (/iterate)
// owns runtime now. This page just edits agent definitions.

let AGENTS_CACHE = null;

async function fetchAgents() {
  try {
    const r = await api('/api/agents');
    AGENTS_CACHE = r.agents || [];
  } catch { AGENTS_CACHE = []; }
}

function agentInUseCount(slug) {
  let n = 0;
  for (const t of (STATE.board.tasks || [])) if (t.assignee === slug) n++;
  return n;
}

async function renderAgents() {
  const view = document.getElementById('view-agents');
  view.innerHTML = '<div class="stats-loading">loading…</div>';
  await fetchAgents();
  const list = AGENTS_CACHE || [];

  const headerHtml = `
    <div class="tracks-header">
      <div>
        <h1>Agents</h1>
        <div class="subtitle mono">${list.length} agent${list.length === 1 ? '' : 's'} in <code>.claude/agents/</code></div>
      </div>
      <div>
        <button class="btn btn-primary" id="ag-new">+ New agent</button>
      </div>
    </div>
  `;

  const cardsHtml = list.length ? `
    <div class="tracks-grid">
      ${list.map(a => {
        const used = agentInUseCount(a.slug);
        const desc = (a.description || '').trim();
        const tools = (a.tools || '').trim();
        return `
          <div class="track-card" data-slug="${escapeHtml(a.slug)}">
            <div class="track-card-head">
              <div class="track-card-titles">
                <div class="track-card-slug">${escapeHtml(a.slug)}</div>
                <div class="track-card-title">${escapeHtml(a.model || 'inherit')}</div>
              </div>
              <div class="track-card-actions">
                <button class="iconbtn ag-edit" title="edit">✎</button>
                <button class="iconbtn ag-del" title="delete">×</button>
              </div>
            </div>
            <div class="track-card-preview${desc ? '' : ' muted'}">${escapeHtml(desc || '(no description)')}</div>
            <div class="track-card-meta">
              <span class="track-card-foot mono">${tools ? escapeHtml(tools.length > 40 ? tools.slice(0, 40) + '…' : tools) : 'tools: inherit'}</span>
            </div>
            <div class="track-card-foot">${used ? `assigned to ${used} task${used === 1 ? '' : 's'}` : 'unassigned'}</div>
          </div>
        `;
      }).join('')}
    </div>
  ` : '<div class="tracks-empty"><h2>No agents yet</h2><p>Create one — they live in <code>.claude/agents/</code> as markdown with frontmatter.</p></div>';

  view.innerHTML = `<div class="stats-page"><div class="stats-inner">${headerHtml}${cardsHtml}</div></div>`;

  document.getElementById('ag-new')?.addEventListener('click', () => openAgentForm(null));
  view.querySelectorAll('.track-card').forEach(card => {
    const slug = card.dataset.slug;
    card.addEventListener('click', e => {
      if (e.target.closest('.ag-del')) { e.stopPropagation(); deleteAgent(slug); return; }
      if (e.target.closest('.ag-edit')) { e.stopPropagation(); openAgentForm(slug); return; }
      openAgentForm(slug);
    });
  });
}

async function openAgentForm(slug) {
  let a = null;
  if (slug) {
    try { a = await api(`/api/agent/${encodeURIComponent(slug)}`); }
    catch (e) { toast(`load failed: ${e.message}`, 'error'); return; }
  }
  const isNew = !a;
  const fm = a?.fm || {};
  const html = `
    <div class="form-row"><label>Slug</label><input class="input mono" id="af-slug" ${isNew ? '' : 'readonly'} value="${escapeHtml(a?.slug || '')}" placeholder="kebab-case"></div>
    <div class="form-row"><label>Description</label><input class="input" id="af-desc" value="${escapeHtml(fm.description || '')}" placeholder="when to use this agent"></div>
    <div class="form-row"><label>Model</label>
      <select class="input" id="af-model">
        <option value="inherit" ${(fm.model || 'inherit') === 'inherit' ? 'selected' : ''}>inherit</option>
        <option value="opus"    ${fm.model === 'opus'    ? 'selected' : ''}>opus</option>
        <option value="sonnet"  ${fm.model === 'sonnet'  ? 'selected' : ''}>sonnet</option>
        <option value="haiku"   ${fm.model === 'haiku'   ? 'selected' : ''}>haiku</option>
      </select>
    </div>
    <div class="form-row"><label>Tools</label><input class="input mono" id="af-tools" value="${escapeHtml(fm.tools || '')}" placeholder="empty = inherit; e.g. Read, Edit, Bash"></div>
    <div class="form-row"><label>Body</label><textarea class="textarea mono" id="af-body" placeholder="# role\n\nrole description, instructions, tone…">${escapeHtml(a?.body || '')}</textarea></div>
  `;
  openFormModal(isNew ? 'New agent' : `Edit agent · ${a.slug}`, html, async () => {
    const slug2 = (document.getElementById('af-slug').value || '').trim().toLowerCase();
    const description = document.getElementById('af-desc').value || '';
    const model = document.getElementById('af-model').value || 'inherit';
    const tools = (document.getElementById('af-tools').value || '').trim();
    const body = document.getElementById('af-body').value || '';
    if (isNew) {
      await api('/api/agents', { method: 'POST', body: JSON.stringify({ slug: slug2, description, model, tools, body }) });
      toast(`agent ${slug2} created`, 'success');
    } else {
      await api(`/api/agent/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        body: JSON.stringify({ description, model, tools, body }),
      });
      toast(`agent ${slug} saved`, 'success');
    }
    closeFormModal();
    await fetchAgents();
    renderAgents();
  });
}

async function deleteAgent(slug) {
  if (!await confirmModal({
    title: 'Delete agent',
    message: `Delete agent <b>${escapeHtml(slug)}</b>? Removes <code>.claude/agents/${escapeHtml(slug)}.md</code>.`,
    confirmText: 'Delete',
    danger: true,
  })) return;
  try {
    await api(`/api/agent/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    toast(`agent ${slug} deleted`, 'success');
    await fetchAgents();
    renderAgents();
  } catch (e) { toast(`delete failed: ${e.message}`, 'error'); }
}

window.renderAgents = renderAgents;
