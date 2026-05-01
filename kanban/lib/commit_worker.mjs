// Worker thread: runs git add / commit / push so the main event loop never
// blocks on spawnSync. The worker serialises jobs in arrival order — git
// commits on the same repo can't run concurrently safely (the index is
// shared), so this also acts as a queue. The win for the main thread is that
// HTTP handlers, SSE broadcasts, and other timers stay responsive while git
// is running.
//
// Protocol:
//   parent → worker: { id, paths, message, author?, push? }
//   worker → parent: { id, ok, commit?, error?, note? }

import { parentPort, workerData } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';

const ROOT = workerData.root;

function gitMsg(r) {
  const raw = (r.stderr || r.stdout || '').trim();
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.pop() || '(no output)';
}

function runCommit({ paths, message, author, push = true }) {
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
    if (p.status !== 0) return { ok: true, commit, error: `git push failed: ${gitMsg(p)}` };
  }
  return { ok: true, commit };
}

parentPort.on('message', (job) => {
  let result;
  try { result = runCommit(job); }
  catch (e) { result = { ok: false, error: String(e.message || e) }; }
  parentPort.postMessage({ id: job.id, ...result });
});
