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
import { ROOT, WORKFLOW } from './config.mjs';
import { findIteration, listTasksInIteration } from './repo.mjs';
import { extractSection } from './frontmatter.mjs';
import {
  destroyIterWorktree, iterWorktreePath,
  iterationBranchName as iterBranchName,
  commitWorktreeWork,
} from './worktrees.mjs';
import { logger } from './logger.mjs';

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd || ROOT, encoding: 'utf-8' });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// Re-export for callers that still use this module's symbol.
export const iterationBranchName = iterBranchName;

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

// ─── Branch discovery & root state ────────────────────────────────────────

// List local branches the user can pick as a finalize target. Excludes
// ephemeral iteration branches and detached HEAD entries.
export function listLocalBranches() {
  const r = git(['branch', '--list', '--format=%(refname:short)']);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
    .filter(b => !b.startsWith('auto/iter-'));
}

export function rootBranch() {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function rootDirty() {
  const r = git(['status', '--porcelain']);
  return r.code === 0 ? !!r.stdout.trim() : false;
}

// ─── Finalize: merge iter branch into a user-picked target ─────────────────

// Merge `auto/iter-<id>` into targetBranch with --no-ff. Strategy:
//   - If targetBranch is checked out in ROOT: merge directly there (requires
//     ROOT to be clean). User sees the result immediately.
//   - Otherwise: spin up a temp worktree on targetBranch, merge there, drop
//     the worktree. ROOT untouched.
// Returns { ok, merged_in?, target?, conflict?, error? }.
export function mergeIterIntoTarget(iterId, targetBranch, opts = {}) {
  const iterBranch = iterationBranchName(iterId);
  const has = git(['rev-parse', '--verify', '--quiet', `refs/heads/${targetBranch}`]);
  if (has.code !== 0) return { ok: false, error: `branch '${targetBranch}' does not exist locally` };
  const iterHas = git(['rev-parse', '--verify', '--quiet', `refs/heads/${iterBranch}`]);
  if (iterHas.code !== 0) return { ok: false, error: `iteration branch '${iterBranch}' missing — was the iteration started?` };

  const message = opts.message || `iter ${iterId}: finalize`;
  const rb = rootBranch();
  if (rb === targetBranch) {
    if (rootDirty()) return { ok: false, error: 'ROOT has uncommitted changes — commit or stash before finalizing' };
    const merge = git(['merge', '--no-ff', '-m', message, iterBranch], { cwd: ROOT });
    if (merge.code !== 0) {
      git(['merge', '--abort'], { cwd: ROOT });
      return { ok: false, conflict: true, error: `merge conflict: ${merge.stderr || merge.stdout}` };
    }
    return { ok: true, merged_in: 'root', target: targetBranch };
  }

  const tmp = path.join(WORKFLOW, 'tmp', `finalize-${iterId}-${Date.now()}`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  const add = git(['worktree', 'add', tmp, targetBranch]);
  if (add.code !== 0) {
    return { ok: false, error: `cannot create temp worktree on '${targetBranch}': ${add.stderr || add.stdout}` };
  }
  const merge = git(['merge', '--no-ff', '-m', message, iterBranch], { cwd: tmp });
  let conflict = false;
  if (merge.code !== 0) {
    git(['merge', '--abort'], { cwd: tmp });
    conflict = true;
  }
  git(['worktree', 'remove', '--force', tmp]);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  if (conflict) return { ok: false, conflict: true, error: `merge conflict: ${merge.stderr || merge.stdout}` };
  return { ok: true, merged_in: 'temp_worktree', target: targetBranch };
}

// Snapshot of state needed by the finalize modal: tasks, branches, root info.
export function getFinalizeInfo(trackSlug, iterId) {
  const iter = findIteration(trackSlug, iterId);
  if (!iter) return { ok: false, error: 'iteration not found' };
  const tasks = listTasksInIteration(trackSlug, iterId);
  const closedStatuses = new Set(['done', 'passed-auto']);
  const incomplete = tasks.filter(t => !closedStatuses.has(t.status));
  const rb = rootBranch();
  return {
    ok: true,
    iteration: {
      id: iterId,
      track: trackSlug,
      title: iter.fm?.title || '',
      branch: iterationBranchName(iterId),
      status: iter.fm?.status || null,
    },
    tasks: tasks.map(t => ({
      id: t.id, title: t.title || '', status: t.status,
      assignee: t.assignee || 'user',
      verify: t._verify || '',
      auto_verify_status: t.auto_verify_status || null,
      attempts: Number(t.attempts || 0),
      verify_attempts: Number(t.verify_attempts || 0),
    })),
    incomplete: incomplete.map(t => ({ id: t.id, title: t.title || '', status: t.status })),
    branches: listLocalBranches(),
    root_branch: rb,
    root_dirty: rootDirty(),
    suggested_target: rb || 'main',
  };
}

// Run the full finalize ritual: salvage commit → merge → CHECKLIST → teardown.
// Returns { ok, iter_branch, target, merged_in, incomplete_count, error?, conflict? }.
export function finalizeIteration(trackSlug, iterId, opts = {}) {
  const iter = findIteration(trackSlug, iterId);
  if (!iter) return { ok: false, error: 'iteration not found' };
  const tasks = listTasksInIteration(trackSlug, iterId);
  const closedStatuses = new Set(['done', 'passed-auto']);
  const incomplete = tasks.filter(t => !closedStatuses.has(t.status));

  if (incomplete.length && !opts.ack_incomplete) {
    return {
      ok: false, error: 'incomplete tasks — pass ack_incomplete: true to confirm',
      incomplete: incomplete.map(t => ({ id: t.id, status: t.status })),
    };
  }
  const target = String(opts.target_branch || '').trim();
  if (!target) return { ok: false, error: 'target_branch required' };

  // 1. Salvage any leftover dirty state in the iter worktree.
  const iterWt = iterWorktreePath(iterId);
  if (fs.existsSync(iterWt)) {
    const salv = commitWorktreeWork(`iter-${iterId}`, {
      worktree: iterWt,
      message: `iter ${iterId}: finalize salvage`,
    });
    if (!salv.ok) return { ok: false, error: `salvage commit: ${salv.error}` };
  }

  // 2. Compose merge commit message and merge into target.
  const summary = String(opts.summary || '').trim();
  const title = iter.fm?.title || '';
  const subject = `iter ${iterId}${title ? `: ${title}` : ': finalize'}`;
  const incompleteNote = incomplete.length
    ? `\n\nIncomplete at finalize: ${incomplete.map(t => `${t.id}(${t.status})`).join(', ')}`
    : '';
  const message = `${subject}${summary ? `\n\n${summary}` : ''}${incompleteNote}`;

  const m = mergeIterIntoTarget(iterId, target, { message });
  if (!m.ok) return m;

  // 3. Generate CHECKLIST.md (record of what was finalized).
  const checklist = buildChecklist({ trackSlug, iterId, tasks, mergeReports: [] });
  fs.writeFileSync(path.join(iter.dir, 'CHECKLIST.md'), checklist, 'utf-8');

  // 4. Tear down the iter worktree. The iter branch stays — user can revert
  //    via `git revert -m 1 <merge-commit>` if needed and the original work
  //    is still inspectable.
  try { destroyIterWorktree(iterId); } catch (e) { logger.warn('iteration_close', `iter worktree teardown ${iterId}: ${e.message}`); }

  return {
    ok: true,
    iter_branch: iterationBranchName(iterId),
    target,
    merged_in: m.merged_in,
    incomplete_count: incomplete.length,
  };
}

// Close an iteration. All agents share the iteration's worktree, so closing
// is just: commit any straggler dirty state, generate CHECKLIST.md, tear down
// the worktree. The iter branch (`auto/iter-<id>`) stays in the repo for the
// user to merge into main on their schedule. Idempotent.
export function closeIteration(trackSlug, iterId, opts = {}) {
  const iter = findIteration(trackSlug, iterId);
  if (!iter) return { ok: false, error: 'iteration not found' };

  const tasks = listTasksInIteration(trackSlug, iterId);
  const iterBranch = iterationBranchName(iterId);

  // Salvage uncommitted work in the iter-worktree as a generic commit so the
  // iter branch reflects whatever shipped, even if an agent forgot to call
  // workflow_commit_task.
  const reports = [];
  const iterWt = iterWorktreePath(iterId);
  const r = commitWorktreeWork(`iter-${iterId}`, {
    worktree: iterWt,
    message: `iter ${iterId}: close-iteration salvage`,
  });
  if (r.ok && r.committed) reports.push({ kind: 'salvage', branch: iterBranch, ok: true });
  else if (!r.ok) reports.push({ kind: 'salvage', branch: iterBranch, ok: false, error: r.error });

  if (opts.cleanupWorktrees !== false) {
    try { destroyIterWorktree(iterId); } catch (e) { logger.warn('iteration_close', `iter worktree teardown ${iterId}: ${e.message}`); }
  }

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
