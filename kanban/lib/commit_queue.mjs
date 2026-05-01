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
// id → { resolve, job, attempts }
const pending = new Map();

function handleWorkerLoss(reason) {
  // Retry each in-flight job once with a fresh worker; reject if already retried.
  const survivors = [];
  for (const [, entry] of pending) {
    if (entry.attempts >= 2) {
      logger.error('commit-queue', `dropping job ${entry.job.tid || '?'} after retry: ${reason}`);
      entry.resolve({ ok: false, error: `commit worker lost twice: ${reason}` });
    } else {
      survivors.push(entry);
    }
  }
  pending.clear();
  if (!survivors.length) return;
  logger.warn('commit-queue', `worker lost (${reason}); retrying ${survivors.length} in-flight job(s)`);
  const w = ensureWorker();
  for (const entry of survivors) {
    const id = nextId++;
    entry.attempts += 1;
    pending.set(id, entry);
    try { w.postMessage({ ...entry.job, id }); }
    catch (e) {
      pending.delete(id);
      entry.resolve({ ok: false, error: String(e.message || e) });
    }
  }
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER_SCRIPT, { workerData: { root: ROOT } });
  worker.on('message', (m) => {
    const entry = pending.get(m.id);
    if (!entry) return;
    pending.delete(m.id);
    entry.resolve(m);
  });
  worker.on('error', (e) => {
    logger.error('commit-worker', String(e.message || e));
    worker = null;
    handleWorkerLoss(`error: ${String(e.message || e)}`);
  });
  worker.on('exit', (code) => {
    if (code !== 0) logger.error('commit-worker', `exited with code ${code}`);
    worker = null;
    handleWorkerLoss(`exit code ${code}`);
  });
  return worker;
}

export function commitInWorker(job) {
  const w = ensureWorker();
  return new Promise((resolve) => {
    const id = nextId++;
    const entry = { resolve, job, attempts: 1 };
    pending.set(id, entry);
    try { w.postMessage({ ...job, id }); }
    catch (e) {
      pending.delete(id);
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}
