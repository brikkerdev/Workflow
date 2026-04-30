// Closing an auto-iteration: merge per-task branches into iter/<id>, build a
// human-facing checklist of How-to-verify steps + auto-verify outcomes, and
// hand the iteration over to the user as a single review surface.
//
// The user signs off the checklist; only then the iteration branch can be
// merged into the project's main line by the user. We never auto-merge into
// main — that's the gate the user explicitly asked for.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './config.mjs';
import { findIteration, listTasksInIteration } from './repo.mjs';
import { extractSection } from './frontmatter.mjs';
import { destroyWorktree, branchName } from './worktrees.mjs';
import { logger } from './logger.mjs';

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd || ROOT, encoding: 'utf-8' });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

export function iterationBranchName(iterId) {
  return `auto/iter-${iterId}`;
}

// Ensure the iteration branch exists, branched from main's HEAD.
function ensureIterBranch(name, baseRef) {
  const has = git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  if (has.code === 0) return { ok: true, existed: true };
  const created = git(['branch', name, baseRef || 'main']);
  if (created.code !== 0) return { ok: false, error: created.stderr };
  return { ok: true, existed: false };
}

// Merge a task branch into the iteration branch using a temporary worktree
// (so the user's main checkout is never disturbed).
function mergeIntoIter(iterBranch, taskBranch, tmpDir) {
  fs.mkdirSync(path.dirname(tmpDir), { recursive: true });
  // Spin up a throwaway worktree on the iteration branch.
  let add = git(['worktree', 'add', tmpDir, iterBranch]);
  if (add.code !== 0) return { ok: false, error: `worktree add: ${add.stderr}` };

  const merge = git(['merge', '--no-ff', '-m', `merge ${taskBranch}`, taskBranch], { cwd: tmpDir });
  const conflict = merge.code !== 0;
  if (conflict) {
    git(['merge', '--abort'], { cwd: tmpDir });
  }
  git(['worktree', 'remove', '--force', tmpDir]);
  return { ok: !conflict, conflict };
}

function tsBlock(s) {
  return (s || '').trim();
}

