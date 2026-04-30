// 4-column model per design.
// Maps backend status set {todo,queued,in-progress,verifying,auto-verifying,
// awaiting-unity,passed-auto,red-auto,review,done} onto 4 visible columns:
// Backlog, In progress, Review, Done.
//
// Auto-track statuses (auto-verifying, awaiting-unity, passed-auto, red-auto)
// land in Review so the user sees them as "needs attention" — passed-auto is
// awaiting manual approval, red-auto is exhausted and needs intervention,
// auto-verifying/awaiting-unity are in-flight server-side checks.

const COLUMNS = [
  { key: 'backlog',     label: 'Backlog',     statuses: ['todo'],                  kbd: '1', primary: 'todo' },
  { key: 'in-progress', label: 'In progress', statuses: ['in-progress','queued'],  kbd: '2', primary: 'in-progress' },
  { key: 'review',      label: 'Review',      statuses: ['review','verifying','auto-verifying','awaiting-unity','passed-auto','red-auto'], kbd: '3', primary: 'verifying' },
  { key: 'done',        label: 'Done',        statuses: ['done'],                  kbd: '4', primary: 'done' },
];

const ALL_STATUSES = ['todo','queued','in-progress','verifying','auto-verifying','awaiting-unity','passed-auto','red-auto','review','done'];

function colForStatus(status) {
  const c = COLUMNS.find(x => x.statuses.includes(status));
  return c ? c.key : 'backlog';
}
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
window.statusForCol = statusForCol;
window.STATE = STATE;
window.rebuildIndex = rebuildIndex;
window.allTasks = allTasks;
window.depStatus = depStatus;
window.depStatusOf = depStatusOf;
window.matchSearch = matchSearch;
