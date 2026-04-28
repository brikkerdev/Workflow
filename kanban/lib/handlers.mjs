import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { VALID_STATUSES, ALLOWED_TRANSITIONS, transitionsJson, ROOT, WORKFLOW, TRACKS_DIR } from './config.mjs';
import {
  exists, readText, rel,
  activeIter, iterDir, iterTrack, listTasks, listTrackSlugs, listTrackTasks,
  listAgents, findTask, saveTask, depsSatisfied,
} from './repo.mjs';
import { parseTask, replaceSection, appendToSection, parseChecklist } from './frontmatter.mjs';
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
    iteration: { id: iter, dir: d ? rel(d) : null, readme, track: iterTrack(iter) },
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
  const subtasks = parseChecklist(body, 'Subtasks');
  const criteria = parseChecklist(body, 'Acceptance criteria');
  sendJson(res, 200, {
    ...fm, _body: body, _path: rel(p),
    _attachments: listAttachments(tid) || [],
    _subtasks: subtasks, _criteria: criteria,
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
  saveTask(p, fm, body);
  fm._path = rel(p);
  sendJson(res, 200, fm);
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
