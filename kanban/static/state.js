// 5-column model per design.
// Maps backend status set {todo,queued,in-progress,verifying,review,blocked,done}
// onto 5 visible columns: Backlog, In progress, Review, Blocked, Done.

const COLUMNS = [
  { key: 'backlog',     label: 'Backlog',     statuses: ['todo'],                  kbd: '1', primary: 'todo' },
  { key: 'in-progress', label: 'In progress', statuses: ['in-progress','queued'],  kbd: '2', primary: 'in-progress' },
  { key: 'review',      label: 'Review',      statuses: ['review','verifying'],    kbd: '3', primary: 'review' },
  { key: 'blocked',     label: 'Blocked',     statuses: ['blocked'],               kbd: '4', primary: 'blocked' },
  { key: 'done',        label: 'Done',        statuses: ['done'],                  kbd: '5', primary: 'done' },
];

const ALL_STATUSES = ['todo','queued','in-progress','verifying','review','blocked','done'];

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

window.COLUMNS = COLUMNS;
window.ALL_STATUSES = ALL_STATUSES;
window.colForStatus = colForStatus;
window.statusForCol = statusForCol;
window.STATE = STATE;
window.rebuildIndex = rebuildIndex;
window.allTasks = allTasks;
window.depStatus = depStatus;
window.matchSearch = matchSearch;
