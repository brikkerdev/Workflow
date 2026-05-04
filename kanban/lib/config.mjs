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
export const ARCHIVE_DIR = path.join(WORKFLOW, 'archive');
export const AGENTS_DIR = path.join(ROOT, '.claude', 'agents');

// Static assets ship inside the Workflow repo, not the project.
export const STATIC_DIR = path.resolve(__dirname, '..');

// Task lifecycle (one path now — auto_verify just changes who approves):
// Three states. The orchestrator (/iterate) flips todo → done atomically
// when it commits the iteration. `in-progress` exists so the user can mark
// what they are personally working on (user-assignee tasks); the orchestrator
// never sets it.
export const VALID_STATUSES = ['todo', 'in-progress', 'done'];

export const ALLOWED_TRANSITIONS = {
  'todo':        new Set(['in-progress', 'done']),
  'in-progress': new Set(['todo', 'done']),
  'done':        new Set(['todo', 'in-progress']),
};

// Iteration lifecycle (stubs are valid):
//   planned  ->  active  ->  done
//                       ->  abandoned
export const ITER_STATUSES = ['planned', 'active', 'done', 'abandoned'];

export function transitionsJson() {
  const out = {};
  for (const [k, v] of Object.entries(ALLOWED_TRANSITIONS)) out[k] = [...v];
  return out;
}

// Per-track paths
export function trackDir(slug) { return path.join(TRACKS_DIR, slug); }
export function trackActiveFile(slug) { return path.join(trackDir(slug), 'ACTIVE'); }
export function trackItersDir(slug) { return path.join(trackDir(slug), 'iterations'); }
export function iterDirFor(slug, iterId, iterSlug) {
  return path.join(trackItersDir(slug), `${iterId}-${iterSlug}`);
}
