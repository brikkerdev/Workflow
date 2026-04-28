// Shared state used by all views.
const COLS = ['todo', 'queued', 'in-progress', 'verifying', 'blocked', 'done'];
const COL_TITLE = {
  'todo':        'Backlog',
  'queued':      'Queued',
  'in-progress': 'In progress',
  'verifying':   'Verifying',
  'blocked':     'Blocked',
  'done':        'Done',
};

const STATE = {
  board:  { tasks: [], agents: [], iteration: null, actives: [], queue_size: 0, valid_statuses: COLS, transitions: {} },
  tracks: { tracks: [] },
  queue:  { size: 0, items: [] },
  taskIndex: {},  // id -> task across iter+tracks
  currentTab: 'iteration',
  boardTrack: null, // null = all-active aggregate; otherwise track slug
};

function rebuildIndex() {
  STATE.taskIndex = {};
  for (const t of (STATE.board.tasks || [])) STATE.taskIndex[t.id] = t;
}

function allTasks() {
  const out = [];
  for (const t of (STATE.board.tasks || [])) out.push(t);
  return out;
}

function depStatus(deps) {
  if (!deps || !deps.length) return { unmet: [] };
  return { unmet: deps.filter(d => (STATE.taskIndex[d] || {}).status !== 'done') };
}

window.COLS = COLS;
window.COL_TITLE = COL_TITLE;
window.STATE = STATE;
window.rebuildIndex = rebuildIndex;
window.allTasks = allTasks;
window.depStatus = depStatus;
