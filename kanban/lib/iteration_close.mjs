// Iteration finalize. Worktrees and per-iteration branches are gone — the
// whole iteration's work lands on whatever branch the user has checked out
// in ROOT, committed by the server as each task passes auto-verify or as
// the user approves a manual verify. Finalize is now a verification surface
// only: the user goes through every closed task's "How to verify" checklist,
// optionally bulk-marks the iteration done. No git merge happens here.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './config.mjs';
import { findIteration, listTasksInIteration, saveTask, findTask } from './repo.mjs';
import { extractSection } from './frontmatter.mjs';
import { logger } from './logger.mjs';

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd || ROOT, encoding: 'utf-8' });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function tsBlock(s) { return (s || '').trim(); }

// Build the aggregated CHECKLIST.md content from finished tasks. Groups by
// (track, iteration). Auto-verified passes and approved manual tasks
// collapse together. red-auto surfaces as needs-attention.
function buildChecklist({ trackSlug, iterId, tasks }) {
  const lines = [];
  lines.push(`# Iteration ${iterId} — verification checklist`);
  lines.push('');
  lines.push(`Track: \`${trackSlug}\``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  const groups = new Map();
  for (const t of tasks) {
    const key = (t.feature || t.track || trackSlug || 'misc');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const redTasks = tasks.filter(t => t.status === 'red-auto');
  if (redTasks.length) {
    lines.push('## ⚠ Needs you');
    lines.push('');
    for (const t of redTasks) {
      lines.push(`- [ ] **${t.id}** ${t.title || ''} — auto-verify exhausted`);
      const verify = tsBlock(t._verify);
      if (verify) lines.push(verify.split('\n').map(l => `  ${l}`).join('\n'));
    }
    lines.push('');
  }

  const seenSteps = new Set();
  for (const [feature, group] of groups) {
    const closed = group.filter(t => t.status === 'done' || t.status === 'passed-auto');
    if (!closed.length) continue;
    lines.push(`## ${feature}`);
    lines.push('');
    for (const t of closed) {
      lines.push(`### ${t.id} — ${t.title || ''}`);
      const verify = tsBlock(t._verify);
      if (verify) {
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

  lines.push('## Summary');
  lines.push('');
  for (const t of tasks) {
    const tag = t.status === 'done' ? '✓'
              : t.status === 'passed-auto' ? '✓'
              : t.status === 'red-auto' ? '✗'
              : t.status === 'awaiting-unity' ? '…'
              : t.status;
    lines.push(`- ${tag} **${t.id}** ${t.title || ''} (${t.status})`);
  }
  lines.push('');

  return lines.join('\n');
}

// Snapshot of state needed by the finalize modal: tasks + ROOT branch label.
export function getFinalizeInfo(trackSlug, iterId) {
  const iter = findIteration(trackSlug, iterId);
  if (!iter) return { ok: false, error: 'iteration not found' };
  const tasks = listTasksInIteration(trackSlug, iterId);
  const closedStatuses = new Set(['done', 'passed-auto']);
  const incomplete = tasks.filter(t => !closedStatuses.has(t.status));
  const rb = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    ok: true,
    iteration: {
      id: iterId,
      track: trackSlug,
      title: iter.fm?.title || '',
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
    root_branch: rb.code === 0 ? rb.stdout : null,
  };
}

// Finalize: bulk-mark every passed-auto / done task as done, generate the
// CHECKLIST.md record, leave git alone. The user already approved each task
// (manual verify) or the server auto-committed it (auto-verify). Returns
// { ok, closed, incomplete_count, error?, incomplete? }.
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

  // Bulk-promote any passed-auto leftovers to done. (Manual `done` tasks
  // are unchanged.)
  const closed = [];
  for (const t of tasks) {
    if (t.status !== 'passed-auto') continue;
    const [p, fm, body] = findTask(t.id);
    if (!p) continue;
    fm.status = 'done';
    saveTask(p, fm, body);
    closed.push(t.id);
  }

  // Refresh tasks so the checklist reflects the bulk-promote.
  const finalTasks = listTasksInIteration(trackSlug, iterId);
  const checklist = buildChecklist({ trackSlug, iterId, tasks: finalTasks });
  fs.writeFileSync(path.join(iter.dir, 'CHECKLIST.md'), checklist, 'utf-8');

  return {
    ok: true,
    closed,
    incomplete_count: incomplete.length,
  };
}

// Legacy entry point retained for the old close-auto button (still wired
// through server.mjs). Now equivalent to a no-op finalize that only writes
// CHECKLIST.md. Idempotent.
export function closeIteration(trackSlug, iterId, opts = {}) {
  const iter = findIteration(trackSlug, iterId);
  if (!iter) return { ok: false, error: 'iteration not found' };
  const tasks = listTasksInIteration(trackSlug, iterId);
  const checklist = buildChecklist({ trackSlug, iterId, tasks });
  const checklistPath = path.join(iter.dir, 'CHECKLIST.md');
  fs.writeFileSync(checklistPath, checklist, 'utf-8');
  return {
    ok: true,
    checklist_path: path.relative(ROOT, checklistPath).replace(/\\/g, '/'),
    needs_attention: tasks.filter(t => t.status === 'red-auto').map(t => t.id),
  };
}
