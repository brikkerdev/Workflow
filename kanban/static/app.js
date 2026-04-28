// Workflow — top-level controller (tabs, refresh, queue sheet, kbd overlay, shortcuts).

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
    if (iter) iterEl.textContent = `${STATE.boardTrack} · ${iter.id}${iter.fm?.title ? ' ' + iter.fm.title : ''}`;
    else iterEl.innerHTML = `<span style="color:var(--fg-3)">${escapeHtml(STATE.boardTrack)} · no active</span>`;
  } else if (actives.length) {
    iterEl.textContent = `All active · ${actives.length}`;
  } else {
    iterEl.innerHTML = `<span style="color:var(--fg-3)">none</span>`;
  }
  populateBoardTrackPicker();

  // Tab badges
  const tracksBadge = document.getElementById('tracks-badge');
  const trackCount = (STATE.tracks.tracks || []).length;
  tracksBadge.textContent = trackCount ? `(${trackCount})` : '';
  const busyCount = allTasks().filter(t => t.status === 'in-progress').length;
  document.getElementById('agents-badge').textContent = busyCount ? `(${busyCount})` : '';
  const iterBadge = document.getElementById('iteration-badge');
  if (iterBadge) {
    const total = (STATE.board.tasks || []).length;
    iterBadge.textContent = total ? `(${total})` : '';
  }

  // Topbar queue badge
  const qbtn = document.getElementById('queue-btn');
  const qcount = document.getElementById('queue-count');
  const items = STATE.queue.items || [];
  if (qbtn && qcount) {
    if (items.length) {
      qcount.textContent = items.length;
      qcount.hidden = false;
    } else {
      qcount.hidden = true;
    }
  }

  // Re-render side-sheet if open
  if (document.getElementById('queue-sheet')?.classList.contains('open')) renderQueueSheet();
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
      document.title = `${project.name} — Workflow`;
    }
  } catch (e) {
    document.getElementById('view-iteration').innerHTML =
      `<div class="init"><div class="init-card"><h2>Server error</h2><p class="lede">${escapeHtml(e.message)}</p></div></div>`;
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
  document.getElementById('reload')?.addEventListener('click', refresh);
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
  const sel = document.getElementById('board-track');
  if (sel) sel.addEventListener('change', () => {
    STATE.boardTrack = sel.value || null;
    refresh();
  });
  bindSearch();
}

function rerenderActiveView() {
  if (STATE.currentTab === 'tracks') renderTracks();
  else if (STATE.currentTab === 'agents') renderAgents();
  else renderBoard();
}

let SEARCH_TIMER = null;
function bindSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;
  input.addEventListener('input', () => {
    STATE.search = input.value || '';
    clearTimeout(SEARCH_TIMER);
    SEARCH_TIMER = setTimeout(rerenderActiveView, 80);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      input.value = '';
      STATE.search = '';
      input.blur();
      rerenderActiveView();
    }
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
    o.textContent = `${t.slug}${t.active ? ' · ' + t.active : ''}`;
    sel.appendChild(o);
  }
  sel.value = cur;
  sel.dataset.populated = want;
}

// ============ queue side-sheet ============
function renderQueueSheet() {
  const body = document.getElementById('queue-sheet-body');
  const sub = document.getElementById('queue-sheet-sub');
  const items = STATE.queue.items || [];
  if (sub) sub.textContent = items.length ? `${items.length} pending` : '';
  if (!body) return;
  if (!items.length) {
    body.innerHTML = `<div class="queue-empty"><div class="glyph">○</div>queue empty</div>`;
    return;
  }
  body.innerHTML = '';
  for (const it of items) {
    const t = STATE.taskIndex[it.task_id];
    const title = t?.title || '(unknown task)';
    const ts = it.queued_at ? new Date(it.queued_at).toLocaleTimeString() : '';
    const status = t?.status || 'queued';
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.innerHTML = `
      <span class="dot s-${status}${status === 'in-progress' ? ' pulse' : ''}"></span>
      <div style="min-width:0">
        <div><span class="queue-id">${escapeHtml(it.task_id)}</span> <span class="queue-task">${escapeHtml(title)}</span></div>
        <div class="queue-meta">
          ${it.assignee ? `<span>${escapeHtml(it.assignee)}</span><span>·</span>` : ''}
          <span>${escapeHtml(status)}</span>
          ${ts ? `<span>·</span><span>${escapeHtml(ts)}</span>` : ''}
        </div>
      </div>
      <button class="queue-cancel" data-id="${escapeHtml(it.task_id)}">Cancel</button>
    `;
    row.addEventListener('click', e => {
      const btn = e.target.closest('.queue-cancel');
      if (btn) { e.stopPropagation(); stopTask(btn.dataset.id); return; }
      closeQueueSheet();
      openModal(it.task_id);
    });
    body.appendChild(row);
  }
}

