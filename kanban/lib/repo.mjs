import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, WORKFLOW, TRACKS_DIR, ITERATIONS_DIR, AGENTS_DIR,
} from './config.mjs';
import { parseTask, serializeTask, extractSection } from './frontmatter.mjs';

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export function readText(p) { return fs.readFileSync(p, 'utf-8'); }

export function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

export function activeIter() {
  const f = path.join(WORKFLOW, 'ACTIVE');
  if (!exists(f)) return null;
  return readText(f).trim() || null;
}

export function iterDir(iterId) {
  if (!iterId || !exists(ITERATIONS_DIR)) return null;
  const found = fs.readdirSync(ITERATIONS_DIR).find(n => n.startsWith(`${iterId}-`));
  return found ? path.join(ITERATIONS_DIR, found) : null;
}

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
    out.push(fm);
  }
  return out;
}

export function listTasks(iterId) {
  const d = iterDir(iterId);
  if (!d) return [];
  return readTasksIn(path.join(d, 'tasks'), `iter:${iterId}`);
}

export function listTrackSlugs() {
  if (!exists(TRACKS_DIR)) return [];
  return fs.readdirSync(TRACKS_DIR)
    .filter(n => fs.statSync(path.join(TRACKS_DIR, n)).isDirectory())
    .sort();
}

export function listTrackTasks(slug) {
  return readTasksIn(path.join(TRACKS_DIR, slug, 'tasks'), `track:${slug}`);
}

export function listAllTasks() {
  const out = [];
  const iter = activeIter();
  if (iter) out.push(...listTasks(iter));
  for (const slug of listTrackSlugs()) out.push(...listTrackTasks(slug));
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
  const collect = (dir) => {
    if (!exists(dir)) return;
    for (const n of fs.readdirSync(dir)) {
      if (n.startsWith(`${taskId}-`) && n.endsWith('.md')) candidates.push(path.join(dir, n));
    }
  };
  const d = iterDir(activeIter());
  if (d) collect(path.join(d, 'tasks'));
  for (const slug of listTrackSlugs()) collect(path.join(TRACKS_DIR, slug, 'tasks'));
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
