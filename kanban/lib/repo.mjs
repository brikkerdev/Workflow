import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, WORKFLOW, TRACKS_DIR, AGENTS_DIR,
  trackDir, trackActiveFile, trackItersDir,
} from './config.mjs';
import { parseTask, serializeTask, extractSection, parseChecklist } from './frontmatter.mjs';

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}
export function readText(p) { return fs.readFileSync(p, 'utf-8'); }
export function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

// ---------- Tracks ----------

export function listTrackSlugs() {
  if (!exists(TRACKS_DIR)) return [];
  return fs.readdirSync(TRACKS_DIR)
    .filter(n => fs.statSync(path.join(TRACKS_DIR, n)).isDirectory())
    .sort();
}

export function readTrack(slug) {
  const d = trackDir(slug);
  if (!exists(d)) return null;
  const readme = path.join(d, 'README.md');
  let fm = {}, body = '';
  if (exists(readme)) [fm, body] = parseTask(readText(readme));
  return { slug, fm: fm || {}, body, dir: d };
}

export function writeTrackReadme(slug, fm, body) {
  const d = trackDir(slug);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'README.md'), serializeTask(fm, body), 'utf-8');
}

export function trackActive(slug) {
  const f = trackActiveFile(slug);
  if (!exists(f)) return null;
  return readText(f).trim() || null;
}

export function setTrackActive(slug, iterId) {
  const f = trackActiveFile(slug);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, iterId ? String(iterId) : '', 'utf-8');
}

// ---------- Iterations ----------

export function listIterations(slug) {
  const d = trackItersDir(slug);
  if (!exists(d)) return [];
  const out = [];
  for (const name of fs.readdirSync(d).sort()) {
    const full = path.join(d, name);
    if (!fs.statSync(full).isDirectory()) continue;
    const m = /^(\d{3})-(.+)$/.exec(name);
    if (!m) continue;
    const iterId = m[1], iterSlug = m[2];
    const readmePath = path.join(full, 'README.md');
    let fm = {}, body = '';
    if (exists(readmePath)) [fm, body] = parseTask(readText(readmePath));
    fm = fm || {};
    out.push({
      id: iterId,
      slug: iterSlug,
      track: slug,
      dir: full,
      fm,
      body,
      status: fm.status || 'planned',
      title: fm.title || '',
    });
  }
  return out;
}

export function findIteration(slug, iterId) {
  return listIterations(slug).find(it => it.id === iterId) || null;
}

export function writeIterationReadme(trackSlug, iterId, iterSlug, fm, body) {
  const d = path.join(trackItersDir(trackSlug), `${iterId}-${iterSlug}`);
  fs.mkdirSync(path.join(d, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(d, 'README.md'), serializeTask(fm, body), 'utf-8');
}

// All currently-active iterations across all tracks: [{ track, id, slug, ... }]
export function activeIterations() {
  const out = [];
  for (const slug of listTrackSlugs()) {
    const aid = trackActive(slug);
    if (!aid) continue;
    const iter = findIteration(slug, aid);
    if (iter) out.push(iter);
  }
  return out;
}

// Highest task id used anywhere in the project (T###).
export function highestTaskId() {
  let max = 0;
  for (const slug of listTrackSlugs()) {
    for (const iter of listIterations(slug)) {
      const td = path.join(iter.dir, 'tasks');
      if (!exists(td)) continue;
      for (const n of fs.readdirSync(td)) {
        const m = /^T(\d{3,})-/.exec(n);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    }
  }
  return max;
}

// Highest iteration id within a track.
export function highestIterId(trackSlug) {
  let max = 0;
  for (const it of listIterations(trackSlug)) {
    max = Math.max(max, parseInt(it.id, 10));
  }
  return max;
}

// ---------- Tasks ----------

function readTasksIn(tasksDir, source) {
  const out = [];
  if (!exists(tasksDir)) return out;
  const files = fs.readdirSync(tasksDir)
    .filter(n => n.startsWith('T') && n.endsWith('.md'))
    .sort();
  for (const n of files) {
    const p = path.join(tasksDir, n);
    const [fm, body] = parseTask(readText(p));
    if (!fm) continue;
    fm._path = rel(p);
    fm._source = source;
    fm._goal = extractSection(body, 'Goal');
    fm._acceptance = extractSection(body, 'Acceptance criteria');
    fm._verify = extractSection(body, 'How to verify');
    fm._notes = extractSection(body, 'Notes');
    fm._context = extractSection(body, 'Context');
    fm._subtasks = parseChecklist(body, 'Subtasks');
    fm._criteria = parseChecklist(body, 'Acceptance criteria');
    if (fm.attempts == null) fm.attempts = 0;
    out.push(fm);
  }
  return out;
}

export function listTasksInIteration(trackSlug, iterId) {
  const iter = findIteration(trackSlug, iterId);
  if (!iter) return [];
  return readTasksIn(path.join(iter.dir, 'tasks'), `track:${trackSlug}/iter:${iterId}`);
}

export function listAllTasks() {
  const out = [];
  for (const slug of listTrackSlugs()) {
    for (const iter of listIterations(slug)) {
      out.push(...readTasksIn(path.join(iter.dir, 'tasks'), `track:${slug}/iter:${iter.id}`));
    }
  }
  return out;
}

export function listAgents() {
  if (!exists(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR)
    .filter(n => n.endsWith('.md'))
    .map(n => n.slice(0, -3))
    .sort();
}

export function findTask(taskId) {
  const candidates = [];
  for (const slug of listTrackSlugs()) {
    for (const iter of listIterations(slug)) {
      const td = path.join(iter.dir, 'tasks');
      if (!exists(td)) continue;
      for (const n of fs.readdirSync(td)) {
        if (n.startsWith(`${taskId}-`) && n.endsWith('.md')) candidates.push(path.join(td, n));
      }
    }
  }
  if (!candidates.length) return [null, null, null];
  const p = candidates[0];
  const [fm, body] = parseTask(readText(p));
  return [p, fm, body];
}

export function saveTask(p, fm, body) {
  fs.writeFileSync(p, serializeTask(fm, body), 'utf-8');
}

export function depsSatisfied(deps) {
  if (!deps || !deps.length) return [true, []];
  const idx = new Map(listAllTasks().map(t => [t.id, t]));
  const open = [];
  for (const d of deps) {
    const t = idx.get(d);
    if (!t || t.status !== 'done') open.push(d);
  }
  return [open.length === 0, open];
}
