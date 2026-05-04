// Two-column model. The kanban is now a viewer: orchestrator (/iterate)
// flips status atomically when it commits the iteration. The user can
// manually drag a task between Todo and Done if they really need to.

const COLUMNS = [
  { key: 'todo',        label: 'Todo',        statuses: ['todo'],        kbd: '1', primary: 'todo' },
  { key: 'in-progress', label: 'In progress', statuses: ['in-progress'], kbd: '2', primary: 'in-progress' },
  { key: 'done',        label: 'Done',        statuses: ['done'],        kbd: '3', primary: 'done' },
];

const ALL_STATUSES = ['todo', 'in-progress', 'done'];

function colForStatus(status) {
  const c = COLUMNS.find(x => x.statuses.includes(status));
  return c ? c.key : 'todo';
}
function colForTask(t) { return colForStatus(t ? t.status : null); }
function statusForCol(colKey) {
  return (COLUMNS.find(x => x.key === colKey) || COLUMNS[0]).primary;
}

const STATE = {
  board:  { tasks: [], agents: [], iteration: null, actives: [], queue_size: 0, valid_statuses: ALL_STATUSES, transitions: {} },
  tracks: { tracks: [] },
  queue:  { size: 0, items: [] },
  instances: [],
  taskIndex: {},
  currentTab: 'iteration',
  boardTrack: null,
  viewedTrack: null,
  viewedTrackData: null,
  expandedTracks: new Set(),
  search: '',
};

function matchSearch(...fields) {
  const q = (STATE.search || '').trim().toLowerCase();
  if (!q) return true;
  return fields.some(f => String(f ?? '').toLowerCase().includes(q));
}

function rebuildIndex() {
  STATE.taskIndex = {};
  for (const t of (STATE.board.tasks || [])) STATE.taskIndex[t.id] = t;
  STATE.depIndex = (STATE.board && STATE.board.dep_index) || {};
}

function allTasks() {
  const out = [];
  for (const t of (STATE.board.tasks || [])) out.push(t);
  return out;
}

function depStatusOf(d) {
  const t = STATE.taskIndex[d];
  if (t) return t.status;
  return (STATE.depIndex || {})[d] || null;
}

function depStatus(deps) {
  if (!deps || !deps.length) return { unmet: [] };
  return { unmet: deps.filter(d => depStatusOf(d) !== 'done') };
}

window.COLUMNS = COLUMNS;
window.ALL_STATUSES = ALL_STATUSES;
window.colForStatus = colForStatus;
window.colForTask = colForTask;
window.statusForCol = statusForCol;
window.STATE = STATE;
window.rebuildIndex = rebuildIndex;
window.allTasks = allTasks;
window.depStatus = depStatus;
window.depStatusOf = depStatusOf;
window.matchSearch = matchSearch;
