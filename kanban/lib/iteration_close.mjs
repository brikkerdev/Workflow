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
import { findIteration, listTasksInIteration } from './repo.mjs';
import { extractSection } from './frontmatter.mjs';
import { logger } from './logger.mjs';

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd || ROOT, encoding: 'utf-8' });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function tsBlock(s) { return (s || '').trim(); }

// Build the aggregated CHECKLIST.md content from finished tasks. Groups by
// (track, iteration). Tasks at `verifying` (manual review pending) surface
// as needs-attention so the user can finish them before closing.
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

  const pending = tasks.filter(t => t.status === 'verifying');
  if (pending.length) {
    lines.push('## ⚠ Needs you');
    lines.push('');
    for (const t of pending) {
      lines.push(`- [ ] **${t.id}** ${t.title || ''} — awaiting your manual verify`);
      const verify = tsBlock(t._verify);
      if (verify) lines.push(verify.split('\n').map(l => `  ${l}`).join('\n'));
    }
    lines.push('');
  }

  const seenSteps = new Set();
  for (const [feature, group] of groups) {
    const closed = group.filter(t => t.status === 'done');
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
        lines.push(`- [ ] (no manual steps recorded)`);
      }
      lines.push('');
    }
  }

  lines.push('## Summary');
  lines.push('');
  for (const t of tasks) {
    const tag = t.status === 'done' ? '✓'
              : t.status === 'verifying' ? '…'
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
  const incomplete = tasks.filter(t => t.status !== 'done');
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
      attempts: Number(t.attempts || 0),
    })),
    incomplete: incomplete.map(t => ({ id: t.id, title: t.title || '', status: t.status })),
    root_branch: rb.code === 0 ? rb.stdout : null,
  };
}

// Finalize: write CHECKLIST.md for the record. Per-task commits already
// landed in ROOT (server commits on auto-verify submit / manual approve),
// so no git work runs here. Returns { ok, incomplete_count, error?,
// incomplete? }.
export function finalizeIteration(trackSlug, iterId, opts = {}) {
  const iter = findIteration(trackSlug, iterId);
  if (!iter) return { ok: false, error: 'iteration not found' };
  const tasks = listTasksInIteration(trackSlug, iterId);
  const incomplete = tasks.filter(t => t.status !== 'done');

  if (incomplete.length && !opts.ack_incomplete) {
    return {
      ok: false, error: 'incomplete tasks — pass ack_incomplete: true to confirm',
      incomplete: incomplete.map(t => ({ id: t.id, status: t.status })),
    };
  }

  const checklist = buildChecklist({ trackSlug, iterId, tasks });
  fs.mkdirSync(iter.dir, { recursive: true });
  fs.writeFileSync(path.join(iter.dir, 'CHECKLIST.md'), checklist, 'utf-8');

  return {
    ok: true,
    incomplete_count: incomplete.length,
  };
}

// Legacy: same as finalize without the ack gate, plus a path return for the
// old close-auto button. Wired through server.mjs for back-compat.
export function closeIteration(trackSlug, iterId, opts = {}) {
  const iter = findIteration(trackSlug, iterId);
  if (!iter) return { ok: false, error: 'iteration not found' };
  const tasks = listTasksInIteration(trackSlug, iterId);
  const checklist = buildChecklist({ trackSlug, iterId, tasks });
  const checklistPath = path.join(iter.dir, 'CHECKLIST.md');
  fs.mkdirSync(iter.dir, { recursive: true });
  fs.writeFileSync(checklistPath, checklist, 'utf-8');
  return {
    ok: true,
    checklist_path: path.relative(ROOT, checklistPath).replace(/\\/g, '/'),
    needs_attention: tasks.filter(t => t.status === 'verifying').map(t => t.id),
  };
}
