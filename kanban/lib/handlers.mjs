import path from 'node:path';
import fs from 'node:fs';
import {
  VALID_STATUSES, ALLOWED_TRANSITIONS, ITER_STATUSES, transitionsJson,
  ROOT, WORKFLOW, TRACKS_DIR, ARCHIVE_DIR, AGENTS_DIR,
  trackDir, trackActiveFile, trackItersDir, iterDirFor,
} from './config.mjs';
import {
  closeIteration as runCloseIteration,
  getFinalizeInfo, finalizeIteration,
} from './iteration_close.mjs';
import {
  exists, readText, rel,
  listTrackSlugs, readTrack, writeTrackReadme, trackActive, setTrackActive,
  listIterations, findIteration, writeIterationReadme,
  activeIterations, highestTaskId, highestIterId,
  listTasksInIteration, listAllTasks,
  listAgents, findTask, saveTask, depsSatisfied, findDepCycle, getAgentModel,
} from './repo.mjs';
import { parseTask, serializeTask, replaceSection, appendToSection, parseChecklist, extractSection } from './frontmatter.mjs';
import { queueCount, queueItems, writeTrigger, deleteTrigger, popNextForAssignee, peekNextForAssignee, releaseExpectedFiles } from './queue.mjs';
import {
  createInstance, getInstance, listInstances, updateInstance,
  removeInstance, markExiting, markDead, claimTaskForInstance, releaseTask, pidAlive,
} from './instances.mjs';
import { sendJson, readBody, broadcastChange } from './http.mjs';
import { listAttachments, saveAttachment, deleteAttachment, readAttachment } from './attachments.mjs';
import { captureSnapshot, loadSnapshot, deleteSnapshot } from './snapshot.mjs';
import { commitInWorker } from './commit_queue.mjs';
import { recordRun, statsTotals, allTaskTotals } from './stats.mjs';
import { allIterStats } from './iter_stats.mjs';
import { logger } from './logger.mjs';
import { isUnityProject } from './project_kind.mjs';

const UNITY = isUnityProject(ROOT);
let unityVerifyWarned = false;
const STARTED_AT = new Date();

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

export function handleHealth(res) {
  sendJson(res, 200, {
    ok: true,
    started: STARTED_AT.toISOString(),
    uptime_sec: Math.floor((Date.now() - STARTED_AT.getTime()) / 1000),
    project: projectName(),
  });
}

// Common envelope: lists agents/queue/transitions so frontend keeps
// a single source of truth.
function envelope(extra = {}) {
  return {
    agents: listAgents(),
    queue_size: queueCount(),
    valid_statuses: VALID_STATUSES,
    iter_statuses: ITER_STATUSES,
    transitions: transitionsJson(),
    track_count: listTrackSlugs().length,
    ...extra,
  };
}

// GET /api/board[?track=<slug>]
// - track param: returns kanban for that track's active iteration
// - no param: aggregate kanban across all currently-active iterations
function attachStats(tasks) {
  const totals = allTaskTotals();
  for (const t of tasks) {
    if (totals[t.id]) t._stats = totals[t.id];
  }
  return tasks;
}

// Build { depId: status } for any deps referenced by `tasks` whose target
// task is NOT in the returned set. Resolved against ALL tasks in the repo
// so cross-track / cross-iteration deps don't show as unmet on the board.
function buildDepIndex(tasks) {
  const present = new Set(tasks.map(t => t.id));
  const needed = new Set();
  for (const t of tasks) {
    for (const d of (t.deps || [])) {
      if (!present.has(d)) needed.add(d);
    }
  }
  if (!needed.size) return {};
  const idx = {};
  for (const t of listAllTasks()) {
    if (needed.has(t.id)) idx[t.id] = t.status || 'todo';
  }
  return idx;
}

export function handleBoard(res, query = {}) {
  const want = query.track || null;
  if (want) {
    const t = readTrack(want);
    if (!t) return sendJson(res, 404, { error: `track not found: ${want}` });
    const aid = trackActive(want);
    if (!aid) return sendJson(res, 200, envelope({
      iteration: null, track: { slug: want, fm: t.fm, body: t.body },
      tasks: [], dep_index: {},
    }));
    const iter = findIteration(want, aid);
    const tasks = iter ? attachStats(listTasksInIteration(want, aid)) : [];
    return sendJson(res, 200, envelope({
      iteration: iter ? {
        id: iter.id, slug: iter.slug, dir: rel(iter.dir),
        readme: iter.body, fm: iter.fm, track: want, status: iter.status,
      } : null,
      track: { slug: want, fm: t.fm, body: t.body },
      tasks,
      dep_index: buildDepIndex(tasks),
    }));
  }
  // aggregate across active iterations
  const actives = activeIterations();
  const tasks = [];
  for (const iter of actives) tasks.push(...listTasksInIteration(iter.track, iter.id));
  const attached = attachStats(tasks);
  return sendJson(res, 200, envelope({
    iteration: null,
    actives: actives.map(it => ({ track: it.track, id: it.id, slug: it.slug, status: it.status })),
    tasks: attached,
    dep_index: buildDepIndex(attached),
  }));
}

// GET /api/tracks  — list of tracks with summary timeline
export function handleTracks(res) {
  const out = [];
  for (const slug of listTrackSlugs()) {
    const t = readTrack(slug);
    if (!t) continue;
    const iters = listIterations(slug).map(it => {
      const tasks = listTasksInIteration(slug, it.id);
      return {
        id: it.id, slug: it.slug, status: it.status, title: it.fm.title || '',
        fm: { title: it.fm.title, started: it.fm.started || '' },
        task_count: tasks.length,
        done_count: tasks.filter(x => x.status === 'done').length,
      };
    });
    out.push({
      slug, fm: t.fm, body: t.body, dir: rel(t.dir),
      active: trackActive(slug),
      iterations: iters,
    });
  }
  sendJson(res, 200, envelope({ tracks: out }));
}

// GET /api/track/:slug — single track full view
export function handleTrack(res, slug) {
  const t = readTrack(slug);
  if (!t) return sendJson(res, 404, { error: 'track not found' });
  const iters = listIterations(slug).map(it => ({
    id: it.id, slug: it.slug, status: it.status, title: it.fm.title || '',
    fm: it.fm, body: it.body,
    task_count: listTasksInIteration(slug, it.id).length,
  }));
  sendJson(res, 200, envelope({
    track: { slug, fm: t.fm, body: t.body, dir: rel(t.dir) },
    active: trackActive(slug),
    iterations: iters,
  }));
}

