// Resource-locked verification queue.
//
// Auto-verify lets agents run their own checks in parallel — but some checks
// touch shared resources (Unity Editor on a symlinked Library, a single port,
// a Postgres test instance). Those steps queue here with a list of
// `resource_tags`; the worker holds an in-memory mutex per tag and runs at
// most one job per tag at a time, while jobs with disjoint tags overlap.
//
// Jobs are one-shot: the producer (agent) submits, the worker invokes the
// matching runner, the result is written back to the task and the job file
// is deleted. Worker survives server restarts because pending jobs persist
// on disk.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VERIFY_QUEUE_DIR } from './config.mjs';
import { logger } from './logger.mjs';

const HELD_TAGS = new Set();   // tags currently locked by an in-flight job
const RUNNERS = new Map();     // job.kind -> async (job) => { passed, log, ... }

function ensureDir() { fs.mkdirSync(VERIFY_QUEUE_DIR, { recursive: true }); }

function jobPath(id) { return path.join(VERIFY_QUEUE_DIR, `${id}.json`); }

function readJob(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function writeJob(job) {
  ensureDir();
  fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2), 'utf-8');
}

// Register a runner for a job kind. Runner contract:
//   async (job) => { passed: boolean, log: string, details?: object }
export function registerRunner(kind, fn) {
  RUNNERS.set(kind, fn);
}

// Producer API. Returns the job id.
export function enqueueVerify({ taskId, iteration = null, kind, resourceTags = [], payload = {}, instanceId = null }) {
  ensureDir();
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const job = {
    id,
    task_id: taskId,
    iteration,
    instance_id: instanceId,
    kind,
    resource_tags: Array.isArray(resourceTags) ? resourceTags : [],
    payload,
    state: 'pending',
    queued_at: new Date().toISOString(),
    attempts: 0,
  };
  writeJob(job);
  return id;
}

export function listJobs(filter = null) {
  if (!fs.existsSync(VERIFY_QUEUE_DIR)) return [];
  const out = [];
  for (const n of fs.readdirSync(VERIFY_QUEUE_DIR)) {
    if (!n.endsWith('.json')) continue;
    const j = readJob(path.join(VERIFY_QUEUE_DIR, n));
    if (!j) continue;
    if (filter && !filter(j)) continue;
    out.push(j);
  }
  return out.sort((a, b) => (a.queued_at || '').localeCompare(b.queued_at || ''));
}

export function getJob(id) { return readJob(jobPath(id)); }

export function deleteJob(id) {
  try { fs.unlinkSync(jobPath(id)); return true; } catch { return false; }
}

// Reserve tags for a job atomically (all-or-nothing). Returns true on success.
function tryAcquire(tags) {
  for (const t of tags) if (HELD_TAGS.has(t)) return false;
  for (const t of tags) HELD_TAGS.add(t);
  return true;
}

function release(tags) {
  for (const t of tags) HELD_TAGS.delete(t);
}

async function runJob(job) {
  const runner = RUNNERS.get(job.kind);
  if (!runner) {
    return { passed: false, log: `no runner registered for kind="${job.kind}"`, error: 'no_runner' };
  }
  try {
    const r = await runner(job);
    return r || { passed: false, log: 'runner returned nothing' };
  } catch (e) {
    return { passed: false, log: `runner threw: ${e.message || e}`, error: 'runner_threw' };
  }
}

// Single tick of the worker. Picks one runnable job per tick to keep the
// scheduling simple and predictable. Caller invokes on a timer.
async function tick(onResult) {
  const pending = listJobs(j => j.state === 'pending');
  for (const job of pending) {
    if (!tryAcquire(job.resource_tags)) continue;
    job.state = 'running';
    job.started_at = new Date().toISOString();
    job.attempts = (job.attempts || 0) + 1;
    writeJob(job);
    logger.info('verify_queue', `running ${job.id} kind=${job.kind} task=${job.task_id} tags=[${job.resource_tags.join(',')}]`);

    const result = await runJob(job);
    release(job.resource_tags);

    job.state = result.passed ? 'passed' : 'failed';
    job.finished_at = new Date().toISOString();
    job.result = result;
    writeJob(job);

    if (typeof onResult === 'function') {
      try { onResult(job, result); } catch (e) { logger.error('verify_queue', `onResult failed`, e); }
    }
    // Result handler is responsible for cleanup (deleteJob) once it has
    // applied the outcome to the task — that way a server restart can replay.
    return job; // one job per tick
  }
  return null;
}

const TICK_MS = 2000;
let _running = false;

export function startVerifyWorker(onResult) {
  if (_running) return;
  _running = true;
  setInterval(() => {
    tick(onResult).catch(e => logger.error('verify_queue', 'tick error', e));
  }, TICK_MS);
}
