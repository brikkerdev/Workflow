import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Project root resolution priority:
//   1. WORKFLOW_PROJECT env var
//   2. process.cwd() (workflow CLI sets this)
function resolveProjectRoot() {
  if (process.env.WORKFLOW_PROJECT) return path.resolve(process.env.WORKFLOW_PROJECT);
  return path.resolve(process.cwd());
}

export const ROOT = resolveProjectRoot();
export const WORKFLOW = path.join(ROOT, '.workflow');
export const QUEUE_DIR = path.join(WORKFLOW, 'queue');
export const TRACKS_DIR = path.join(WORKFLOW, 'tracks');
export const ITERATIONS_DIR = path.join(WORKFLOW, 'iterations');
export const AGENTS_DIR = path.join(ROOT, '.claude', 'agents');

// Static assets ship inside the Workflow repo, not the project.
export const STATIC_DIR = path.resolve(__dirname, '..');

// Full lifecycle:
//   todo  ->  queued  ->  in-progress  ->  verifying
//                                            |  reject -> in-progress (attempt++)
//                                            |  approve -> done (after commit+push)
//   blocked is a side state any active status can park in.
export const VALID_STATUSES = ['todo', 'queued', 'in-progress', 'verifying', 'blocked', 'done'];

export const ALLOWED_TRANSITIONS = {
  'todo':        new Set(['queued', 'in-progress', 'blocked']),
  'queued':      new Set(['in-progress', 'todo', 'blocked']),
  'in-progress': new Set(['verifying', 'queued', 'blocked', 'todo']),
  'verifying':   new Set(['in-progress', 'queued', 'done', 'todo']),
  'blocked':     new Set(['todo', 'queued', 'in-progress']),
  'done':        new Set(['todo']),
};

export function transitionsJson() {
  const out = {};
  for (const [k, v] of Object.entries(ALLOWED_TRANSITIONS)) out[k] = [...v];
  return out;
}
