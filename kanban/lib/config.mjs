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

// Task lifecycle:
//   Manual track:  todo  ->  queued  ->  in-progress  ->  verifying  ->  done
//   Auto track:    todo  ->  queued  ->  in-progress  ->  auto-verifying
//                                       (-> awaiting-unity)  ->  passed-auto -> done
//                                       (rework loop returns to in-progress; exhaust -> red-auto)
//   blocked is a side state any active status can park in.
export const VALID_STATUSES = [
  'todo', 'queued', 'in-progress', 'verifying',
  'auto-verifying', 'awaiting-unity', 'passed-auto', 'red-auto',
  'blocked', 'done',
];

export const ALLOWED_TRANSITIONS = {
  'todo':           new Set(['queued', 'in-progress', 'blocked']),
  'queued':         new Set(['in-progress', 'todo', 'blocked']),
  'in-progress':    new Set(['verifying', 'auto-verifying', 'queued', 'blocked', 'todo']),
  'verifying':      new Set(['in-progress', 'queued', 'done', 'todo']),
  'auto-verifying': new Set(['awaiting-unity', 'passed-auto', 'red-auto', 'in-progress', 'queued']),
  'awaiting-unity': new Set(['auto-verifying', 'passed-auto', 'red-auto', 'in-progress']),
  'passed-auto':    new Set(['done', 'in-progress', 'queued', 'todo']),
  'red-auto':       new Set(['in-progress', 'queued', 'todo', 'verifying']),
  'blocked':        new Set(['todo', 'queued', 'in-progress']),
  'done':           new Set(['todo']),
};

// Default rework attempt cap before a failed auto-verify task is parked as red-auto.
export const AUTO_VERIFY_REWORK_LIMIT = 3;

// Worktree base — one git worktree per claimed task lives here.
export const WORKTREES_DIR = path.join(WORKFLOW, 'worktrees');

// Verification queue — serializes resource-locked verify jobs (e.g. Unity Editor).
export const VERIFY_QUEUE_DIR = path.join(WORKFLOW, 'verify_queue');

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
