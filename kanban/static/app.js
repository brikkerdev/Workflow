// Top-level controller: tabs, refresh loop, header chrome.

function setTab(tab) {
  STATE.currentTab = tab;
  for (const el of document.querySelectorAll('.tab')) {
    el.classList.toggle('active', el.dataset.tab === tab);
  }
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('active', v.id === `view-${tab}`);
  }
  if (tab === 'tracks') renderTracks();
  else if (tab === 'agents') renderAgents();
  else renderBoard();
}

function updateHeader() {
  const iter = STATE.board.iteration;
  const actives = STATE.board.actives || [];
  const iterEl = document.getElementById('iter-name');
  if (STATE.boardTrack) {
    if (iter) iterEl.textContent = `${STATE.boardTrack} · iter ${iter.id}${iter.fm?.title ? ' · ' + iter.fm.title : ''}`;
    else iterEl.innerHTML = `<span style="color:var(--text-dim)">${STATE.boardTrack} · no active iter</span>`;
  } else if (actives.length) {
    iterEl.textContent = `All active · ${actives.length} iter${actives.length > 1 ? 's' : ''}`;
  } else {
    iterEl.innerHTML = `<span style="color:var(--text-dim)">no active iterations</span>`;
  }
  populateBoardTrackPicker();

  const tracksBadge = document.getElementById('tracks-badge');
  const trackCount = (STATE.tracks.tracks || []).length;
  tracksBadge.textContent = trackCount ? `(${trackCount})` : '';

  const busyCount = allTasks().filter(t => t.status === 'in-progress').length;
  document.getElementById('agents-badge').textContent = busyCount ? `(${busyCount})` : '';

  // queue indicator
  const ind = document.getElementById('queue-indicator');
  const items = STATE.queue.items || [];
  const txt = document.getElementById('queue-text');
  const sub = document.getElementById('queue-sub');
  if (items.length === 0) {
    ind.classList.add('hidden');
    ind.classList.remove('has');
    txt.textContent = 'queue empty';
    sub.textContent = '';
  } else {
    ind.classList.remove('hidden');
    ind.classList.add('has');
    txt.textContent = `${items.length} dispatching`;
    sub.textContent = items.map(i => i.assignee).filter(Boolean).slice(0, 4).join(' · ');
  }
}

async function refresh() {
  try {
    const boardUrl = STATE.boardTrack ? `/api/board?track=${encodeURIComponent(STATE.boardTrack)}` : '/api/board';
    const [board, tracks, queue, project] = await Promise.all([
      api(boardUrl), api('/api/tracks'), api('/api/queue'),
      api('/api/project').catch(() => null),
    ]);
    STATE.board = board;
    STATE.tracks = tracks;
    STATE.queue = queue;
    STATE.project = project;
    if (project?.name) {
      const brand = document.querySelector('.brand');
      if (brand) brand.textContent = project.name;
      document.title = `${project.name} — Kanban`;
    }
  } catch (e) {
    document.getElementById('view-iteration').innerHTML =
      `<div class="empty">server error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  rebuildIndex();
  updateHeader();
  if (STATE.currentTab === 'tracks') renderTracks();
  else if (STATE.currentTab === 'agents') renderAgents();
  else renderBoard();
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('workflow-theme', t); } catch {}
  const icon = document.getElementById('icon-theme');
  if (icon) icon.innerHTML = t === 'light' ? Icons.bolt(13, 1.5) : Icons.sparkle(13, 1.5);
}

function initTheme() {
  let t = 'dark';
  try { t = localStorage.getItem('workflow-theme') || 'dark'; } catch {}
  applyTheme(t);
}

function bindChrome() {
  for (const el of document.querySelectorAll('.tab')) {
    el.addEventListener('click', () => setTab(el.dataset.tab));
  }
  document.getElementById('reload').addEventListener('click', refresh);
  document.getElementById('theme-toggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
  const sel = document.getElementById('board-track');
  if (sel) sel.addEventListener('change', () => {
    STATE.boardTrack = sel.value || null;
    refresh();
  });
}

function populateBoardTrackPicker() {
  const sel = document.getElementById('board-track');
  if (!sel) return;
  const tracks = STATE.tracks.tracks || [];
  const cur = STATE.boardTrack || '';
  const want = ['', ...tracks.map(t => t.slug)].join('|');
  if (sel.dataset.populated === want && sel.value === cur) return;
  sel.innerHTML = '';
  const optAll = document.createElement('option');
  optAll.value = '';
  optAll.textContent = 'All active tracks';
  sel.appendChild(optAll);
  for (const t of tracks) {
    const o = document.createElement('option');
    o.value = t.slug;
    o.textContent = `${t.slug}${t.active ? ' · iter ' + t.active : ''}`;
    sel.appendChild(o);
  }
  sel.value = cur;
  sel.dataset.populated = want;
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  // mount static icons
  document.getElementById('icon-search').innerHTML = Icons.search(13, 1.4);
  document.getElementById('icon-reload').innerHTML = Icons.reload(13, 1.5);
  document.getElementById('icon-chev').innerHTML  = Icons.chevron(11, 1.5);

  bindChrome();
  bindModal();
  bindFormModal();
  refresh();
  setInterval(refresh, 5000);
});

window.refresh = refresh;
window.setTab = setTab;
