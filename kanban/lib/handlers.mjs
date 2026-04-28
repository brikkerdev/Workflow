import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  VALID_STATUSES, ALLOWED_TRANSITIONS, ITER_STATUSES, transitionsJson,
  ROOT, WORKFLOW, TRACKS_DIR, ARCHIVE_DIR, AGENTS_DIR,
  trackDir, trackActiveFile, trackItersDir, iterDirFor,
} from './config.mjs';
import {
  exists, readText, rel,
  listTrackSlugs, readTrack, writeTrackReadme, trackActive, setTrackActive,
  listIterations, findIteration, writeIterationReadme,
  activeIterations, highestTaskId, highestIterId,
  listTasksInIteration, listAllTasks,
  listAgents, findTask, saveTask, depsSatisfied,
} from './repo.mjs';
import { parseTask, serializeTask, replaceSection, appendToSection, parseChecklist, extractSection } from './frontmatter.mjs';
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
export function handleBoard(res, query = {}) {
  const want = query.track || null;
  if (want) {
    const t = readTrack(want);
    if (!t) return sendJson(res, 404, { error: `track not found: ${want}` });
    const aid = trackActive(want);
    if (!aid) return sendJson(res, 200, envelope({
      iteration: null, track: { slug: want, fm: t.fm, body: t.body },
      tasks: [],
    }));
    const iter = findIteration(want, aid);
    return sendJson(res, 200, envelope({
      iteration: iter ? {
        id: iter.id, slug: iter.slug, dir: rel(iter.dir),
        readme: iter.body, fm: iter.fm, track: want, status: iter.status,
      } : null,
      track: { slug: want, fm: t.fm, body: t.body },
      tasks: iter ? listTasksInIteration(want, aid) : [],
    }));
  }
  // aggregate across active iterations
  const actives = activeIterations();
  const tasks = [];
  for (const iter of actives) tasks.push(...listTasksInIteration(iter.track, iter.id));
  return sendJson(res, 200, envelope({
    iteration: null,
    actives: actives.map(it => ({ track: it.track, id: it.id, slug: it.slug, status: it.status })),
    tasks,
  }));
}

// GET /api/tracks  — list of tracks with summary timeline
export function handleTracks(res) {
  const out = [];
  for (const slug of listTrackSlugs()) {
    const t = readTrack(slug);
    if (!t) continue;
    const iters = listIterations(slug).map(it => ({
      id: it.id, slug: it.slug, status: it.status, title: it.fm.title || '',
      task_count: listTasksInIteration(slug, it.id).length,
    }));
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
  const estimate = String(p.estimate || 'S').trim();
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
  sendJson(res, 200, {
    ...fm, _body: body, _path: rel(p),
    _attachments: listAttachments(tid) || [],
    _subtasks: subtasks, _criteria: criteria,
    _goal: goal, _context: context, _acceptance: acceptance, _verify: verify, _notes: notes,
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
  let nextBody = body;
  if ('body' in patch && typeof patch.body === 'string') nextBody = patch.body;
  saveTask(p, fm, nextBody);
  fm._path = rel(p);
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
  if (fm.status === 'queued' || fm.status === 'in-progress') {
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
  const [p, fm, body] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  if (fm.status !== 'todo') return sendJson(res, 409, { error: `can dispatch only todo tasks, current: ${fm.status}` });
  const assignee = fm.assignee || 'user';
  if (assignee === 'user') return sendJson(res, 409, { error: 'assignee=user, not dispatchable' });
  if (!listAgents().includes(assignee)) return sendJson(res, 409, { error: `agent '${assignee}' not registered in .claude/agents/` });
  const [ok, open] = depsSatisfied(fm.deps || []);
  if (!ok) return sendJson(res, 409, { error: `open deps: ${open.join(', ')}` });
  fm.status = 'queued';
  saveTask(p, fm, body);
  writeTrigger(tid, fm, p, { reason: 'dispatch' });
  sendJson(res, 200, { queued: true, task_id: tid, queue_size: queueCount() });
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
  if (fm.status !== 'verifying' && fm.status !== 'in-progress' && fm.status !== 'queued') {
    return sendJson(res, 409, { error: `can verify only verifying/in-progress/queued tasks, current: ${fm.status}` });
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

  const failed = items.filter(it => it.pass === false);
  // server-side guard: if approve but any item failed → force reject
  let effective = decision;
  if (decision === 'approve' && failed.length > 0) effective = 'reject';

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

  // approve: write note, run commit+push, mark done
  const block = buildApproveBlock(fm.attempts || 0, summary);
  const newBody = appendToSection(body, 'Notes', block);
  saveTask(p, fm, newBody);

  const git = runCommitPush(p, fm, summary);
  if (git.error && !git.commit) {
    // commit itself failed → cannot proceed. Stay at verifying.
    const errBlock = `### Commit failed — ${fmtDate()}\n\n${git.error}`;
    const errBody = appendToSection(newBody, 'Notes', errBlock);
    saveTask(p, fm, errBody);
    return sendJson(res, 500, { error: git.error, result: 'commit_failed' });
  }

  // commit succeeded (or nothing to commit). Mark done. If push failed, note it.
  let finalBody = newBody;
  if (git.error) {
    const warnBlock = `### Push failed — ${fmtDate()}\n\n${git.error}\n\nLocal commit ${git.commit?.slice(0, 7) || ''} is in place; push manually.`;
    finalBody = appendToSection(newBody, 'Notes', warnBlock);
  }
  fm.status = 'done';
  saveTask(p, fm, finalBody);
  return sendJson(res, 200, { result: 'done', commit: git.commit, push_warning: git.error || null });
}

function runCommitPush(taskPath, fm, summary) {
  try {
    const tid = fm.id;
    const title = fm.title || tid;
    const author = fm.assignee && fm.assignee !== 'user'
      ? `${fm.assignee} <${fm.assignee}@workflow.local>`
      : null;

    const add = spawnSync('git', ['add', '-A'], { cwd: ROOT, encoding: 'utf-8' });
    if (add.status !== 0) return { error: `git add failed: ${add.stderr || add.stdout}` };

    // Check if there's anything staged.
    const diff = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: ROOT });
    if (diff.status === 0) return { commit: null, note: 'no changes to commit' };

    const msg = `${tid}: ${title}\n\n${summary || ''}`.trim();
    const args = ['commit', '-m', msg];
    if (author) { args.push(`--author=${author}`); }
    const c = spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8' });
    if (c.status !== 0) return { error: `git commit failed: ${c.stderr || c.stdout}` };

    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf-8' });
    const commit = (sha.stdout || '').trim();

    const push = spawnSync('git', ['push'], { cwd: ROOT, encoding: 'utf-8' });
    if (push.status !== 0) return { error: `git push failed: ${push.stderr || push.stdout}`, commit };

    return { commit };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ---------- Agent-facing endpoints (also reachable via MCP) ----------

export async function handleClaim(req, res, tid) {
  const [p, fm, body] = findTask(tid);
  if (!p) return sendJson(res, 404, { error: 'task not found' });
  if (fm.status !== 'queued' && fm.status !== 'in-progress') {
    return sendJson(res, 409, { error: `can claim only queued, current: ${fm.status}` });
  }
  fm.status = 'in-progress';
  saveTask(p, fm, body);
  // remove queue trigger if present
  deleteTrigger(tid);
  return sendJson(res, 200, { ok: true, task_id: tid, status: fm.status, attempts: fm.attempts || 0 });
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