// Build the aggregated CHECKLIST.md content from finished tasks. Groups by
// (track, iteration) — currently always one iteration per closure but the
// shape is forward-compatible. Auto-verified passes collapse, red-auto and
// merge conflicts surface as needs-attention items.
function buildChecklist({ trackSlug, iterId, tasks, mergeReports }) {
  const lines = [];
  lines.push(`# Iteration ${iterId} — verification checklist`);
  lines.push('');
  lines.push(`Track: \`${trackSlug}\``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Group by feature/track → for now we have one section per task's track tag
  // or fallback to its parent iteration. Tasks may be tagged in fm.feature
  // for finer grouping; gracefully handle absence.
  const groups = new Map();
  for (const t of tasks) {
    const key = (t.feature || t.track || trackSlug || 'misc');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  // Needs-you section first — agents failed auto-verify or merge had a conflict.
  const redTasks = tasks.filter(t => t.status === 'red-auto');
  const conflictTids = new Set(mergeReports.filter(r => r.conflict).map(r => r.taskId));
  const conflicted = tasks.filter(t => conflictTids.has(t.id));
  const needs = [...redTasks, ...conflicted];
  if (needs.length) {
    lines.push('## ⚠ Needs you');
    lines.push('');
    for (const t of needs) {
      const reason = redTasks.includes(t) ? 'auto-verify exhausted' : 'merge conflict';
      lines.push(`- [ ] **${t.id}** ${t.title || ''} — ${reason}`);
      const verify = tsBlock(t._verify);
      if (verify) lines.push(verify.split('\n').map(l => `  ${l}`).join('\n'));
    }
    lines.push('');
  }

  // Per-feature passed-auto: dedup steps that appear verbatim across tasks.
  const seenSteps = new Set();
  for (const [feature, group] of groups) {
    const passed = group.filter(t => t.status === 'passed-auto' || t.status === 'done');
    if (!passed.length) continue;
    lines.push(`## ${feature}`);
    lines.push('');
    for (const t of passed) {
      lines.push(`### ${t.id} — ${t.title || ''}`);
      const verify = tsBlock(t._verify);
      if (verify) {
        // emit each non-blank line as a checklist item, deduping.
        for (const raw of verify.split('\n')) {
          const line = raw.replace(/^[-*]\s*\[[ xX]\]\s*/, '').trim();
          if (!line) continue;
          if (seenSteps.has(line)) continue;
          seenSteps.add(line);
          lines.push(`- [ ] ${line}`);
        }
      } else {
        lines.push(`- [ ] (no manual steps — auto-verify only)`);
      }
      lines.push('');
    }
  }

  // Auto-verify summary (collapsed reference for the user).
  lines.push('## Auto-verify summary');
  lines.push('');
  for (const t of tasks) {
    const tag = t.status === 'passed-auto' || t.status === 'done' ? '✓'
              : t.status === 'red-auto' ? '✗'
              : t.status === 'awaiting-unity' ? '…'
              : t.status;
    lines.push(`- ${tag} **${t.id}** ${t.title || ''} (${t.status})`);
  }
  lines.push('');

  if (mergeReports.length) {
    lines.push('## Merge log');
    lines.push('');
    for (const r of mergeReports) {
      const flag = r.conflict ? '⚠ conflict' : 'ok';
      lines.push(`- ${flag} \`${r.branch}\` → \`${r.iterBranch}\``);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// Close an iteration: merge all task branches whose status is passed-auto or
// done into the iteration branch, write CHECKLIST.md inside the iteration's
// directory. Returns a summary the UI / monitor can show.
//
// Idempotent: re-running adds a fresh CHECKLIST.md and re-attempts pending
// merges (skips already-merged branches via git's own tracking).
export function closeIteration(trackSlug, iterId, opts = {}) {
  const iter = findIteration(trackSlug, iterId);
  if (!iter) return { ok: false, error: 'iteration not found' };

  const tasks = listTasksInIteration(trackSlug, iterId);
  const eligibleStatuses = new Set(['passed-auto', 'done']);
  const eligible = tasks.filter(t => eligibleStatuses.has(t.status));

  const iterBranch = iterationBranchName(iterId);
  const baseRef = opts.baseRef || 'main';
  const ensured = ensureIterBranch(iterBranch, baseRef);
  if (!ensured.ok) return { ok: false, error: `iter branch: ${ensured.error}` };

  const tmpRoot = path.join(ROOT, '.workflow', 'tmp', `merge-${iterId}-${Date.now()}`);
  const reports = [];
  for (const t of eligible) {
    const tBranch = t.worktree_branch || branchName(t.id, iterId);
    const tmpDir = path.join(tmpRoot, t.id);
    const r = mergeIntoIter(iterBranch, tBranch, tmpDir);
    reports.push({ taskId: t.id, branch: tBranch, iterBranch, conflict: !!r.conflict, error: r.error || null });
    if (r.ok && opts.cleanupWorktrees !== false) {
      try { destroyWorktree(t.id); } catch (e) { logger.warn('iteration_close', `worktree teardown ${t.id}: ${e.message}`); }
    }
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

  const checklist = buildChecklist({ trackSlug, iterId, tasks, mergeReports: reports });
  const checklistPath = path.join(iter.dir, 'CHECKLIST.md');
  fs.writeFileSync(checklistPath, checklist, 'utf-8');

  return {
    ok: true,
    iter_branch: iterBranch,
    merged: reports.filter(r => !r.conflict).length,
    conflicts: reports.filter(r => r.conflict).map(r => r.branch),
    checklist_path: path.relative(ROOT, checklistPath).replace(/\\/g, '/'),
    needs_attention: tasks.filter(t => t.status === 'red-auto').map(t => t.id),
  };
}
