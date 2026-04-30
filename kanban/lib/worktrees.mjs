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

export function worktreePath(taskId) {
  return path.join(WORKTREES_DIR, taskId);
}

export function branchName(taskId, iterationId) {
  const iter = iterationId ? `iter-${iterationId}` : 'task';
  return `auto/${iter}/${taskId}`;
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

// Provision a worktree for taskId. Idempotent: returns existing path if
// already provisioned. baseRef defaults to current HEAD of the main repo.
export function provisionWorktree(taskId, opts = {}) {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const wtPath = worktreePath(taskId);
  if (fs.existsSync(wtPath)) {
    return { ok: true, path: wtPath, branch: opts.branch || null, existed: true };
  }
  const branch = opts.branch || branchName(taskId, opts.iteration);
  const base = opts.baseRef || 'HEAD';

  const br = ensureBranch(branch, base);
  if (!br.ok) return { ok: false, error: br.error };

  const add = git(['worktree', 'add', wtPath, branch]);
  if (add.code !== 0) return { ok: false, error: add.stderr || 'worktree add failed' };

  for (const sub of SYMLINK_DIRS) {
    const src = path.join(ROOT, sub);
    const dst = path.join(wtPath, sub);
    if (fs.existsSync(dst)) continue; // worktree may already carry it (rare)
    symlinkDir(src, dst);
  }
  logger.info('worktree', `provisioned ${taskId} on ${branch} at ${wtPath}`);
  return { ok: true, path: wtPath, branch, existed: false };
}

// Tear down. Optionally keep the branch (default) for later merge into iter.
export function destroyWorktree(taskId, opts = {}) {
  const wtPath = worktreePath(taskId);
  if (!fs.existsSync(wtPath)) return { ok: true, removed: false };

  // Remove symlinks first so `git worktree remove` doesn't traverse them.
  for (const sub of SYMLINK_DIRS) {
    const dst = path.join(wtPath, sub);
    try {
      const st = fs.lstatSync(dst);
      if (st.isSymbolicLink() || st.isDirectory()) fs.rmSync(dst, { recursive: true, force: true });
    } catch {}
  }
  const rm = git(['worktree', 'remove', '--force', wtPath]);
  if (rm.code !== 0) {
    // Last-resort: scrub the directory ourselves.
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
    git(['worktree', 'prune']);
  }
  if (opts.deleteBranch && opts.branch) {
    git(['branch', '-D', opts.branch]);
  }
  return { ok: true, removed: true };
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
