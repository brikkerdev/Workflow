import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, WORKFLOW } from './config.mjs';

const SNAP_DIR = path.join(WORKFLOW, 'snapshots');

// Paths we never include in a task commit, even if dirty.
function isIgnoredPath(p) {
  if (!p) return true;
  if (p.startsWith('.workflow/snapshots/')) return true;
  if (p.startsWith('.workflow/stats/')) return true;
  return false;
}

export function snapshotPath(tid) {
  return path.join(SNAP_DIR, `${tid}.json`);
}

// Parse `git status --porcelain=v1 -z -uall` output.
// Returns array of { path, deleted } entries (post-rename destination paths).
function parsePorcelainZ(buf) {
  const out = [];
  const s = buf.toString('utf-8');
  const parts = s.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    if (e.length < 3) continue;
    const x = e[0];
    const y = e[1];
    const rest = e.slice(3);
    // Renames: next part is the source path; we want destination (rest).
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i += 1; // skip src
      out.push({ path: rest, deleted: false });
      continue;
    }
    const deleted = (x === 'D' || y === 'D');
    out.push({ path: rest, deleted });
  }
  return out;
}

function gitStatusEntries() {
  const r = spawnSync('git', ['status', '--porcelain=v1', '-z', '-uall'], {
    cwd: ROOT, encoding: 'buffer',
  });
  if (r.status !== 0) return [];
  return parsePorcelainZ(r.stdout);
}

function hashWorkingTreeFile(relPath) {
  const r = spawnSync('git', ['hash-object', '--', relPath], {
    cwd: ROOT, encoding: 'utf-8',
  });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

// Map: path -> hash | "<deleted>". Excludes ignored paths.
export function currentDirty() {
  const map = {};
  for (const e of gitStatusEntries()) {
    if (isIgnoredPath(e.path)) continue;
    if (e.deleted) { map[e.path] = '<deleted>'; continue; }
    const h = hashWorkingTreeFile(e.path);
    map[e.path] = h || '<unknown>';
  }
  return map;
}

export function captureSnapshot(tid) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const paths = currentDirty();
  const data = { tid, capturedAt: new Date().toISOString(), paths };
  fs.writeFileSync(snapshotPath(tid), JSON.stringify(data, null, 2), 'utf-8');
  return data;
}

export function loadSnapshot(tid) {
  const f = snapshotPath(tid);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); }
  catch { return null; }
}

export function deleteSnapshot(tid) {
  const f = snapshotPath(tid);
  try { fs.unlinkSync(f); } catch {}
}

// Paths in `cur` whose content differs from `snap.paths` (or are absent in snap).
export function diffAgainstSnapshot(snap, cur) {
  const base = (snap && snap.paths) || {};
  const out = new Set();
  for (const [p, h] of Object.entries(cur)) {
    if (base[p] !== h) out.add(p);
  }
  return out;
}
