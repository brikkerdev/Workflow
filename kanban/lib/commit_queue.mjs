// Background commit pipeline. Spawns a single worker_threads worker that owns
// `git add/commit/push` so the main thread never blocks on spawnSync. Jobs
// are FIFO-queued inside the worker (and serialised by the worker's message
// loop), which is what we want — the git index is shared, so two commits on
// the same repo can't safely run in parallel anyway. From the main thread's
// perspective each call returns a Promise that resolves with the git result.

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './config.mjs';
import { logger } from './logger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, 'commit_worker.mjs');

let worker = null;
let nextId = 1;
const pending = new Map();

function rejectAllPending(reason) {
  for (const [, cb] of pending) cb({ ok: false, error: reason });
  pending.clear();
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER_SCRIPT, { workerData: { root: ROOT } });
  worker.on('message', (m) => {
    const cb = pending.get(m.id);
    if (!cb) return;
    pending.delete(m.id);
    cb(m);
  });
  worker.on('error', (e) => {
    logger.error('commit-worker', String(e.message || e));
    rejectAllPending(`commit worker error: ${String(e.message || e)}`);
    worker = null;
  });
  worker.on('exit', (code) => {
    if (code !== 0) logger.error('commit-worker', `exited with code ${code}`);
    rejectAllPending(`commit worker exited (code ${code})`);
    worker = null;
  });
  return worker;
}

export function commitInWorker(job) {
  const w = ensureWorker();
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    try { w.postMessage({ ...job, id }); }
    catch (e) {
      pending.delete(id);
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}
