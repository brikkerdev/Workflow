import path from 'node:path';
import fs from 'node:fs';
import { VALID_STATUSES, ALLOWED_TRANSITIONS, transitionsJson, ROOT, WORKFLOW, TRACKS_DIR } from './config.mjs';
import {
  exists, readText, rel,
  activeIter, iterDir, listTasks, listTrackSlugs, listTrackTasks,
  listAgents, findTask, saveTask, depsSatisfied,
} from './repo.mjs';
import { queueCount, queueItems, writeTrigger, deleteTrigger } from './queue.mjs';
import { sendJson, readBody } from './http.mjs';
import { listAttachments, saveAttachment, deleteAttachment, readAttachment } from './attachments.mjs';

function projectName() {
  const f = path.join(WORKFLOW, 'PROJECT');
  if (fs.existsSync(f)) {
    const v = fs.readFileSync(f, 'utf-8').trim();
    if (v) return v;
  }
  return path.basename(ROOT);
}

export function handleProject(res) {
  sendJson(res, 200, { name: projectName(), root: ROOT });
}

export function handleBoard(res) {
  const iter = activeIter();
  if (!iter) {
    return sendJson(res, 200, {
      iteration: null, tasks: [], agents: listAgents(),
      queue_size: queueCount(), valid_statuses: VALID_STATUSES,
      transitions: transitionsJson(),
    });
  }
  const d = iterDir(iter);
  let readme = '';
  if (d && exists(path.join(d, 'README.md'))) readme = readText(path.join(d, 'README.md'));
  return sendJson(res, 200, {
    iteration: { id: iter, dir: d ? rel(d) : null, readme },
    tasks: listTasks(iter),
    agents: listAgents(),
    queue_size: queueCount(),
    valid_statuses: VALID_STATUSES,
    transitions: transitionsJson(),
    track_count: listTrackSlugs().length,
  });
}

export function handleTracks(res) {
  const out = [];
  for (const slug of listTrackSlugs()) {
    const d = path.join(TRACKS_DIR, slug);
    let readme = '';
    if (exists(path.join(d, 'README.md'))) readme = readText(path.join(d, 'README.md'));
    out.push({ slug, dir: rel(d), readme, tasks: listTrackTasks(slug) });
  }
  sendJson(res, 200, {
    tracks: out, agents: listAgents(),
    queue_size: queueCount(), valid_statuses: VALID_STATUSES,
    transitions: transitionsJson(),
  });
}

export function handleTask(res, tid) {
  const [p, fm, body] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  sendJson(res, 200, { ...fm, _body: body, _path: rel(p), _attachments: listAttachments(tid) || [] });
}

export function handleListAttachments(res, tid) {
  const items = listAttachments(tid);
  if (items === null) return sendJson(res, 404, { error: 'task not found' });
  sendJson(res, 200, { items });
}

export async function handleUploadAttachment(req, res, tid) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const r = saveAttachment(tid, body.name, body.dataBase64);
  if (r.error) return sendJson(res, r.code || 400, { error: r.error });
  sendJson(res, 200, r.item);
}

export function handleDeleteAttachment(res, tid, name) {
  const r = deleteAttachment(tid, name);
  if (r.error) return sendJson(res, r.code || 400, { error: r.error });
  sendJson(res, 200, { ok: true });
}

export function handleReadAttachment(res, tid, name) {
  const a = readAttachment(tid, name);
  if (!a) return sendJson(res, 404, { error: 'not found' });
  res.writeHead(200, {
    'Content-Type': a.type,
    'Content-Length': a.data.length,
    'Cache-Control': 'no-store',
  });
  res.end(a.data);
}

export async function handlePatch(req, res, tid) {
  const [p, fm, body] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  let patch;
  try { patch = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }

  if ('status' in patch) {
    const next = patch.status;
    const cur = fm.status || 'todo';
    if (!VALID_STATUSES.includes(next)) return sendJson(res, 400, { error: `invalid status ${next}` });
    if (next !== cur) {
      const allowed = ALLOWED_TRANSITIONS[cur] || new Set();
      if (!allowed.has(next)) return sendJson(res, 409, { error: `transition ${cur}->${next} not allowed` });
      if (next === 'in-progress') {
        const [ok, open] = depsSatisfied(fm.deps || []);
        if (!ok) return sendJson(res, 409, { error: `open deps: ${open.join(', ')}` });
      }
    }
    fm.status = next;
  }
  for (const k of ['assignee', 'estimate', 'title']) {
    if (k in patch) fm[k] = patch[k];
  }
  if ('deps' in patch) {
    let v = patch.deps;
    if (typeof v === 'string') v = v.split(',').map(s => s.trim()).filter(Boolean);
    fm.deps = v;
  }
  saveTask(p, fm, body);
  fm._path = rel(p);
  sendJson(res, 200, fm);
}

export function handleCancelDispatch(res, tid) {
  const [p, fm, body] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  const removed = deleteTrigger(tid);
  let reverted = false;
  if (fm.status === 'in-progress') {
    fm.status = 'todo';
    saveTask(p, fm, body);
    reverted = true;
  }
  if (!removed && !reverted) {
    return sendJson(res, 409, { error: 'nothing to stop: not queued and not in-progress' });
  }
  sendJson(res, 200, { stopped: true, task_id: tid, trigger_removed: removed, reverted_to_todo: reverted, queue_size: queueCount() });
}

export function handleDispatch(res, tid) {
  const [p, fm] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  if (fm.status !== 'todo') return sendJson(res, 409, { error: `can dispatch only todo tasks, current: ${fm.status}` });
  const assignee = fm.assignee || 'user';
  if (assignee === 'user') return sendJson(res, 409, { error: 'assignee=user, not dispatchable' });
  if (!listAgents().includes(assignee)) return sendJson(res, 409, { error: `agent '${assignee}' not registered in .claude/agents/` });
  const [ok, open] = depsSatisfied(fm.deps || []);
  if (!ok) return sendJson(res, 409, { error: `open deps: ${open.join(', ')}` });
  writeTrigger(tid, fm, p);
  sendJson(res, 200, { queued: true, task_id: tid, queue_size: queueCount() });
}

export function handleQueueStatus(res) {
  sendJson(res, 200, { size: queueCount(), items: queueItems() });
}
