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
  else if (tab === 'stats') renderStats();
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

function renderSkeleton() {
  const view = document.getElementById('view-iteration');
  if (!view || view.children.length) return;
  let cols = '';
  for (let c = 0; c < 5; c++) {
    let cards = '';
    for (let i = 0; i < 3; i++) {
      cards += `<div class="card-skel"><div class="skel-line" style="width:40%"></div><div class="skel-line" style="width:90%"></div><div class="skel-line" style="width:60%"></div></div>`;
    }
    cols += `<div class="column"><div class="column-head"><div class="skel-line" style="width:60px"></div></div><div class="column-body">${cards}</div></div>`;
  }
  view.innerHTML = `<div class="board-header"><div class="board-title-row"><div class="skel-line" style="width:200px;height:14px"></div></div></div><div class="board">${cols}</div>`;
}

let FIRST_REFRESH = true;
let LAST_SIG = '';

function dataSignature() {
  const tasks = (STATE.board.tasks || []).map(t => {
    const subs = t._subtasks || [];
    const subSig = `${subs.length}/${subs.filter(s => s.checked).length}`;
    const st = t._stats;
    const tokSig = st ? `${st.input || 0}+${st.output || 0}` : '';
    return `${t.id}|${t.status}|${t.assignee}|${t.estimate || ''}|${(t.deps || []).join(',')}|${t.attempts || 0}|${t.title || ''}|${subSig}|${tokSig}`;
  }).sort().join('\n');
  const tracks = (STATE.tracks.tracks || []).map(tr =>
    `${tr.slug}|${tr.active || ''}|${(tr.iterations || []).map(it => `${it.id}:${it.status}:${it.task_count}:${it.done_count || 0}`).join(';')}`
  ).sort().join('\n');
  const queue = (STATE.queue.items || []).map(q => `${q.task_id}|${q.assignee || ''}`).sort().join('\n');
  const iter = STATE.board.iteration ? `${STATE.board.iteration.id}|${STATE.board.iteration.track || ''}|${(STATE.board.iteration.readme || '').length}` : '';
  return `${iter}\n${tasks}\n${tracks}\n${queue}`;
}