// POST /api/tracks  body: { slug, title, body }
export async function handleTrackCreate(req, res) {
  let p; try { p = await readBody(req); } catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const slug = String(p.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return sendJson(res, 400, { error: 'slug must be kebab-case alnum' });
  if (exists(trackDir(slug))) return sendJson(res, 409, { error: `track exists: ${slug}` });
  const fm = {
    slug,
    title: String(p.title || '').trim() || slug,
    status: 'active',
    started: new Date().toISOString().slice(0, 10),
  };
  const body = '\n# Track ' + (fm.title || slug) + '\n\n' + (p.body || '## Цель\n\n## Scope\n\n## Заметки\n');
  writeTrackReadme(slug, fm, body);
  fs.mkdirSync(trackItersDir(slug), { recursive: true });
  sendJson(res, 200, { ok: true, slug });
}

// PATCH /api/track/:slug  body: { title?, body?, status? }
export async function handleTrackUpdate(req, res, slug) {
  const t = readTrack(slug);
  if (!t) return sendJson(res, 404, { error: 'track not found' });
  let p; try { p = await readBody(req); } catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const fm = { ...t.fm };
  if ('title' in p) fm.title = String(p.title || '');
  if ('status' in p) {
    if (!['active', 'archived'].includes(p.status)) return sendJson(res, 400, { error: 'status: active|archived' });
    fm.status = p.status;
  }
  const newBody = 'body' in p ? String(p.body || '') : t.body;
  writeTrackReadme(slug, fm, newBody);
  sendJson(res, 200, { ok: true });
}

// DELETE /api/track/:slug — archive (move to .workflow/archive/tracks/<slug>-<ts>)
export function handleTrackDelete(res, slug) {
  const src = trackDir(slug);
  if (!exists(src)) return sendJson(res, 404, { error: 'track not found' });
  fs.mkdirSync(path.join(ARCHIVE_DIR, 'tracks'), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dst = path.join(ARCHIVE_DIR, 'tracks', `${slug}-${ts}`);
  fs.renameSync(src, dst);
  sendJson(res, 200, { ok: true, archived_to: rel(dst) });
}

// POST /api/track/:slug/iterations  body: { slug, title, body?, status? }
export async function handleIterCreate(req, res, trackSlug) {
  const t = readTrack(trackSlug);
  if (!t) return sendJson(res, 404, { error: 'track not found' });
  let p; try { p = await readBody(req); } catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const iterSlug = String(p.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(iterSlug)) return sendJson(res, 400, { error: 'iter slug must be kebab-case' });
  const status = p.status || 'planned';
  if (!ITER_STATUSES.includes(status)) return sendJson(res, 400, { error: `status: ${ITER_STATUSES.join('|')}` });
  const id = String(highestIterId(trackSlug) + 1).padStart(3, '0');
  const fm = {
    id, slug: iterSlug, track: trackSlug, status,
    title: String(p.title || '').trim() || iterSlug,
    started: new Date().toISOString().slice(0, 10),
  };
  const body = String(p.body || '').trim()
    ? '\n' + p.body
    : `\n# Iteration ${id} — ${fm.title}\n\n## Цель\n(одно-два предложения)\n\n## Scope\nЧто входит:\n- ...\nЧто НЕ входит:\n- ...\n\n## Exit criteria\n- [ ] Все таски done\n- [ ] ...\n\n## Заметки\n`;
  // If created as 'active', demote any existing active iter and set ACTIVE pointer.
  if (status === 'active') {
    for (const other of listIterations(trackSlug)) {
      if (other.status === 'active') {
        const fm2 = { ...other.fm, status: 'done' };
        writeIterationReadme(trackSlug, other.id, other.slug, fm2, other.body);
      }
    }
  }
  writeIterationReadme(trackSlug, id, iterSlug, fm, body);
  if (status === 'active') setTrackActive(trackSlug, id);
  sendJson(res, 200, { ok: true, id, slug: iterSlug });
}

// PATCH /api/track/:slug/iteration/:id   body: { title?, body?, status?, slug? }
export async function handleIterUpdate(req, res, trackSlug, iterId) {
  const it = findIteration(trackSlug, iterId);
  if (!it) return sendJson(res, 404, { error: 'iteration not found' });
  let p; try { p = await readBody(req); } catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const fm = { ...it.fm };
  if ('title' in p) fm.title = String(p.title || '');
  if ('status' in p) {
    if (!ITER_STATUSES.includes(p.status)) return sendJson(res, 400, { error: `status: ${ITER_STATUSES.join('|')}` });
    fm.status = p.status;
  }
  let body = 'body' in p ? String(p.body || '') : it.body;

  let newSlug = it.slug;
  if ('slug' in p && p.slug && p.slug !== it.slug) {
    newSlug = String(p.slug).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(newSlug)) return sendJson(res, 400, { error: 'iter slug must be kebab-case' });
    fm.slug = newSlug;
  }
  if (newSlug !== it.slug) {
    const newDir = iterDirFor(trackSlug, iterId, newSlug);
    fs.renameSync(it.dir, newDir);
  }
  writeIterationReadme(trackSlug, iterId, newSlug, fm, body);
  sendJson(res, 200, { ok: true });
}

// POST /api/track/:slug/iteration/:id/activate
export function handleIterActivate(res, trackSlug, iterId) {
  const it = findIteration(trackSlug, iterId);
  if (!it) return sendJson(res, 404, { error: 'iteration not found' });
  // Set this iteration's status to active, demote any other active iter in same track to done.
  for (const other of listIterations(trackSlug)) {
    if (other.id === iterId) continue;
    if (other.status === 'active') {
      const fm2 = { ...other.fm, status: 'done' };
      writeIterationReadme(trackSlug, other.id, other.slug, fm2, other.body);
    }
  }
  const fm = { ...it.fm, status: 'active' };
  writeIterationReadme(trackSlug, it.id, it.slug, fm, it.body);
  setTrackActive(trackSlug, iterId);
  sendJson(res, 200, { ok: true, active: iterId });
}

// POST /api/track/:slug/iteration/:id/archive  body: { status: 'done'|'abandoned' }
export async function handleIterArchive(req, res, trackSlug, iterId) {
  const it = findIteration(trackSlug, iterId);
  if (!it) return sendJson(res, 404, { error: 'iteration not found' });
  let p = {}; try { p = await readBody(req); } catch {}
  const status = p.status || 'done';
  if (!['done', 'abandoned'].includes(status)) return sendJson(res, 400, { error: 'status: done|abandoned' });
  const fm = { ...it.fm, status };
  writeIterationReadme(trackSlug, it.id, it.slug, fm, it.body);
  if (trackActive(trackSlug) === iterId) setTrackActive(trackSlug, '');
  sendJson(res, 200, { ok: true });
}

// DELETE /api/track/:slug/iteration/:id — only allowed for planned (no tasks)
export function handleIterDelete(res, trackSlug, iterId) {
  const it = findIteration(trackSlug, iterId);
  if (!it) return sendJson(res, 404, { error: 'iteration not found' });
  if (it.status !== 'planned') return sendJson(res, 409, { error: 'can delete only planned iterations' });
  const tasks = listTasksInIteration(trackSlug, iterId);
  if (tasks.length) return sendJson(res, 409, { error: `iteration has ${tasks.length} tasks; remove them first` });
  fs.rmSync(it.dir, { recursive: true, force: true });
  if (trackActive(trackSlug) === iterId) setTrackActive(trackSlug, '');
  sendJson(res, 200, { ok: true });
}

// POST /api/track/:slug/iterations/reorder  body: { order: [iterId,…] }
// Renumbers iterations to match the given order. Renames directories.
// Only iterations in the provided list are renumbered; others get appended in
// their existing order. All affected task `iteration:` frontmatter is rewritten.
export async function handleIterReorder(req, res, trackSlug) {
  if (!readTrack(trackSlug)) return sendJson(res, 404, { error: 'track not found' });
  let p; try { p = await readBody(req); } catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const order = Array.isArray(p.order) ? p.order : null;
  if (!order || !order.length) return sendJson(res, 400, { error: 'order: [iter_id,…] required' });
  const iters = listIterations(trackSlug);
  const idIdx = new Map(iters.map(it => [it.id, it]));
  const seen = new Set();
  const final = [];
  for (const id of order) {
    const it = idIdx.get(id);
    if (!it || seen.has(id)) continue;
    final.push(it); seen.add(id);
  }
  // append unmentioned iterations in original order
  for (const it of iters) if (!seen.has(it.id)) final.push(it);

  // Rename to staging suffix to avoid collisions, then to final id.
  const stagedNames = [];
  for (let i = 0; i < final.length; i++) {
    const it = final[i];
    const newId = String(i + 1).padStart(3, '0');
    const stagingDir = path.join(trackItersDir(trackSlug), `__tmp_${newId}-${it.slug}`);
    fs.renameSync(it.dir, stagingDir);
    stagedNames.push({ stagingDir, finalDir: iterDirFor(trackSlug, newId, it.slug), newId, it });
  }
  // remember active id for remap
  const activeBefore = trackActive(trackSlug);
  let activeAfter = '';
  for (const s of stagedNames) {
    fs.renameSync(s.stagingDir, s.finalDir);
    // rewrite README + tasks
    const readmePath = path.join(s.finalDir, 'README.md');
    if (exists(readmePath)) {
      const [fm, body] = parseTask(readText(readmePath));
      const fm2 = { ...(fm || {}), id: s.newId, slug: s.it.slug, track: trackSlug };
      fs.writeFileSync(readmePath, serializeTask(fm2, body || ''), 'utf-8');
    }
    const td = path.join(s.finalDir, 'tasks');
    if (exists(td)) {
      for (const tf of fs.readdirSync(td)) {
        if (!tf.endsWith('.md')) continue;
        const tp = path.join(td, tf);
        const [tfm, tb] = parseTask(readText(tp));
        if (!tfm) continue;
        tfm.iteration = s.newId;
        tfm.track = trackSlug;
        fs.writeFileSync(tp, serializeTask(tfm, tb || ''), 'utf-8');
      }
    }
    if (activeBefore === s.it.id) activeAfter = s.newId;
  }
  if (activeAfter) setTrackActive(trackSlug, activeAfter);
  sendJson(res, 200, { ok: true, order: stagedNames.map(s => s.newId) });
}

// POST /api/track/:slug/iteration/:id/tasks  body: { title, assignee, deps?, estimate? }
export async function handleTaskCreate(req, res, trackSlug, iterId) {
  const it = findIteration(trackSlug, iterId);
  if (!it) return sendJson(res, 404, { error: 'iteration not found' });
  let p; try { p = await readBody(req); } catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const title = String(p.title || '').trim();
  if (!title) return sendJson(res, 400, { error: 'title required' });
  const assignee = String(p.assignee || 'user').trim();
  const estimate = String(p.estimate || 'M').trim().toUpperCase();
  if (!['S', 'M', 'L'].includes(estimate)) return sendJson(res, 400, { error: 'estimate must be S, M, or L' });
  let deps = Array.isArray(p.deps) ? p.deps : (typeof p.deps === 'string' ? p.deps.split(',').map(s => s.trim()).filter(Boolean) : []);
  const id = 'T' + String(highestTaskId() + 1).padStart(3, '0');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'task';
  const fm = {
    id, title, iteration: iterId, track: trackSlug,
    assignee, status: 'todo', attempts: 0, deps, estimate,
  };
  const body = '\n## Goal\n\n## Context\n\n## Acceptance criteria\n- [ ] \n\n## How to verify\n\n## Subtasks\n\n## Notes\n';
  const td = path.join(it.dir, 'tasks');
  fs.mkdirSync(td, { recursive: true });
  fs.writeFileSync(path.join(td, `${id}-${slug}.md`), serializeTask(fm, body), 'utf-8');
  sendJson(res, 200, { ok: true, id });
}

// GET /api/task/:id[?view=full|slim|brief|notes]
//
// view=full   (default for backward compat) — frontmatter + body + parsed sections + attachments
// view=slim   — frontmatter + non-empty parsed sections; no _body, no _attachments, no Notes
// view=brief  — minimum needed by an agent to start work: id/title/status/attempts/deps/goal/criteria/subtasks
// view=notes  — { notes } only
export function handleTask(res, tid, query = {}) {
  const view = query.view || 'full';
  if (typeof tid !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*\d+$/.test(tid)) {
    return sendJson(res, 400, { error: 'malformed task id' });
  }
  const [p, fm, body] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });

  const goal       = extractSection(body, 'Goal');
  const context    = extractSection(body, 'Context');
  const acceptance = extractSection(body, 'Acceptance criteria');
  const verify     = extractSection(body, 'How to verify');
  const notes      = extractSection(body, 'Notes');
  const subtasks = parseChecklist(body, 'Subtasks');
  const criteria = parseChecklist(body, 'Acceptance criteria');

  if (view === 'notes') return sendJson(res, 200, { id: fm.id, notes });

  if (view === 'brief') {
    const out = {
      id: fm.id, title: fm.title, status: fm.status,
      attempts: Number(fm.attempts || 0),
      assignee: fm.assignee, deps: fm.deps || [],
      iteration: fm.iteration || null, track: fm.track || null,
      _path: rel(p),
      goal, criteria, subtasks,
      verify, // verification steps for the agent's awareness
    };
    if (context) out.context = context;
    // Hint: auto_verify=true means the server auto-approves the agent's
    // submit and commits without waiting for the user.
    if (fm.auto_verify === 'true' || fm.auto_verify === true) out.auto_verify = true;
    if (Array.isArray(fm.expected_files) && fm.expected_files.length) out.expected_files = fm.expected_files;
    if (fm.unity_verify === 'true' || fm.unity_verify === true) {
      if (UNITY) out.unity_verify = true;
      else if (!unityVerifyWarned) { logger.warn('handlers', 'unity_verify ignored — not a Unity project'); unityVerifyWarned = true; }
    }
    return sendJson(res, 200, out);
  }

  // slim — what the verify panel and most internal callers need
  if (view === 'slim') {
    const out = {
      ...fm, _path: rel(p),
      _subtasks: subtasks, _criteria: criteria,
    };
    if (goal) out._goal = goal;
    if (context) out._context = context;
    if (acceptance) out._acceptance = acceptance;
    if (verify) out._verify = verify;
    // attachments and full notes deliberately omitted
    return sendJson(res, 200, out);
  }

  // full — legacy shape for the kanban modal which expects everything
  const totals = statsTotals(tid);
  sendJson(res, 200, {
    ...fm, _body: body, _path: rel(p),
    _attachments: listAttachments(tid) || [],
    _subtasks: subtasks, _criteria: criteria,
    _goal: goal, _context: context, _acceptance: acceptance, _verify: verify, _notes: notes,
    ...(totals ? { _stats: totals } : {}),
  });
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
      if (next === 'queued' || next === 'in-progress') {
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
  if ('auto_dispatch' in patch) {
    if (patch.auto_dispatch) fm.auto_dispatch = true;
    else delete fm.auto_dispatch;
  }
  let nextBody = body;
  if ('body' in patch && typeof patch.body === 'string') nextBody = patch.body;
  saveTask(p, fm, nextBody);
  fm._path = rel(p);
  if (fm.status === 'done') {
    try { releasePendingDispatch(); } catch {}
  }
  sendJson(res, 200, fm);
}

