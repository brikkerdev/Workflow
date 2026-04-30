// Per-task git worktrees for parallel auto-iteration agents.
//
// A worktree gives each agent an isolated checkout of the repo so multiple
// agents can edit overlapping files without stepping on each other. Heavy
// build artifacts (Unity Library/Temp/Logs/Build) are symlinked back to the
// base checkout — these can hit tens of GB and re-importing them per worktree
// would be unworkable.
//
// Note on Unity: symlinked Library means only ONE Unity Editor can be open at
// a time across all worktrees. Code editing is parallel; the Unity-touching
// auto-verify step is serialized via verify_queue.mjs (resource_tag:
// "unity_editor"). Agents that don't touch Unity finish without contending.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, WORKTREES_DIR } from './config.mjs';
import { logger } from './logger.mjs';

// Project subpaths that are huge & regenerable — symlink instead of copy.
// Anything not listed here lives independently inside the worktree.
const SYMLINK_DIRS = ['Library', 'Temp', 'Logs', 'Build', 'obj', 'UserSettings'];

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd || ROOT, encoding: 'utf-8' });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

export function iterWorktreePath(iterationId) {
  return path.join(WORKTREES_DIR, `_iter-${iterationId}`);
}

export function iterationBranchName(iterationId) {
  return `auto/iter-${iterationId}`;
}

function ensureBranch(name, baseRef) {
  // If branch exists, leave it alone (agent may be resuming).
  const has = git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  if (has.code === 0) return { ok: true, existed: true };
  const created = git(['branch', name, baseRef || 'HEAD']);
  if (created.code !== 0) return { ok: false, error: created.stderr || 'branch failed' };
  return { ok: true, existed: false };
}

function symlinkDir(src, dst) {
  if (!fs.existsSync(src)) return false;
  try { fs.mkdirSync(path.dirname(dst), { recursive: true }); } catch {}
  try {
    // Windows requires 'junction' for directory links without admin rights.
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(src, dst, type);
    return true;
  } catch (e) {
    logger.warn('worktree', `symlink ${src} -> ${dst} failed: ${e.message}`);
    return false;
  }
}

// Provision the iteration's shared worktree. All agents in the iteration
// edit and commit here on the `auto/iter-<id>` branch — this is the only
// checkout besides ROOT (which stays the user's). Unity is opened against
// this worktree so it sees integrated work in real time. File-level
// collisions between agents are serialized by the queue's expected_files
// lock.
export function provisionIterWorktree(iterationId, opts = {}) {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const wtPath = iterWorktreePath(iterationId);
  const branch = iterationBranchName(iterationId);
  if (fs.existsSync(wtPath)) {
    return { ok: true, path: wtPath, branch, existed: true };
  }
  // Branch off whatever the user currently has checked out in ROOT — projects
  // don't always use 'main' (e.g., 'unity'). Caller can override via baseRef.
  const base = opts.baseRef || 'HEAD';
  const br = ensureBranch(branch, base);
  if (!br.ok) return { ok: false, error: br.error };

  const add = git(['worktree', 'add', wtPath, branch]);
  if (add.code !== 0) return { ok: false, error: add.stderr || 'iter worktree add failed' };

  for (const sub of SYMLINK_DIRS) {
    const src = path.join(ROOT, sub);
    const dst = path.join(wtPath, sub);
    if (fs.existsSync(dst)) continue;
    symlinkDir(src, dst);
  }
  logger.info('worktree', `provisioned iter ${iterationId} on ${branch} at ${wtPath}`);
  return { ok: true, path: wtPath, branch, existed: false };
}

export function destroyIterWorktree(iterationId, opts = {}) {
  const wtPath = iterWorktreePath(iterationId);
  if (!fs.existsSync(wtPath)) return { ok: true, removed: false };
  for (const sub of SYMLINK_DIRS) {
    const dst = path.join(wtPath, sub);
    try {
      const st = fs.lstatSync(dst);
      if (st.isSymbolicLink() || st.isDirectory()) fs.rmSync(dst, { recursive: true, force: true });
    } catch {}
  }
  const rm = git(['worktree', 'remove', '--force', wtPath]);
  if (rm.code !== 0) {
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
    git(['worktree', 'prune']);
  }
  if (opts.deleteBranch) {
    git(['branch', '-D', iterationBranchName(iterationId)]);
  }
  return { ok: true, removed: true };
}

// Resolve a worktree path: explicit override only — agents must always pass
// `fm.worktree_path` (which points at the iter worktree).
function resolveWorktree(opts) {
  if (!opts || !opts.worktree) return null;
  return path.isAbsolute(opts.worktree) ? opts.worktree : path.join(ROOT, opts.worktree);
}

// Commit any uncommitted changes in the iteration worktree on its current
// branch (`auto/iter-<id>`). Caller passes the worktree path via
// opts.worktree. No-op when the working tree is clean.
export function commitWorktreeWork(taskId, opts = {}) {
  const wt = resolveWorktree(opts);
  if (!wt) return { ok: false, error: 'worktree path required' };
  if (!fs.existsSync(wt)) return { ok: false, error: `worktree missing: ${wt}` };
  const status = git(['status', '--porcelain'], { cwd: wt });
  if (status.code !== 0) return { ok: false, error: `worktree status: ${status.stderr}` };
  if (!status.stdout.trim()) return { ok: true, committed: false };
  const add = git(['add', '-A'], { cwd: wt });
  if (add.code !== 0) return { ok: false, error: `worktree add: ${add.stderr}` };
  const msg = opts.message || `${taskId}: auto commit`;
  const args = ['commit', '-m', msg];
  if (opts.author) args.push(`--author=${opts.author}`);
  const c = git(args, { cwd: wt });
  if (c.code !== 0) return { ok: false, error: `worktree commit: ${c.stderr}` };
  return { ok: true, committed: true };
}

// List worktrees git knows about — useful for monitor reconciliation.
export function listWorktrees() {
  const r = git(['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line.startsWith('HEAD ') && cur) {
      cur.head = line.slice('HEAD '.length).trim();
    } else if (line === '' && cur) {
      out.push(cur); cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}
