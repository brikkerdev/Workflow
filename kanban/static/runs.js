// Workflow — Runs page: per-iteration token totals.
// One row per iteration that has been touched by /iterate, plus iterations
// on disk that haven't been run yet (status only, no totals). Click a row
// to expand per-session breakdown.

let RUNS_CACHE = null;
const EXPANDED_RUNS = new Set();

async function fetchRuns() {
  try { RUNS_CACHE = await api('/api/iterations/runs'); }
  catch { RUNS_CACHE = { iterations: [] }; }
}

function fmtTok(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 16).replace('T', ' ');
  } catch { return iso; }
}

async function renderRuns() {
  const view = document.getElementById('view-runs');
  view.innerHTML = '<div class="stats-loading">loading…</div>';
  await fetchRuns();
  const list = RUNS_CACHE?.iterations || [];

  // Grand totals across all iterations that have data.
  const grand = list.reduce((acc, r) => {
    const t = r.totals || {};
    acc.input += t.input || 0;
    acc.output += t.output || 0;
    acc.cache_read += t.cache_read || 0;
    acc.cache_creation += t.cache_creation || 0;
    acc.runs += t.runs || 0;
    if (r.totals) acc.iterations += 1;
    return acc;
  }, { input: 0, output: 0, cache_read: 0, cache_creation: 0, runs: 0, iterations: 0 });

  const headerHtml = `
    <div class="tracks-header">
      <div>
        <h1>Runs</h1>
        <div class="subtitle mono">${grand.iterations} iter${grand.iterations === 1 ? '' : 's'} tracked · ${fmtTok(grand.input + grand.output)} tokens · ${grand.runs} session${grand.runs === 1 ? '' : 's'}</div>
      </div>
    </div>
    <div class="stats-grand">
      <div class="stats-card"><div class="stats-card-label">input</div><div class="stats-card-val">${fmtTok(grand.input)}</div></div>
      <div class="stats-card"><div class="stats-card-label">output</div><div class="stats-card-val">${fmtTok(grand.output)}</div></div>
      <div class="stats-card"><div class="stats-card-label">cache read</div><div class="stats-card-val">${fmtTok(grand.cache_read)}</div></div>
      <div class="stats-card"><div class="stats-card-label">cache write</div><div class="stats-card-val">${fmtTok(grand.cache_creation)}</div></div>
    </div>
  `;

  const rows = list.map(r => {
    const key = `${r.track}/${r.id}`;
    const t = r.totals || {};
    const total = (t.input || 0) + (t.output || 0);
    const expanded = EXPANDED_RUNS.has(key);
    const hasRuns = r.runs && r.runs.length > 0;
    const expander = hasRuns ? `<span class="runs-expander">${expanded ? '▾' : '▸'}</span>` : '<span class="runs-expander muted">·</span>';
    const main = `
      <tr class="runs-row${hasRuns ? ' runs-row-clickable' : ''}" data-key="${escapeHtml(key)}">
        <td class="mono">${expander} ${escapeHtml(r.track)}</td>
        <td class="mono">${escapeHtml(r.id)}</td>
        <td>${escapeHtml(r.title || r.slug || '')}</td>
        <td class="mono"><span class="iter-status iter-status-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
        <td class="num">${r.done_count}/${r.task_count}</td>
        <td class="num">${fmtTok(t.input)}</td>
        <td class="num">${fmtTok(t.output)}</td>
        <td class="num">${fmtTok(t.cache_read)}</td>
        <td class="num"><b>${total ? fmtTok(total) : '—'}</b></td>
        <td class="num">${t.runs || (r.totals ? 0 : '—')}</td>
      </tr>
    `;
    if (!expanded || !hasRuns) return main;
    const sessionRows = (r.runs || []).map(s => {
      const tot = (s.input || 0) + (s.output || 0);
      return `
        <tr class="runs-session-row">
          <td colspan="2" class="mono muted">${escapeHtml(s.session_id || '').slice(0, 8)}…</td>
          <td class="mono muted">${escapeHtml(fmtTime(s.ts))}</td>
          <td></td>
          <td></td>
          <td class="num">${fmtTok(s.input)}</td>
          <td class="num">${fmtTok(s.output)}</td>
          <td class="num">${fmtTok(s.cache_read)}</td>
          <td class="num">${fmtTok(tot)}</td>
          <td class="num">${s.messages || 0} msg</td>
        </tr>
      `;
    }).join('');
    return main + sessionRows;
  }).join('');

  const tableHtml = list.length ? `
    <div class="stats-table-wrap">
      <table class="stats-table">
        <thead>
          <tr>
            <th>Track</th><th>ID</th><th>Title</th><th>Status</th>
            <th>Tasks</th><th>Input</th><th>Output</th><th>Cache hit</th><th>Total</th><th>Sessions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  ` : '<div class="tracks-empty"><h2>No iterations yet</h2><p>run <code>/iterate</code> from a Claude session — totals appear here once the orchestrator calls workflow_iteration_load.</p></div>';

  view.innerHTML = `<div class="stats-page"><div class="stats-inner">${headerHtml}${tableHtml}</div></div>`;

  view.querySelectorAll('.runs-row-clickable').forEach(tr => {
    tr.addEventListener('click', () => {
      const k = tr.dataset.key;
      if (!k) return;
      if (EXPANDED_RUNS.has(k)) EXPANDED_RUNS.delete(k);
      else EXPANDED_RUNS.add(k);
      renderRuns();
    });
  });
}

window.renderRuns = renderRuns;