// ─── Agents ───────────────────────────────────────────────────────────────

function agentPath(slug) { return path.join(AGENTS_DIR, `${slug}.md`); }

function readAgent(slug) {
  const p = agentPath(slug);
  if (!exists(p)) return null;
  const text = readText(p);
  const [fm, body] = parseTask(text);
  return { slug, fm: fm || {}, body: body || '', path: rel(p) };
}

// GET /api/agents — list with frontmatter
export function handleAgentsList(res) {
  const out = [];
  for (const slug of listAgents()) {
    const a = readAgent(slug);
    if (a) out.push({ slug: a.slug, description: a.fm.description || '', model: a.fm.model || '', tools: a.fm.tools || '', body: a.body });
  }
  sendJson(res, 200, { agents: out });
}

// GET /api/agent/:slug
export function handleAgent(res, slug) {
  const a = readAgent(slug);
  if (!a) return sendJson(res, 404, { error: 'agent not found' });
  sendJson(res, 200, a);
}

// POST /api/agents  body: { slug, description?, model?, tools?, body? }
export async function handleAgentCreate(req, res) {
  let p; try { p = await readBody(req); } catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const slug = String(p.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return sendJson(res, 400, { error: 'slug must be kebab-case' });
  const target = agentPath(slug);
  if (exists(target)) return sendJson(res, 409, { error: `agent exists: ${slug}` });
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const fm = {
    name: slug,
    description: String(p.description || '').trim(),
    model: String(p.model || 'inherit').trim(),
  };
  if (p.tools != null) fm.tools = String(p.tools);
  const body = String(p.body || `# ${slug}\n\n(role description)\n`);
  fs.writeFileSync(target, serializeTask(fm, body), 'utf-8');
  sendJson(res, 200, { ok: true, slug });
}

// PATCH /api/agent/:slug  body: { description?, model?, tools?, body? }
export async function handleAgentUpdate(req, res, slug) {
  const a = readAgent(slug);
  if (!a) return sendJson(res, 404, { error: 'agent not found' });
  let p; try { p = await readBody(req); } catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const fm = { ...a.fm };
  if ('description' in p) fm.description = String(p.description || '');
  if ('model' in p)       fm.model       = String(p.model || '');
  if ('tools' in p) {
    if (p.tools == null || p.tools === '') delete fm.tools;
    else fm.tools = String(p.tools);
  }
  const body = 'body' in p ? String(p.body || '') : a.body;
  fs.writeFileSync(agentPath(slug), serializeTask(fm, body), 'utf-8');
  sendJson(res, 200, { ok: true });
}

// DELETE /api/agent/:slug — remove the agent file (refuses if any task uses it)
export function handleAgentDelete(res, slug) {
  if (!exists(agentPath(slug))) return sendJson(res, 404, { error: 'agent not found' });
  const inUse = listAllTasks().filter(t => t.assignee === slug).map(t => t.id);
  if (inUse.length) return sendJson(res, 409, { error: `agent assigned to: ${inUse.slice(0, 5).join(', ')}${inUse.length > 5 ? ' …' : ''}` });
  fs.rmSync(agentPath(slug), { force: true });
  sendJson(res, 200, { ok: true });
}

// DELETE /api/task/:id — remove the task file. Refuses if there are dependents.
export function handleTaskDelete(res, tid) {
  const [p, fm] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  // dependents
  const blockers = [];
  for (const t of listAllTasks()) {
    if (Array.isArray(t.deps) && t.deps.includes(tid)) blockers.push(t.id);
  }
  if (blockers.length) {
    return sendJson(res, 409, { error: `${tid} is a dep of: ${blockers.join(', ')}` });
  }
  // remove queue trigger if any
  deleteTrigger(tid);
  fs.rmSync(p, { force: true });
  sendJson(res, 200, { ok: true, deleted: tid });
}

export function handleCancelDispatch(res, tid) {
  const [p, fm, body] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  const removed = deleteTrigger(tid);
  let reverted = false;
  let cleared = false;
  if ('auto_dispatch' in fm) { delete fm.auto_dispatch; cleared = true; }
  if (fm.status === 'queued' || fm.status === 'in-progress') {
    fm.status = 'todo';
    reverted = true;
  }
  if (reverted || cleared) saveTask(p, fm, body);
  if (!removed && !reverted && !cleared) {
    return sendJson(res, 409, { error: 'nothing to stop: not queued, in-progress, or pending' });
  }
  sendJson(res, 200, { stopped: true, task_id: tid, trigger_removed: removed, reverted_to_todo: reverted, pending_cleared: cleared, queue_size: queueCount() });
}

// Internal: try to dispatch one task. Returns { ok, error?, code? } so batch
// callers (handleIterStart) can keep going past skippable failures.
function _dispatchInternal(tid) {
  const [p, fm, body] = findTask(tid);
  if (!p) return { ok: false, code: 404, error: 'task not found' };
  if (fm.status !== 'todo') return { ok: false, code: 409, error: `status is ${fm.status}, not todo` };
  const assignee = fm.assignee || 'user';
  if (assignee === 'user') return { ok: false, code: 409, error: 'assignee=user, not dispatchable' };
  if (!listAgents().includes(assignee)) return { ok: false, code: 409, error: `agent '${assignee}' not registered` };
  const [okDeps, open] = depsSatisfied(fm.deps || []);
  if (!okDeps) return { ok: false, code: 409, error: `open deps: ${open.join(', ')}` };
  const cycle = findDepCycle(tid);
  if (cycle.length) return { ok: false, code: 409, error: `circular dep: ${cycle.join(' → ')}` };
  fm.status = 'queued';
  if ('auto_dispatch' in fm) delete fm.auto_dispatch;
  saveTask(p, fm, body);
  writeTrigger(tid, fm, p, { reason: 'dispatch' });
  return { ok: true };
}

// Scan tasks flagged for auto-dispatch (queued by handleIterStart but blocked
// on deps at start time). Dispatch any whose deps are now satisfied. Called
// after a task transitions to 'done' so a freshly-completed dep cascades.
function releasePendingDispatch() {
  const released = [];
  for (const t of listAllTasks()) {
    if (t.status !== 'todo') continue;
    if (!(t.auto_dispatch === true || t.auto_dispatch === 'true')) continue;
    const [okDeps] = depsSatisfied(t.deps || []);
    if (!okDeps) continue;
    const r = _dispatchInternal(t.id);
    if (r.ok) released.push(t.id);
  }
  if (released.length) {
    broadcastChange('change', { kind: 'auto_dispatch', task_ids: released });
  }
  return released;
}

export function handleDispatch(res, tid) {
  const r = _dispatchInternal(tid);
  if (!r.ok) return sendJson(res, r.code || 500, { error: r.error });
  sendJson(res, 200, { queued: true, task_id: tid, queue_size: queueCount() });
}

// POST /api/track/:slug/iteration/:id/start
// Bulk-dispatch every todo task in the iteration that is assigned to a real
// agent. Tasks with open deps or other validation errors are skipped (not
// fatal — the user can fix them and re-run). Returns per-task outcome so the
// UI can show what was queued and what was skipped.
export async function handleIterStart(req, res, trackSlug, iterId) {
  const it = findIteration(trackSlug, iterId);
  if (!it) return sendJson(res, 404, { error: 'iteration not found' });
  let payload = {}; try { payload = await readBody(req); } catch {}
  const force = !!payload.force;
  // Refuse a re-run unless force=true. The `started` timestamp doubles as
  // both the run marker and the human-facing "started at" label.
  const prevStarted = it.fm?.started || '';
  if (prevStarted && !force) {
    return sendJson(res, 409, {
      error: 'iteration already started',
      started: prevStarted,
      hint: 'pass { "force": true } to re-dispatch (e.g. after adding new tasks)',
    });
  }
  const tasks = listTasksInIteration(trackSlug, iterId);
  const agents = listAgents();
  const queued = [];
  const pending = [];
  const skipped = [];
  for (const t of tasks) {
    if (t.status !== 'todo') { skipped.push({ id: t.id, reason: `status=${t.status}` }); continue; }
    if (!t.assignee || t.assignee === 'user') { skipped.push({ id: t.id, reason: 'assignee=user' }); continue; }
    if (!agents.includes(t.assignee)) { skipped.push({ id: t.id, reason: `agent '${t.assignee}' not registered` }); continue; }
    const cycle = findDepCycle(t.id);
    if (cycle.length) { skipped.push({ id: t.id, reason: `circular dep: ${cycle.join(' → ')}` }); continue; }
    const [okDeps, open] = depsSatisfied(t.deps || []);
    if (!okDeps) {
      // Hold for auto-dispatch — released when its deps complete.
      const [p, fm, body] = findTask(t.id);
      if (!p) { skipped.push({ id: t.id, reason: 'task vanished' }); continue; }
      fm.auto_dispatch = true;
      saveTask(p, fm, body);
      pending.push({ id: t.id, waiting_on: open });
      continue;
    }
    const r = _dispatchInternal(t.id);
    if (r.ok) queued.push(t.id);
    else skipped.push({ id: t.id, reason: r.error });
  }
  // Stamp the iteration as started so the UI can hide the button and so a
  // subsequent call without `force` is rejected. Idempotent — re-run with
  // force=true keeps the original timestamp as `restarted` audit trail.
  try {
    const readmePath = path.join(it.dir, 'README.md');
    if (exists(readmePath)) {
      const [fm, body] = parseTask(readText(readmePath));
      if (fm) {
        const now = new Date().toISOString();
        if (!fm.started) fm.started = now;
        else fm.restarted = now;
        fs.writeFileSync(readmePath, serializeTask(fm, body || ''), 'utf-8');
      }
    }
  } catch (e) { logger.warn('kanban', `mark iteration started: ${e.message}`); }

  sendJson(res, 200, {
    queued, pending, skipped, queue_size: queueCount(),
    forced: force,
  });
}

export function handleQueueStatus(res) {
  sendJson(res, 200, { size: queueCount(), items: queueItems() });
}

// ---------- Verification ----------

function fmtDate() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function buildRejectBlock(attempt, items, summary) {
  const lines = [];
  lines.push(`### Reject — attempt ${attempt} — ${fmtDate()}`);
  if (summary && summary.trim()) {
    lines.push('');
    lines.push(summary.trim());
  }
  if (items && items.length) {
    lines.push('');
    lines.push('Failed criteria:');
    for (const it of items) {
      const t = it.text || it.criterion || '';
      const note = (it.note || '').trim();
      lines.push(`- [ ] ${t}${note ? ` — ${note}` : ''}`);
    }
  }
  return lines.join('\n');
}

function buildApproveBlock(attempt, summary) {
  const lines = [`### Approve — attempt ${attempt} — ${fmtDate()}`];
  if (summary && summary.trim()) { lines.push(''); lines.push(summary.trim()); }
  return lines.join('\n');
}

export async function handleVerify(req, res, tid) {
  const [p, fm, body] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  const verifiable = new Set(['verifying', 'in-progress', 'queued']);
  if (!verifiable.has(fm.status)) {
    return sendJson(res, 409, { error: `can verify only ${[...verifiable].join('/')} tasks, current: ${fm.status}` });
  }
  let payload;
  try { payload = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }

  const decision = payload.decision; // 'approve' | 'reject'
  const items = Array.isArray(payload.items) ? payload.items : [];
  const summary = payload.summary || '';

  if (decision !== 'approve' && decision !== 'reject') {
    return sendJson(res, 400, { error: `decision must be approve|reject` });
  }
  if (decision === 'reject' && !summary.trim()) {
    return sendJson(res, 400, { error: 'reject requires a non-empty note explaining what is wrong' });
  }

  const failed = items.filter(it => it.pass === false);
  const effective = decision;

  const attempt = Number(fm.attempts || 0) + (effective === 'reject' ? 1 : 0);

  if (effective === 'reject') {
    fm.attempts = attempt;
    fm.status = 'queued';
    const block = buildRejectBlock(attempt, failed, summary);
    const newBody = appendToSection(body, 'Notes', block);
    saveTask(p, fm, newBody);
    // Re-queue to same agent with rework notes.
    writeTrigger(tid, fm, p, { reason: 'rework', reworkNotes: block });
    return sendJson(res, 200, { result: 'rework', attempts: attempt, status: fm.status });
  }

  // approve: write note, then run commit+push in background.
  // Attempt N = the N-th verification round (always = past rejects + 1),
  // matching the UI header and the reject-block numbering.
  const block = buildApproveBlock((fm.attempts || 0) + 1, summary);
  const newBody = appendToSection(body, 'Notes', block);
  saveTask(p, fm, newBody);

  // Respond immediately so the UI does not block on git.
  sendJson(res, 202, { result: 'committing', task_id: tid });

  // Run commit/push asynchronously; persist + broadcast when done.
  setImmediate(async () => {
    try {
      const git = await runCommitPush(p, fm, summary);
      // Re-read latest body in case anything else mutated it.
      const cur = findTask(tid);
      if (!cur[0]) return;
      let curFm = cur[1];
      let curBody = cur[2];

      if (git.error && !git.commit) {
        const errBlock = `### Commit failed — ${fmtDate()}\n\n${git.error}`;
        curBody = appendToSection(curBody, 'Notes', errBlock);
        saveTask(cur[0], curFm, curBody);
        broadcastChange('change', { kind: 'verify', task_id: tid, result: 'commit_failed' });
        return;
      }
      if (git.error) {
        const warnBlock = `### Push failed — ${fmtDate()}\n\n${git.error}\n\nLocal commit ${git.commit?.slice(0, 7) || ''} is in place; push manually.`;
        curBody = appendToSection(curBody, 'Notes', warnBlock);
      }
      curFm.status = 'done';
      saveTask(cur[0], curFm, curBody);
      broadcastChange('change', { kind: 'verify', task_id: tid, result: 'done', commit: git.commit });
      try { releasePendingDispatch(); } catch {}
    } catch (e) {
      try {
        const cur = findTask(tid);
        if (cur[0]) {
          const errBlock = `### Commit failed — ${fmtDate()}\n\n${String(e.message || e)}`;
          const errBody = appendToSection(cur[2], 'Notes', errBlock);
          saveTask(cur[0], cur[1], errBody);
          broadcastChange('change', { kind: 'verify', task_id: tid, result: 'commit_failed' });
        }
      } catch {}
    }
  });
}

// Collect snapshots of this task + all other still-active tasks. Path
// resolution against current dirty tree happens inside the worker — that way
// it's serialised with the commit (no race against parallel commits) and the
// main event loop never blocks on git status/hash-object.
function collectOtherTidsForCommit(tid) {
  const others = [];
  for (const t of listAllTasks()) {
    if (t.id === tid) continue;
    if (t.status !== 'in-progress' && t.status !== 'verifying') continue;
    others.push(t.id);
  }
  return others;
}

async function runCommitPush(taskPath, fm, summary) {
  try {
    const tid = fm.id;
    const title = fm.title || tid;
    const author = fm.assignee && fm.assignee !== 'user'
      ? `${fm.assignee} <${fm.assignee}@workflow.local>`
      : null;

    const otherTids = collectOtherTidsForCommit(tid);
    // Worker re-reads snapshots at job-processing time. Critical when multiple
    // verifies queue near-simultaneously: by the time job N runs, snapshots
    // for tasks 1..N-1 are already deleted (committed). Reading fresh prevents
    // a stale empty-tree snapshot from claiming every dirty path and leaving
    // job N with "no changes".
    const message = `${tid}: ${title}\n\n${summary || ''}`.trim();
    const result = await commitInWorker({
      tid, otherTids,
      message, author, push: true,
    });
    logger.info('commit', `tid=${tid} ok=${result.ok} commit=${result.commit || ''} note=${result.note || ''} err=${result.error || ''}`);

    if (!result.ok && !result.commit) {
      // Pure failure — leave snapshot in place so a retry can re-resolve paths.
      return { error: result.error || 'commit failed' };
    }
    if (result.commit) deleteSnapshot(tid);
    // No-changes note: keep snapshot. If user later does real work and verifies
    // again, the diff is meaningful instead of silently empty.
    else if (result.note) return { commit: null, note: result.note };
    // Worker may report ok:true with both `commit` and `error` (push failed).
    return result.error
      ? { commit: result.commit || null, error: result.error }
      : { commit: result.commit || null };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// Server-side commit-and-finish for auto-verified tasks. Reuses the same
// commit pipeline that handleVerify (manual approve) runs, but the task is
// already approved by virtue of auto-verify passing. Always runs async so
// the agent's MCP call doesn't block on git.
async function commitAndFinish(tid, summary) {
  try {
    const cur = findTask(tid);
    if (!cur[0]) return;
    let curFm = cur[1];
    let curBody = cur[2];

    const git = await runCommitPush(cur[0], curFm, summary || '');

    if (git.error && !git.commit) {
      const errBlock = `### Commit failed — ${fmtDate()}\n\n${git.error}`;
      curBody = appendToSection(curBody, 'Notes', errBlock);
      saveTask(cur[0], curFm, curBody);
      broadcastChange('change', { kind: 'auto_verify', task_id: tid, result: 'commit_failed' });
      return;
    }
    if (git.error) {
      const warnBlock = `### Push failed — ${fmtDate()}\n\n${git.error}\n\nLocal commit ${git.commit?.slice(0, 7) || ''} is in place; push manually.`;
      curBody = appendToSection(curBody, 'Notes', warnBlock);
    }
    curFm.status = 'done';
    saveTask(cur[0], curFm, curBody);
    broadcastChange('change', { kind: 'auto_verify', task_id: tid, result: 'done', commit: git.commit });
    try { releasePendingDispatch(); } catch {}
  } catch (e) {
    try {
      const cur = findTask(tid);
      if (cur[0]) {
        const errBlock = `### Commit failed — ${fmtDate()}\n\n${String(e.message || e)}`;
        const errBody = appendToSection(cur[2], 'Notes', errBlock);
        saveTask(cur[0], cur[1], errBody);
        broadcastChange('change', { kind: 'auto_verify', task_id: tid, result: 'commit_failed' });
      }
    } catch {}
  }
}

// ---------- Agent-facing endpoints (also reachable via MCP) ----------

// Internal helper — performs the claim transition + snapshot. Does not write HTTP.
// Returns { ok, fm, error?, code? }.
export function _claimTaskInternal(tid) {
  const [p, fm, body] = findTask(tid);
  if (!p) return { ok: false, code: 404, error: 'task not found' };
  if (fm.status !== 'queued' && fm.status !== 'in-progress') {
    return { ok: false, code: 409, error: `can claim only queued, current: ${fm.status}` };
  }
  const wasInProgress = fm.status === 'in-progress';
  fm.status = 'in-progress';
  // Stale fields from the worktree era — strip on claim so re-claims can't
  // rehydrate dead state from old frontmatter.
  if ('worktree_path' in fm) delete fm.worktree_path;
  if ('worktree_branch' in fm) delete fm.worktree_branch;
  saveTask(p, fm, body);
  if (!wasInProgress && !loadSnapshot(tid)) {
    try { captureSnapshot(tid); } catch (e) { logger.error('kanban', `snapshot failed for ${tid}`, e); }
  }
  deleteTrigger(tid);
  return { ok: true, fm, path: p, body };
}

export async function handleClaim(req, res, tid) {
  const r = _claimTaskInternal(tid);
  if (!r.ok) return sendJson(res, r.code, { error: r.error });
  return sendJson(res, 200, { ok: true, task_id: tid, status: r.fm.status, attempts: r.fm.attempts || 0 });
}

export async function handleSubmitVerify(req, res, tid) {
  const [p, fm, body] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  if (fm.status !== 'in-progress') {
    return sendJson(res, 409, { error: `can submit only in-progress, current: ${fm.status}` });
  }
  let payload = {};
  try { payload = await readBody(req); } catch {}
  const summary = (payload.summary || '').trim();
  let newBody = body;
  if (summary) {
    const block = `### Submit — attempt ${Number(fm.attempts || 0)} — ${fmtDate()}\n\n${summary}`;
    newBody = appendToSection(body, 'Notes', block);
  }
  fm.status = 'verifying';
  saveTask(p, fm, newBody);
  // If submitted by a known instance, release the task slot so its loop can pull next.
  const inst = payload.instance_id ? getInstance(payload.instance_id) : null;
  if (inst && inst.current_task_id === tid) {
    releaseTask(inst.id);
    // PreCompact happened mid-task and we deferred — now is the time to exit.
    if (inst.respawn_after_submit) {
      updateInstance(inst.id, { respawn_requested: true, respawn_after_submit: false });
      markExiting(inst.id, 'deferred_precompact');
    }
  }
  // Auto-verify tasks: server immediately approves and runs commit+push,
  // landing the task at done without waiting for user review. Manual tasks
  // sit at verifying until the user approves through the kanban panel.
  const isAuto = fm.auto_verify === 'true' || fm.auto_verify === true;
  if (isAuto) {
    setImmediate(() => commitAndFinish(tid, summary));
    return sendJson(res, 202, { ok: true, status: 'auto-approving', task_id: tid });
  }
  return sendJson(res, 200, { ok: true, status: fm.status });
}

export async function handleAppendNote(req, res, tid) {
  const [p, fm, body] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  let payload;
  try { payload = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const text = (payload.text || '').trim();
  if (!text) return sendJson(res, 400, { error: 'text required' });
  const newBody = appendToSection(body, 'Notes', text);
  saveTask(p, fm, newBody);
  return sendJson(res, 200, { ok: true });
}

export async function handleSubtasks(req, res, tid) {
  const [p, fm, body] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  let payload;
  try { payload = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const items = Array.isArray(payload.items) ? payload.items : null;
  if (!items) return sendJson(res, 400, { error: 'items: [{text, checked}] required' });
  const lines = items.map(it => `- [${it.checked ? 'x' : ' '}] ${String(it.text || '').replace(/\n/g, ' ')}`);
  const newBody = replaceSection(body, 'Subtasks', lines.join('\n'));
  saveTask(p, fm, newBody);
  return sendJson(res, 200, { ok: true, count: items.length, done: items.filter(i => i.checked).length });
}

export async function handleRecordStats(req, res, tid) {
  let payload;
  try { payload = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const sessionId = String(payload.session_id || 'unknown');
  const totals = recordRun(tid, sessionId, payload);
  return sendJson(res, 200, { ok: true, totals: totals.totals });
}

// ---------- Instance API ----------

// Lazy spawnInstance import — avoids pulling node:child_process into every handler load.
let _spawnInstance = null;
async function getSpawner() {
  if (_spawnInstance) return _spawnInstance;
  const mod = await import('../../bin/spawner.mjs');
  _spawnInstance = mod.spawnInstance;
  return _spawnInstance;
}

export function handleInstancesList(res) {
  const all = listInstances();
  return sendJson(res, 200, { instances: all });
}

export function handleInstanceGet(res, id) {
  const inst = getInstance(id);
  if (!inst) return sendJson(res, 404, { error: 'instance not found' });
  // Augment with live PID check (cheap).
  return sendJson(res, 200, { ...inst, alive: pidAlive(inst.terminal_pid) });
}

export async function handleInstanceSpawn(req, res) {
  let payload; try { payload = await readBody(req); } catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const agent = String(payload.agent || '').trim();
  if (!agent) return sendJson(res, 400, { error: 'agent required' });
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agent)) return sendJson(res, 400, { error: 'agent must be kebab-case alnum' });
  if (!listAgents().includes(agent)) return sendJson(res, 404, { error: `agent '${agent}' not in .claude/agents/` });
  const inst = createInstance({ agent });
  try {
    const spawner = await getSpawner();
    const model = getAgentModel(agent);
    const { terminalPid } = await spawner({ agent, instanceId: inst.id, project: ROOT, model });
    updateInstance(inst.id, { terminal_pid: terminalPid, status: 'starting', model: model || null });
  } catch (e) {
    removeInstance(inst.id);
    return sendJson(res, 500, { error: `spawn failed: ${e.message}` });
  }
  broadcastChange('instances', { kind: 'spawn', instance_id: inst.id });
  return sendJson(res, 200, { ok: true, instance_id: inst.id });
}

export async function handleInstanceKill(req, res, id) {
  const inst = getInstance(id);
  if (!inst) return sendJson(res, 404, { error: 'instance not found' });
  // Re-queue any in-flight task before killing.
  if (inst.current_task_id) {
    const [p, fm, body] = findTask(inst.current_task_id);
    if (p && (fm.status === 'in-progress' || fm.status === 'verifying')) {
      fm.status = 'queued';
      fm.attempts = Number(fm.attempts || 0) + 1;
      saveTask(p, fm, body);
      writeTrigger(inst.current_task_id, fm, p, { reason: 'instance_killed' });
      try { deleteSnapshot(inst.current_task_id); } catch {}
    }
  }
  // Prefer claude_pid (the real claude.exe captured via process.ppid in the
  // SessionStart hook). terminal_pid on Windows is the cmd /c start launcher,
  // long dead by the time we'd kill it.
  if (inst.claude_pid) {
    try { process.kill(inst.claude_pid); } catch {}
  } else if (inst.terminal_pid) {
    try { process.kill(inst.terminal_pid); } catch {}
  }
  markDead(id, 'killed');
  removeInstance(id);
  broadcastChange('instances', { kind: 'kill', instance_id: id });
  return sendJson(res, 200, { ok: true });
}

export async function handleInstanceHeartbeat(req, res, id) {
  let payload = {}; try { payload = await readBody(req); } catch {}
  const inst = getInstance(id);
  if (!inst) return sendJson(res, 404, { error: 'instance not found' });
  const patch = {};
  if ('tokens_used' in payload) patch.tokens_used = Number(payload.tokens_used) || 0;
  if ('claude_pid' in payload) patch.claude_pid = Number(payload.claude_pid) || null;
  if ('status' in payload && payload.status) patch.status = String(payload.status);
  if ('current_task_id' in payload) patch.current_task_id = payload.current_task_id || null;
  if ('session_id' in payload && payload.session_id) patch.session_id = String(payload.session_id);
  const next = updateInstance(id, patch);
  return sendJson(res, 200, { ok: true, instance: next });
}

export async function handleInstanceRespawn(req, res, id) {
  const inst = getInstance(id);
  if (!inst) return sendJson(res, 404, { error: 'instance not found' });
  updateInstance(id, { respawn_requested: true });
  markExiting(id, 'respawn_requested');
  return sendJson(res, 200, { ok: true });
}

// PreCompact hook landing pad. If the instance is mid-task we DON'T tear it
// down — Claude can /compact in place and finish. Only after submit (no
// active task) the deferred respawn fires. If already idle when PreCompact
// arrives, behave like a normal respawn.
export async function handleInstancePrecompact(req, res, id) {
  const inst = getInstance(id);
  if (!inst) return sendJson(res, 404, { error: 'instance not found' });
  if (inst.current_task_id) {
    updateInstance(id, { respawn_after_submit: true });
    return sendJson(res, 200, { ok: true, deferred: true });
  }
  updateInstance(id, { respawn_requested: true });
  markExiting(id, 'precompact');
  return sendJson(res, 200, { ok: true, deferred: false });
}

// Stop hook calls this to decide whether to block (continue) or allow exit.
// Contract:
//   - Always block when there is a real next task — Claude must keep working.
//   - On empty queue: block exactly once (Claude double-checks), then on the
//     repeat firing (`stop_hook_active=true`) allow exit and mark the instance
//     `idle_exited`. The monitor will respawn the instance when work shows up.
//   - On exiting / respawn_requested: allow exit.
export async function handleAgentLoopDecide(req, res) {
  let payload = {}; try { payload = await readBody(req); } catch {}
  const id = String(payload.instance_id || '');
  const stopHookActive = !!payload.stop_hook_active;
  const inst = getInstance(id);
  if (!inst) return sendJson(res, 200, { decision: 'allow', reason: 'no instance — exit' });
  if (inst.status === 'exiting' || inst.respawn_requested) {
    return sendJson(res, 200, { decision: 'allow', reason: inst.exit_reason || 'exiting' });
  }
  const next = peekNextForAssignee(inst.agent, {
    preferIteration: inst.last_iteration || null,
    preferTrack: inst.last_track || null,
  });
  if (next) {
    updateInstance(id, { status: 'working' });
    return sendJson(res, 200, {
      decision: 'block',
      reason: `Take next workflow task: ${next.task_id}. Call workflow_next_task(assignee="${inst.agent}", instance_id="${inst.id}") to claim and start working.`,
      next_task_id: next.task_id,
    });
  }
  // Empty queue.
  if (stopHookActive) {
    // Claude already came back once after our block. Respect the loop guard:
    // mark the instance as cleanly exited and let it stop. Monitor will respawn
    // a fresh session when new tasks arrive for this agent.
    updateInstance(id, { status: 'idle_exited', exit_reason: 'queue_empty' });
    return sendJson(res, 200, { decision: 'allow', reason: 'queue empty — exit cleanly, monitor will respawn on new tasks' });
  }
  // First time the queue is empty — ask Claude to verify once, then exit.
  updateInstance(id, { status: 'idle' });
  return sendJson(res, 200, {
    decision: 'block',
    reason: `Workflow queue for "${inst.agent}" looks empty. Call workflow_next_task(assignee="${inst.agent}", instance_id="${inst.id}") one more time to confirm. If it still returns empty, just complete the turn — the instance will be respawned automatically when new tasks arrive.`,
  });
}

// MCP-facing: pop next queued task for this assignee, claim it, attach to instance.
export async function handleNextTask(req, res) {
  let payload = {}; try { payload = await readBody(req); } catch {}
  const assignee = String(payload.assignee || '').trim();
  const instanceId = String(payload.instance_id || '').trim();
  if (!assignee) return sendJson(res, 400, { error: 'assignee required' });
  const callerInst = instanceId ? getInstance(instanceId) : null;
  const hints = callerInst ? {
    preferIteration: callerInst.last_iteration || null,
    preferTrack: callerInst.last_track || null,
    recentFiles: Array.isArray(callerInst.recent_files) ? callerInst.recent_files : null,
  } : null;
  const trig = popNextForAssignee(assignee, instanceId, hints);
  if (!trig) {
    if (instanceId) updateInstance(instanceId, { status: 'idle', current_task_id: null });
    return sendJson(res, 200, { empty: true });
  }
  const r = _claimTaskInternal(trig.task_id);
  if (!r.ok) {
    // Re-queue trigger so we don't lose it.
    try {
      const [p2, fm2] = findTask(trig.task_id);
      if (p2) writeTrigger(trig.task_id, fm2, p2, { reason: 'reclaim_failed' });
    } catch {}
    return sendJson(res, r.code || 500, { error: r.error });
  }
  let firstCall = false;
  if (instanceId) {
    const before = getInstance(instanceId);
    if (before && !before.protocol_sent) {
      firstCall = true;
      updateInstance(instanceId, { protocol_sent: true });
    }
    claimTaskForInstance(instanceId, trig.task_id);
    // Track iteration/track of the just-claimed task so subsequent picks
    // prefer same-iteration / same-track work and reuse the warm context.
    // recent_files seeds affinity for the NEXT pickup — when the agent finishes
    // this task its expected_files are files it just touched, so ranking the
    // next trigger by overlap with those keeps related work on the same agent.
    const iter = trig.iteration || r.fm.iteration || null;
    const track = trig.track || r.fm.track || null;
    const expected = Array.isArray(trig.expected_files) && trig.expected_files.length
      ? trig.expected_files
      : (Array.isArray(r.fm.expected_files) ? r.fm.expected_files : null);
    const patch = {};
    if (iter) patch.last_iteration = iter;
    if (track) patch.last_track = track;
    if (expected && expected.length) patch.recent_files = expected;
    if (Object.keys(patch).length) updateInstance(instanceId, patch);
  }
  return sendJson(res, 200, {
    task_id: trig.task_id,
    status: r.fm.status,
    attempts: r.fm.attempts || 0,
    first_call: firstCall,
  });
}

// POST /api/task/:id/how-to-verify  body: { content: "markdown" }
// Agent writes the user-facing checklist after auto-verify passes.
export async function handleHowToVerify(req, res, tid) {
  const [p, fm, body] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  let payload; try { payload = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const content = String(payload.content || '').trim();
  if (!content) return sendJson(res, 400, { error: 'content required' });
  const newBody = replaceSection(body, 'How to verify', content);
  saveTask(p, fm, newBody);
  return sendJson(res, 200, { ok: true });
}

// POST /api/track/:slug/iteration/:id/close-auto
// Legacy: write CHECKLIST.md for the iteration without bulk-promoting tasks.
// Mostly subsumed by /finalize.
export async function handleIterCloseAuto(req, res, trackSlug, iterId) {
  let payload = {}; try { payload = await readBody(req); } catch {}
  const r = runCloseIteration(trackSlug, iterId, payload || {});
  if (!r.ok) return sendJson(res, 409, { error: r.error });
  return sendJson(res, 200, r);
}

// GET /api/track/:slug/iteration/:id/finalize-info
// Returns the snapshot the finalize modal renders: iteration + tasks +
// branch list + ROOT state. Read-only.
export function handleIterFinalizeInfo(res, trackSlug, iterId) {
  const r = getFinalizeInfo(trackSlug, iterId);
  if (!r.ok) return sendJson(res, 404, { error: r.error });
  return sendJson(res, 200, r);
}

// POST /api/track/:slug/iteration/:id/finalize
// Body: { target_branch, summary?, ack_incomplete? }
// Salvage-commit, merge auto/iter-<id> into target_branch with --no-ff,
// generate CHECKLIST.md, mark iteration done. No git work — all per-task
// commits already landed on the user's ROOT branch.
export async function handleIterFinalize(req, res, trackSlug, iterId) {
  let payload = {}; try { payload = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const r = finalizeIteration(trackSlug, iterId, payload);
  if (!r.ok) return sendJson(res, 409, r);

  // Mark iteration done in its README frontmatter.
  const iter = findIteration(trackSlug, iterId);
  if (iter) {
    const readmePath = path.join(iter.dir, 'README.md');
    if (exists(readmePath)) {
      try {
        const [fm, body] = parseTask(readText(readmePath));
        if (fm) {
          fm.status = 'done';
          fs.writeFileSync(readmePath, serializeTask(fm, body || ''), 'utf-8');
        }
      } catch (e) { logger.warn('kanban', `iter README mark-done failed: ${e.message}`); }
    }
  }
  // Drop ACTIVE pointer so the track's next iteration can start cleanly.
  try {
    const activeFile = trackActiveFile(trackSlug);
    if (exists(activeFile)) {
      const cur = readText(activeFile).trim();
      if (cur === iterId) fs.rmSync(activeFile, { force: true });
    }
  } catch (e) { logger.warn('kanban', `clear ACTIVE failed: ${e.message}`); }

  broadcastChange('change', { kind: 'iter_finalize', iter_id: iterId, closed: r.closed || [] });
  return sendJson(res, 200, r);
}

// GET /api/track/:slug/iteration/:id/checklist — raw CHECKLIST.md.
export function handleIterChecklistRead(res, trackSlug, iterId) {
  const dir = path.join(TRACKS_DIR, trackSlug, 'iterations');
  if (!exists(dir)) return sendJson(res, 404, { error: 'track has no iterations' });
  const match = fs.readdirSync(dir).find(n => n.startsWith(`${iterId}-`));
  if (!match) return sendJson(res, 404, { error: 'iteration not found' });
  const f = path.join(dir, match, 'CHECKLIST.md');
  if (!exists(f)) return sendJson(res, 404, { error: 'no checklist — close iteration first' });
  return sendJson(res, 200, { content: readText(f), path: rel(f) });
}

// ----- Orchestrator endpoints --------------------------------------------
// These power /iterate. The orchestrator owns the iteration end-to-end and
// drives the kanban as a viewer; no claim/in-progress/verifying — just
// `todo → done` with a per-task commit.

// GET /api/iteration/load[?track=&id=]
// Returns iteration metadata + every task's full body unpacked, plus a
// dependency graph. One call replaces glob+read-each-task in the orchestrator
// session.
export function handleIterationLoad(res, query) {
  let track = query && query.track;
  let iterId = query && query.id;
  let iter = null;
  if (track && iterId) {
    iter = findIteration(track, iterId);
  } else if (track && !iterId) {
    const aid = trackActive(track);
    if (aid) iter = findIteration(track, aid);
  } else {
    const actives = activeIterations();
    if (actives.length === 1) iter = actives[0];
    else if (actives.length > 1) {
      return sendJson(res, 409, {
        error: 'multiple active iterations — pass ?track= and ?id=',
        actives: actives.map(it => ({ track: it.track, id: it.id, slug: it.slug, title: it.fm.title || '' })),
      });
    }
  }
  if (!iter) return sendJson(res, 404, { error: 'iteration not found (or no active iteration)' });

  const tasksRaw = listTasksInIteration(iter.track, iter.id);
  const tasks = tasksRaw.map(t => ({
    id: t.id,
    title: t.title || '',
    status: t.status || 'todo',
    deps: Array.isArray(t.deps) ? t.deps : [],
    expected_files: Array.isArray(t.expected_files) ? t.expected_files : [],
    estimate: t.estimate || '',
    assignee: t.assignee || '',
    auto_verify: t.auto_verify === 'true' || t.auto_verify === true,
    goal: t._goal || '',
    context: t._context || '',
    acceptance: t._acceptance || '',
    criteria: t._criteria || [],
    how_to_verify: t._verify || '',
    subtasks: t._subtasks || [],
    notes: t._notes || '',
    path: t._path || '',
  }));

  // Reverse dep graph: id → list of ids it depends on (only edges into other tasks in this iter).
  const ids = new Set(tasks.map(t => t.id));
  const dep_graph = {};
  for (const t of tasks) {
    const filtered = (t.deps || []).filter(d => ids.has(d));
    if (filtered.length) dep_graph[t.id] = filtered;
  }

  return sendJson(res, 200, {
    iteration: {
      track: iter.track,
      id: iter.id,
      slug: iter.slug,
      status: iter.fm.status || iter.status || 'planned',
      title: iter.fm.title || '',
      goal: extractSection(iter.body || '', 'Цель') || extractSection(iter.body || '', 'Goal'),
      scope: extractSection(iter.body || '', 'Scope'),
      exit_criteria: extractSection(iter.body || '', 'Exit criteria'),
      notes: extractSection(iter.body || '', 'Заметки') || extractSection(iter.body || '', 'Notes'),
      path: rel(path.join(iter.dir, 'README.md')),
    },
    tasks,
    dep_graph,
  });
}

// POST /api/task/:id/done  body: { summary? }
// Mark a task done in /iterate flow. NO git work — the iteration submits as
// one commit later via /api/iteration/submit. Just flips status=done in the
// task's frontmatter and appends summary to Notes.
export async function handleOrchTaskDone(req, res, tid) {
  const [p, fm, body] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  let payload = {};
  try { payload = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }

  const summary = String(payload.summary || '').trim();
  let updatedBody = body;
  if (summary) {
    const block = `### Done — ${fmtDate()}\n\n${summary}`;
    updatedBody = appendToSection(body, 'Notes', block);
  }
  fm.status = 'done';
  saveTask(p, fm, updatedBody);

  broadcastChange('change', { kind: 'orch_task_done', task_id: tid });
  return sendJson(res, 200, { ok: true, task_id: tid, status: 'done', path: rel(p) });
}

// POST /api/iteration/submit  body: { track, id, summary?, status?, author? }
// One-shot iteration close: collects every task done in this iteration (its
// expected_files + the task .md), plus the iteration README with status flip,
// and produces a SINGLE commit. No push — the user runs `git push` manually.
export async function handleIterationSubmit(req, res) {
  let payload = {};
  try { payload = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const track = String(payload.track || '').trim();
  const iterId = String(payload.id || '').trim();
  const status = String(payload.status || 'done').trim();
  const summary = String(payload.summary || '').trim();
  if (!track || !iterId) return sendJson(res, 400, { error: 'track and id required' });
  if (status !== 'done' && status !== 'abandoned') {
    return sendJson(res, 400, { error: 'status must be done or abandoned' });
  }
  const iter = findIteration(track, iterId);
  if (!iter) return sendJson(res, 404, { error: 'iteration not found' });

  // Flip iteration README status.
  const readmePath = path.join(iter.dir, 'README.md');
  if (exists(readmePath)) {
    const [fm, body] = parseTask(readText(readmePath));
    if (fm) {
      fm.status = status;
      fs.writeFileSync(readmePath, serializeTask(fm, body || ''), 'utf-8');
    }
  }

  // Collect files: every done task's expected_files + the task .md path,
  // plus the README we just touched.
  const tasks = listTasksInIteration(track, iterId);
  const fileSet = new Set();
  const doneTids = [];
  for (const t of tasks) {
    if ((t.status || 'todo') !== 'done') continue;
    doneTids.push(t.id);
    if (Array.isArray(t.expected_files)) {
      for (const f of t.expected_files) if (f) fileSet.add(f);
    }
    if (t._path) fileSet.add(t._path);
  }
  fileSet.add(rel(readmePath));
  const files = [...fileSet];

  // Build commit message.
  const iterTitle = iter.fm.title || iter.slug || iterId;
  const tidLine = doneTids.length ? `Tasks: ${doneTids.join(', ')}` : '';
  const lines = [`iter ${iterId}: ${iterTitle}`];
  if (summary) lines.push('', summary);
  if (tidLine) lines.push('', tidLine);
  const message = lines.join('\n');
  const author = payload.author || 'orchestrator <orchestrator@workflow.local>';

  // Run the commit. push:false — user pushes manually.
  let git = { commit: null, note: null, error: null };
  try {
    const result = await commitInWorker({ paths: files, message, author, push: false });
    if (result.ok) {
      git.commit = result.commit || null;
      git.note = result.note || null;
    } else {
      git.error = result.error || 'commit failed';
    }
  } catch (e) {
    git.error = String(e.message || e);
  }

  // Clear ACTIVE pointer only after a successful commit (or no-changes note).
  // If commit truly failed, leave ACTIVE so the user can retry the submit.
  if (git.commit || (git.note && !git.error)) {
    try {
      const activeFile = trackActiveFile(track);
      if (exists(activeFile)) {
        const cur = readText(activeFile).trim();
        if (cur === iterId) fs.rmSync(activeFile, { force: true });
      }
    } catch {}
  }

  broadcastChange('change', { kind: 'orch_iter_submit', track, id: iterId, status, commit: git.commit });
  return sendJson(res, 200, {
    ok: !git.error,
    track, id: iterId, status,
    tasks: doneTids, files,
    ...git,
  });
}

// GET /api/iterations/runs
// Per-iteration token aggregation. The poller writes one record per
// iteration that has been touched by an orchestrator session; we cross it
// with the live track/iteration list so you also see status, title, and
// task counts in the same row.
export function handleIterationRuns(res) {
  const stats = allIterStats();
  // Index iteration metadata by `${track}/${iter}`.
  const meta = new Map();
  const orphans = []; // stats for iters not currently on disk (archived?)
  for (const slug of listTrackSlugs()) {
    for (const iter of listIterations(slug)) {
      const tasks = listTasksInIteration(slug, iter.id);
      meta.set(`${slug}/${iter.id}`, {
        track: slug,
        id: iter.id,
        slug: iter.slug,
        title: iter.fm.title || '',
        status: iter.fm.status || 'planned',
        started: iter.fm.started || '',
        task_count: tasks.length,
        done_count: tasks.filter(t => (t.status || 'todo') === 'done').length,
      });
    }
  }
  const seen = new Set();
  const rows = [];
  for (const s of stats) {
    const key = `${s.track}/${s.iter_id}`;
    seen.add(key);
    const m = meta.get(key);
    rows.push({
      track: s.track,
      id: s.iter_id,
      slug: m?.slug || '',
      title: m?.title || '',
      status: m?.status || 'unknown',
      started: m?.started || '',
      task_count: m?.task_count || 0,
      done_count: m?.done_count || 0,
      totals: s.totals || null,
      runs: Object.entries(s.by_session || {}).map(([session_id, v]) => ({ session_id, ...v })),
    });
    if (!m) orphans.push(key);
  }
  // Add iterations that exist on disk but have no orchestrator stats yet
  // (planned/active/done but never touched by /iterate).
  for (const [key, m] of meta) {
    if (seen.has(key)) continue;
    rows.push({
      ...m,
      totals: null,
      runs: [],
    });
  }
  rows.sort((a, b) => {
    // Active first, then started date desc, then track/id.
    const aa = a.status === 'active' ? 0 : 1;
    const bb = b.status === 'active' ? 0 : 1;
    if (aa !== bb) return aa - bb;
    if ((b.started || '') !== (a.started || '')) return (b.started || '').localeCompare(a.started || '');
    return `${a.track}/${a.id}`.localeCompare(`${b.track}/${b.id}`);
  });
  return sendJson(res, 200, { iterations: rows });
}

// PUT /api/track/:slug/iteration/:id/checklist  body: { content }
// Persists the user's check-off state. The frontend posts the whole markdown.
export async function handleIterChecklistWrite(req, res, trackSlug, iterId) {
  const dir = path.join(TRACKS_DIR, trackSlug, 'iterations');
  if (!exists(dir)) return sendJson(res, 404, { error: 'track has no iterations' });
  const match = fs.readdirSync(dir).find(n => n.startsWith(`${iterId}-`));
  if (!match) return sendJson(res, 404, { error: 'iteration not found' });
  let payload; try { payload = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: `bad json: ${e.message}` }); }
  const content = String(payload.content || '');
  if (!content) return sendJson(res, 400, { error: 'content required' });
  const f = path.join(dir, match, 'CHECKLIST.md');
  fs.writeFileSync(f, content, 'utf-8');
  return sendJson(res, 200, { ok: true, path: rel(f) });
}

export async function handleStatsAggregate(res) {
  const tasks = listAllTasks();
  const totalsByTid = allTaskTotals();
  // Per-agent aggregate.
  const byAgent = {};
  let grand = { input: 0, output: 0, cache_read: 0, cache_creation: 0, runs: 0, tasks: 0 };
  for (const t of tasks) {
    const totals = totalsByTid[t.id];
    if (!totals) continue;
    const a = t.assignee || 'unknown';
    if (!byAgent[a]) byAgent[a] = { agent: a, tasks: 0, done: 0, rework: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0, runs: 0 };
    const slot = byAgent[a];
    slot.tasks += 1;
    if (t.status === 'done') slot.done += 1;
    if (Number(t.attempts || 0) > 0) slot.rework += 1;
    slot.input += totals.input;
    slot.output += totals.output;
    slot.cache_read += totals.cache_read;
    slot.cache_creation += totals.cache_creation;
    slot.runs += totals.runs || 0;
    grand.input += totals.input;
    grand.output += totals.output;
    grand.cache_read += totals.cache_read;
    grand.cache_creation += totals.cache_creation;
    grand.runs += totals.runs || 0;
    grand.tasks += 1;
  }
  // Top tasks by total tokens.
  const byTask = tasks
    .filter(t => totalsByTid[t.id])
    .map(t => ({
      id: t.id, title: t.title, assignee: t.assignee, status: t.status,
      attempts: Number(t.attempts || 0),
      ...totalsByTid[t.id],
    }))
    .sort((a, b) => (b.input + b.output) - (a.input + a.output));

  return sendJson(res, 200, {
    grand,
    by_agent: Object.values(byAgent).sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    by_task: byTask,
  });
}