async function refresh(opts = {}) {
  if (FIRST_REFRESH) renderSkeleton();
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

  // Skip DOM re-render when data signature is unchanged (poll no-op).
  const sig = dataSignature();
  const sameData = sig === LAST_SIG && !FIRST_REFRESH && !opts.force;
  LAST_SIG = sig;

  updateHeader();
  if (!sameData) {
    if (STATE.currentTab === 'tracks') renderTracks();
    else if (STATE.currentTab === 'agents') renderAgents();
    else renderBoard();
  }
  checkConflict();
  FIRST_REFRESH = false;
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

function applyDensity(d) {
  document.documentElement.dataset.density = d;
  try { localStorage.setItem('workflow-density', d); } catch {}
  const icon = document.getElementById('icon-density');
  if (icon) icon.innerHTML = d === 'compact' ? Icons.rowsTight(13, 1.5) : Icons.rows(13, 1.5);
}

function initDensity() {
  let d = 'comfortable';
  try { d = localStorage.getItem('workflow-density') || 'comfortable'; } catch {}
  applyDensity(d);
}

function bindChrome() {
  for (const el of document.querySelectorAll('.tab')) {
    el.addEventListener('click', () => setTab(el.dataset.tab));
  }
  document.getElementById('reload')?.addEventListener('click', refresh);
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
  document.getElementById('density-toggle')?.addEventListener('click', () => {
    applyDensity(document.documentElement.dataset.density === 'compact' ? 'comfortable' : 'compact');
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
    [['Esc'], 'Close any panel/modal/focus'],
  ]],
  ['Cards (iteration tab)', [
    [['j'], 'Focus next card in column'],
    [['k'], 'Focus previous card'],
    [['h'], 'Focus first card in left column'],
    [['l'], 'Focus first card in right column'],
    [['1','-','5'], 'Move focused card to column N'],
    [['Enter'], 'Open card details'],
    [['e'], 'Edit (alias for Enter)'],
    [['s'], 'Start dispatch (todo + deps ready)'],
    [['v'], 'Verify (verifying status)'],
    [['n'], 'New task in active iteration'],
  ]],
  ['Theme', [
    [['T'], 'Toggle dark / light'],
    [['D'], 'Toggle compact / comfortable'],
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

// ============ card keyboard navigation ============
function focusedCard() { return document.querySelector('.card.focused'); }
function focusCard(card) {
  if (!card) return;
  for (const c of document.querySelectorAll('.card.focused')) c.classList.remove('focused');
  card.classList.add('focused');
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function focusFirstCard() {
  const c = document.querySelector('#view-iteration .card');
  if (c) focusCard(c);
}
function moveFocus(dir) {
  const cards = Array.from(document.querySelectorAll('#view-iteration .card'));
  if (!cards.length) return;
  const cur = focusedCard();
  if (!cur) { focusCard(cards[0]); return; }

  if (dir === 'j' || dir === 'k') {
    const col = cur.parentElement;
    const colCards = Array.from(col.querySelectorAll('.card'));
    const i = colCards.indexOf(cur);
    const next = dir === 'j' ? colCards[i + 1] : colCards[i - 1];
    if (next) focusCard(next);
  } else if (dir === 'h' || dir === 'l') {
    const cols = Array.from(document.querySelectorAll('#view-iteration .column'));
    const curCol = cur.closest('.column');
    let idx = cols.indexOf(curCol);
    const step = dir === 'l' ? 1 : -1;
    for (let i = idx + step; i >= 0 && i < cols.length; i += step) {
      const first = cols[i].querySelector('.card');
      if (first) { focusCard(first); return; }
    }
  }
}

function moveCardToCol(card, colKey) {
  const id = card.dataset.id;
  const t = STATE.taskIndex[id];
  if (!t) return;
  const newStatus = statusForCol(colKey);
  if (newStatus === t.status) return;
  // Same dep guard as drop
  if (!depsAllReady(t) && (colKey === 'in-progress' || colKey === 'review' || colKey === 'done')) {
    toast(`${id}: unmet deps`, 'error');
    return;
  }
  moveTask(id, newStatus);
}

async function actCard(card, action) {
  const id = card?.dataset.id;
  if (!id) return;
  const t = STATE.taskIndex[id];
  if (!t) return;
  switch (action) {
    case 'open':   openModal(id); break;
    case 'verify': openModal(id, { verify: true }); break;
    case 'start':
      if (t.status === 'todo' && t.assignee !== 'user' && depsAllReady(t)) await dispatchTask(id);
      else toast(`${id}: cannot start`, 'error');
      break;
  }
}

function bindShortcuts() {
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (document.getElementById('confirm-bg')?.classList.contains('open')) return; // handled in util.js
      if (document.getElementById('kbd-bg')?.classList.contains('open')) { closeKbdOverlay(); return; }
      if (document.getElementById('newtask-bg')?.classList.contains('open')) { closeNewTaskForm(); return; }
      if (document.getElementById('form-bg')?.classList.contains('open')) { closeFormModal(); return; }
      if (document.getElementById('modal-bg')?.classList.contains('open')) { closeModal(); return; }
      if (document.getElementById('queue-sheet')?.classList.contains('open')) { closeQueueSheet(); return; }
      const fc = focusedCard();
      if (fc) { fc.classList.remove('focused'); return; }
      return;
    }
    if (isTyping(e)) return;
    if (anyOverlayOpen()) return;

    // card-scoped first when on iteration tab
    if (STATE.currentTab === 'iteration') {
      const fc = focusedCard();
      if (['j','k','h','l'].includes(e.key)) {
        e.preventDefault();
        if (!fc) focusFirstCard();
        else moveFocus(e.key);
        return;
      }
      if (fc) {
        if (e.key >= '1' && e.key <= '5') {
          e.preventDefault();
          const col = COLUMNS[Number(e.key) - 1];
          if (col) moveCardToCol(fc, col.key);
          return;
        }
        if (e.key === 'Enter' || e.key === 'o' || e.key === 'e') {
          e.preventDefault(); actCard(fc, 'open'); return;
        }
        if (e.key === 's') { e.preventDefault(); actCard(fc, 'start'); return; }
        if (e.key === 'v') { e.preventDefault(); actCard(fc, 'verify'); return; }
      }
    }

    switch (e.key) {
      case '?':
        e.preventDefault(); openKbdOverlay(); break;
      case '/':
        e.preventDefault(); document.getElementById('search-input')?.focus(); break;
      case 'i': setTab('iteration'); break;
      case 't': setTab('tracks'); break;
      case 'a': setTab('agents'); break;
      case 's': setTab('stats'); break;
      case 'q': e.preventDefault(); toggleQueueSheet(); break;
      case 'n': e.preventDefault(); openNewTaskForm(); break;
      case 'r': refresh(); break;
      case 'T':
        applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
        break;
      case 'D':
        applyDensity(document.documentElement.dataset.density === 'compact' ? 'comfortable' : 'compact');
        break;
      default: break;
    }
  });
}

// ============ new task form ============
function activeTrackForNewTask() {
  if (STATE.boardTrack && STATE.board.iteration) {
    return { track: STATE.boardTrack, iter: STATE.board.iteration.id, slug: STATE.board.iteration.slug };
  }
  // fall back to first active iter from aggregate
  const a = (STATE.board.actives || [])[0];
  if (a) return { track: a.track, iter: a.id, slug: a.slug };
  return null;
}

function openNewTaskForm() {
  const ctx = activeTrackForNewTask();
  if (!ctx) {
    toast('no active iteration — pick a track or activate one', 'error');
    return;
  }
  document.getElementById('newtask-iter').textContent = `${ctx.track} · ${ctx.iter} ${ctx.slug || ''}`;
  const sel = document.getElementById('nt-assignee');
  sel.innerHTML = '';
  for (const name of ['user', ...(STATE.board.agents || [])]) {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  }
  document.getElementById('nt-title').value = '';
  document.getElementById('nt-estimate').value = 'M';
  document.getElementById('newtask-bg').classList.add('open');
  setTimeout(() => document.getElementById('nt-title')?.focus(), 50);
}

function closeNewTaskForm() {
  document.getElementById('newtask-bg')?.classList.remove('open');
}

async function submitNewTask() {
  const ctx = activeTrackForNewTask();
  if (!ctx) return;
  const title = document.getElementById('nt-title').value.trim();
  if (!title) { toast('title required', 'error'); return; }
  const assignee = document.getElementById('nt-assignee').value;
  const estimate = document.getElementById('nt-estimate').value;
  try {
    const r = await api(`/api/track/${encodeURIComponent(ctx.track)}/iteration/${encodeURIComponent(ctx.iter)}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title, assignee, estimate, deps: [] }),
    });
    toast(`${r.id} created`, 'success');
    closeNewTaskForm();
    await refresh();
  } catch (e) { toast(`create failed: ${e.message}`, 'error'); }
}

function bindNewTaskForm() {
  document.getElementById('newtask-close')?.addEventListener('click', closeNewTaskForm);
  document.getElementById('nt-cancel')?.addEventListener('click', closeNewTaskForm);
  document.getElementById('nt-save')?.addEventListener('click', submitNewTask);
  document.getElementById('newtask-bg')?.addEventListener('click', e => {
    if (e.target.id === 'newtask-bg') closeNewTaskForm();
  });
  document.getElementById('nt-title')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitNewTask(); }
  });
}

// ============ conflict banner ============
let CONFLICT_LATEST_TASK = null;

function checkConflict() {
  const banner = document.getElementById('conflict-banner');
  if (!banner) return;
  if (!MODAL_TASK || !document.getElementById('modal-bg')?.classList.contains('open')) {
    banner.classList.remove('open');
    CONFLICT_LATEST_TASK = null;
    return;
  }
  const fresh = STATE.taskIndex[MODAL_TASK.id];
  if (!fresh) { banner.classList.remove('open'); return; }
  const sig = (t) => `${t.status}|${t.assignee}|${(t.deps || []).join(',')}|${t.estimate || ''}|${t.title || ''}|${t.attempts || 0}`;
  if (sig(fresh) !== sig(MODAL_TASK)) {
    document.getElementById('conflict-text').textContent =
      `Task ${MODAL_TASK.id} was modified on disk while you were editing.`;
    banner.classList.add('open');
    CONFLICT_LATEST_TASK = fresh;
  } else {
    banner.classList.remove('open');
    CONFLICT_LATEST_TASK = null;
  }
}

function bindConflictBanner() {
  document.getElementById('conflict-keep')?.addEventListener('click', () => {
    document.getElementById('conflict-banner')?.classList.remove('open');
  });
  document.getElementById('conflict-reload')?.addEventListener('click', async () => {
    document.getElementById('conflict-banner')?.classList.remove('open');
    if (MODAL_TASK) await openModal(MODAL_TASK.id);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initDensity();

  // mount static icons
  document.getElementById('icon-search').innerHTML = Icons.search(13, 1.4);
  document.getElementById('icon-reload').innerHTML = Icons.reload(13, 1.5);
  document.getElementById('icon-chev').innerHTML  = Icons.chevron(11, 1.5);
  const qIcon = document.getElementById('icon-queue');
  if (qIcon) qIcon.innerHTML = Icons.queue(13, 1.5);

  bindChrome();
  bindModal();
  bindFormModal();
  bindNewTaskForm();
  bindConflictBanner();
  bindConfirm();
  bindShortcuts();

  document.getElementById('queue-btn')?.addEventListener('click', toggleQueueSheet);
  document.getElementById('queue-sheet-close')?.addEventListener('click', closeQueueSheet);
  document.getElementById('kbd-help')?.addEventListener('click', openKbdOverlay);
  document.getElementById('kbd-close')?.addEventListener('click', closeKbdOverlay);
  document.getElementById('kbd-bg')?.addEventListener('click', e => {
    if (e.target.id === 'kbd-bg') closeKbdOverlay();
  });

  refresh();
  bindEventStream();
  // Slow fallback poll (in case SSE drops) — once per 30s.
  setInterval(refresh, 30000);
});

// ============ Server-Sent Events ============
let SSE = null;
let SSE_REFRESH_TIMER = null;

function bindEventStream() {
  try {
    SSE = new EventSource('/api/events');
  } catch (e) { return; }

  const debounceRefresh = () => {
    clearTimeout(SSE_REFRESH_TIMER);
    SSE_REFRESH_TIMER = setTimeout(() => refresh(), 120);
  };

  SSE.addEventListener('change', debounceRefresh);
  SSE.addEventListener('error', () => {
    // EventSource auto-reconnects per the `retry:` directive; nothing else needed.
  });
}

window.refresh = refresh;
window.setTab = setTab;
window.openQueueSheet = openQueueSheet;
window.closeQueueSheet = closeQueueSheet;
window.toggleQueueSheet = toggleQueueSheet;
window.openKbdOverlay = openKbdOverlay;
window.closeKbdOverlay = closeKbdOverlay;
