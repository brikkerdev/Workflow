// Worker thread: owns ALL git work for task commits — `git status`,
// `git hash-object`, snapshot diffing, and the final add/commit/push. Jobs
// are serialised by the worker's message loop, so path resolution and the
// commit it produces are atomic with respect to other queued jobs (no race
// where job B resolves paths against pre-A state and then commits an empty
// tree because A already took them).
//
// Protocol:
//   parent → worker:
//     legacy: { id, paths, message, author?, push? }
//     resolve+commit: { id, tid, otherTids, message, author?, push?, ignoredPrefixes? }
//   worker → parent: { id, ok, commit?, error?, note? }

import { parentPort, workerData } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = workerData.root;
const SNAP_DIR = path.join(ROOT, '.workflow', 'snapshots');
const DEFAULT_IGNORED_PREFIXES = ['.workflow/snapshots/', '.workflow/stats/'];

function snapshotPathFor(tid) {
  return path.join(SNAP_DIR, `${tid}.json`);
}
function loadSnapshotFile(tid) {
  if (!tid) return null;
  try { return JSON.parse(fs.readFileSync(snapshotPathFor(tid), 'utf-8')); }
  catch { return null; }
}
function deleteSnapshotFile(tid) {
  if (!tid) return;
  try { fs.unlinkSync(snapshotPathFor(tid)); } catch {}
}
const HAS_GIT = (() => {
  try { return fs.statSync(path.join(ROOT, '.git')).isDirectory() || fs.statSync(path.join(ROOT, '.git')).isFile(); }
  catch { return false; }
})();

function parsePorcelainZ(buf) {
  const out = [];
  const s = buf.toString('utf-8');
  const parts = s.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    if (e.length < 3) continue;
    const x = e[0], y = e[1];
    const rest = e.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i += 1; out.push({ path: rest, deleted: false }); continue;
    }
    const deleted = (x === 'D' || y === 'D');
    out.push({ path: rest, deleted });
  }
  return out;
}

function isIgnored(p, prefixes) {
  if (!p) return true;
  for (const pref of prefixes) if (p.startsWith(pref)) return true;
  return false;
}

function currentDirtyMap(ignoredPrefixes) {
  if (!HAS_GIT) return {};
  const r = spawnSync('git', ['status', '--porcelain=v1', '-z', '-uall'], {
    cwd: ROOT, encoding: 'buffer',
  });
  if (r.status !== 0) return {};
  const map = {};
  for (const e of parsePorcelainZ(r.stdout)) {
    if (isIgnored(e.path, ignoredPrefixes)) continue;
    if (e.deleted) { map[e.path] = '<deleted>'; continue; }
    const h = spawnSync('git', ['hash-object', '--', e.path], { cwd: ROOT, encoding: 'utf-8' });
    map[e.path] = (h.status === 0 && (h.stdout || '').trim()) || '<unknown>';
  }
  return map;
}

function diffAgainstSnap(snap, cur) {
  const base = (snap && snap.paths) || {};
  const out = new Set();
  for (const [p, h] of Object.entries(cur)) {
    if (base[p] !== h) out.add(p);
  }
  return out;
}

function resolvePathsForTask({ tid, otherTids, ignoredPrefixes }) {
  const cur = currentDirtyMap(ignoredPrefixes || DEFAULT_IGNORED_PREFIXES);
  // Read snapshots at job-processing time, not enqueue time. Prior committed
  // jobs have already deleted their snapshot files, so they correctly drop
  // out of the "others" set instead of claiming every dirty path with their
  // stale empty-tree state.
  const mySnapshot = loadSnapshotFile(tid);
  const ours = diffAgainstSnap(mySnapshot, cur);
  if (!ours.size) return [];
  for (const otid of (otherTids || [])) {
    const s = loadSnapshotFile(otid);
    if (!s) continue;
    for (const p of diffAgainstSnap(s, cur)) ours.delete(p);
  }
  return [...ours];
}

function gitMsg(r) {
  const raw = (r.stderr || r.stdout || '').trim();
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.pop() || '(no output)';
}

function runCommit({ paths, message, author, push = true }) {
  if (!HAS_GIT) {
    return { ok: true, commit: null, note: 'no .git/ — skipping commit' };
  }
  if (!Array.isArray(paths) || !paths.length) {
    return { ok: true, commit: null, note: 'no changes to commit' };
  }
  const add = spawnSync('git', ['add', '--all', '--', ...paths], { cwd: ROOT, encoding: 'utf-8' });
  if (add.status !== 0) return { ok: false, error: `git add failed: ${gitMsg(add)}` };

  const diff = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: ROOT });
  if (diff.status === 0) return { ok: true, commit: null, note: 'no changes to commit' };

  const args = ['commit', '-m', message];
  if (author) args.push(`--author=${author}`);
  const c = spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8' });
  if (c.status !== 0) return { ok: false, error: `git commit failed: ${gitMsg(c)}` };

  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf-8' });
  const commit = (sha.stdout || '').trim();

  if (push) {
    const p = spawnSync('git', ['push'], { cwd: ROOT, encoding: 'utf-8' });
    if (p.status !== 0) return { ok: true, commit, pushed: false, pushError: gitMsg(p) };
    return { ok: true, commit, pushed: true };
  }
  return { ok: true, commit };
}

parentPort.on('message', (job) => {
  let result;
  try {
    let paths = job.paths;
    // Resolve+commit mode: compute paths inside the worker so it's atomic
    // with the commit and never blocks the main thread on git status/hash.
    if (!paths && job.tid) {
      paths = resolvePathsForTask(job);
    }
    result = runCommit({ ...job, paths });
    // Delete the snapshot here, before the next queued job runs. If we let the
    // main thread do it, the worker may already be resolving the next job's
    // paths (and reading this snapshot from disk) before main runs the
    // continuation that unlinks it — the next task ends up subtracting our
    // stale snapshot and committing nothing.
    if (result && result.commit && job.tid) deleteSnapshotFile(job.tid);
  } catch (e) { result = { ok: false, error: String(e.message || e) }; }
  parentPort.postMessage({ id: job.id, ...result });
});