function openQueueSheet() {
  document.getElementById('queue-sheet')?.classList.add('open');
  renderQueueSheet();
}
function closeQueueSheet() {
  document.getElementById('queue-sheet')?.classList.remove('open');
}
function toggleQueueSheet() {
  const el = document.getElementById('queue-sheet');
  if (!el) return;
  if (el.classList.contains('open')) closeQueueSheet();
  else openQueueSheet();
}

// ============ keyboard help overlay ============
const KBD_GROUPS = [
  ['Navigation', [
    [['?'], 'Toggle this overlay'],
    [['/'], 'Focus search'],
    [['i'], 'Iteration board'],
    [['t'], 'Tracks'],
    [['a'], 'Agents'],
    [['q'], 'Toggle queue panel'],
    [['Esc'], 'Close any panel/modal'],
  ]],
  ['Cards', [
    [['Enter'], 'Open card details'],
    [['s'], 'Start dispatch (todo + deps ready)'],
    [['v'], 'Verify (verifying status)'],
  ]],
  ['Theme', [
    [['T'], 'Toggle dark / light'],
    [['r'], 'Reload from server'],
  ]],
];

function buildKbdOverlay() {
  const grid = document.getElementById('kbd-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const [section, rows] of KBD_GROUPS) {
    const h = document.createElement('div');
    h.className = 'kbd-section';
    h.textContent = section;
    grid.appendChild(h);
    for (const [keys, label] of rows) {
      const row = document.createElement('div');
      row.className = 'kbd-row';
      row.innerHTML = `<span>${escapeHtml(label)}</span><span class="keys">${keys.map(k => `<span class="kbd">${escapeHtml(k)}</span>`).join('')}</span>`;
      grid.appendChild(row);
    }
  }
}

function openKbdOverlay() {
  buildKbdOverlay();
  document.getElementById('kbd-bg')?.classList.add('open');
}
function closeKbdOverlay() {
  document.getElementById('kbd-bg')?.classList.remove('open');
}

// ============ global shortcuts ============
function isTyping(e) {
  const t = e.target;
  if (!t) return false;
  const tag = (t.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
}
function anyOverlayOpen() {
  return document.getElementById('modal-bg')?.classList.contains('open')
      || document.getElementById('form-bg')?.classList.contains('open')
      || document.getElementById('kbd-bg')?.classList.contains('open');
}

function bindShortcuts() {
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (document.getElementById('kbd-bg')?.classList.contains('open')) { closeKbdOverlay(); return; }
      if (document.getElementById('form-bg')?.classList.contains('open')) { closeFormModal(); return; }
      if (document.getElementById('modal-bg')?.classList.contains('open')) { closeModal(); return; }
      if (document.getElementById('queue-sheet')?.classList.contains('open')) { closeQueueSheet(); return; }
      return;
    }
    if (isTyping(e)) return;
    if (anyOverlayOpen()) return;

    switch (e.key) {
      case '?':
        e.preventDefault(); openKbdOverlay(); break;
      case '/':
        e.preventDefault(); document.getElementById('search-input')?.focus(); break;
      case 'i': setTab('iteration'); break;
      case 't': setTab('tracks'); break;
      case 'a': setTab('agents'); break;
      case 'q': e.preventDefault(); toggleQueueSheet(); break;
      case 'r': refresh(); break;
      case 'T':
        applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
        break;
      default: break;
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();

  // mount static icons
  document.getElementById('icon-search').innerHTML = Icons.search(13, 1.4);
  document.getElementById('icon-reload').innerHTML = Icons.reload(13, 1.5);
  document.getElementById('icon-chev').innerHTML  = Icons.chevron(11, 1.5);
  const qIcon = document.getElementById('icon-queue');
  if (qIcon) qIcon.innerHTML = Icons.queue(13, 1.5);

  bindChrome();
  bindModal();
  bindFormModal();
  bindShortcuts();

  document.getElementById('queue-btn')?.addEventListener('click', toggleQueueSheet);
  document.getElementById('queue-sheet-close')?.addEventListener('click', closeQueueSheet);
  document.getElementById('kbd-help')?.addEventListener('click', openKbdOverlay);
  document.getElementById('kbd-close')?.addEventListener('click', closeKbdOverlay);
  document.getElementById('kbd-bg')?.addEventListener('click', e => {
    if (e.target.id === 'kbd-bg') closeKbdOverlay();
  });

  refresh();
  setInterval(refresh, 5000);
});

window.refresh = refresh;
window.setTab = setTab;
window.openQueueSheet = openQueueSheet;
window.closeQueueSheet = closeQueueSheet;
window.toggleQueueSheet = toggleQueueSheet;
window.openKbdOverlay = openKbdOverlay;
window.closeKbdOverlay = closeKbdOverlay;
