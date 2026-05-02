// Workflow — Stats page: per-agent token totals + top tasks by cost.

let STATS_CACHE = null;

async function fetchStats() {
  try {
    const r = await api('/api/stats');
    STATS_CACHE = r;
  } catch { STATS_CACHE = { grand: {}, by_agent: [], by_task: [] }; }
}

function fmtTok(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

async function renderStats() {
  const view = document.getElementById('view-stats');
  view.innerHTML = '<div class="stats-loading">loading…</div>';
  await fetchStats();
  const { grand = {}, by_agent = [], by_task = [] } = STATS_CACHE || {};

  const grandTotal = (grand.input || 0) + (grand.output || 0);
  const headerHtml = `
    <div class="tracks-header">
      <div>
        <h1>Stats</h1>
        <div class="subtitle mono">${grand.tasks || 0} tasks tracked · ${fmtTok(grandTotal)} tokens · ${grand.runs || 0} runs</div>
      </div>
    </div>
    <div class="stats-grand">
      <div class="stats-card"><div class="stats-card-label">input</div><div class="stats-card-val">${fmtTok(grand.input)}</div></div>
      <div class="stats-card"><div class="stats-card-label">output</div><div class="stats-card-val">${fmtTok(grand.output)}</div></div>
      <div class="stats-card"><div class="stats-card-label">cache read</div><div class="stats-card-val">${fmtTok(grand.cache_read)}</div></div>
      <div class="stats-card"><div class="stats-card-label">cache write</div><div class="stats-card-val">${fmtTok(grand.cache_creation)}</div></div>
    </div>
  `;

  const agentRows = by_agent.map(a => {
    const total = a.input + a.output;
    const reworkPct = a.tasks ? Math.round(100 * a.rework / a.tasks) : 0;
    return `
      <tr>
        <td><span class="agent-pill" style="background:${escapeHtml(agentColor(a.agent))}">${escapeHtml(a.agent)}</span></td>
        <td class="num">${a.tasks}</td>
        <td class="num">${a.done}</td>
        <td class="num">${a.rework} <span class="muted">(${reworkPct}%)</span></td>
        <td class="num">${fmtTok(a.input)}</td>
        <td class="num">${fmtTok(a.output)}</td>
        <td class="num">${fmtTok(a.cache_read)}</td>
        <td class="num"><b>${fmtTok(total)}</b></td>
        <td class="num">${a.tasks ? fmtTok(Math.round(total / a.tasks)) : '—'}</td>
      </tr>
    `;
  }).join('');

  const agentsHtml = by_agent.length ? `
    <h2 class="stats-h2">By agent</h2>
    <div class="stats-table-wrap">
      <table class="stats-table">
        <thead>
          <tr>
            <th>Agent</th><th>Tasks</th><th>Done</th><th>Rework</th>
            <th>Input</th><th>Output</th><th>Cache hit</th><th>Total</th><th>Avg/task</th>
          </tr>
        </thead>
        <tbody>${agentRows}</tbody>
      </table>
    </div>
  ` : '';

  const taskRows = by_task.slice(0, 25).map(t => `
    <tr data-tid="${escapeHtml(t.id)}" class="stats-task-row">
      <td class="mono">${escapeHtml(t.id)}</td>
      <td>${escapeHtml(t.title || '')}</td>
      <td><span class="agent-pill" style="background:${escapeHtml(agentColor(t.assignee))}">${escapeHtml(t.assignee || '—')}</span></td>
      <td class="mono">${escapeHtml(t.status)}</td>
      <td class="num">${t.attempts}</td>
      <td class="num">${fmtTok(t.input)}</td>
      <td class="num">${fmtTok(t.output)}</td>
      <td class="num"><b>${fmtTok(t.input + t.output)}</b></td>
    </tr>
  `).join('');

  const tasksHtml = by_task.length ? `
    <h2 class="stats-h2">Top tasks by tokens</h2>
    <div class="stats-table-wrap">
      <table class="stats-table">
        <thead>
          <tr>
            <th>ID</th><th>Title</th><th>Agent</th><th>Status</th>
            <th>Attempts</th><th>Input</th><th>Output</th><th>Total</th>
          </tr>
        </thead>
        <tbody>${taskRows}</tbody>
      </table>
    </div>
  ` : '<div class="tracks-empty"><h2>No data yet</h2><p>finish a dispatched agent — totals are recorded by the Stop hook.</p></div>';

  view.innerHTML = `<div class="stats-page"><div class="stats-inner">${headerHtml}${agentsHtml}${tasksHtml}</div></div>`;

  view.querySelectorAll('.stats-task-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.tid;
      if (id && typeof openModal === 'function') openModal(id);
    });
  });
}

window.renderStats = renderStats;
