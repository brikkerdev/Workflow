import fs from 'node:fs';
import path from 'node:path';
import { QUEUE_DIR } from './config.mjs';
import { exists, readText, rel } from './repo.mjs';

export function queueCount() {
  if (!exists(QUEUE_DIR)) return 0;
  return fs.readdirSync(QUEUE_DIR).filter(n => n.endsWith('.json')).length;
}

export function queueItems() {
  if (!exists(QUEUE_DIR)) return [];
  const out = [];
  for (const n of fs.readdirSync(QUEUE_DIR).sort()) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(readText(path.join(QUEUE_DIR, n)))); } catch {}
  }
  return out;
}

export function readTrigger(tid) {
  if (!exists(QUEUE_DIR)) return null;
  const p = path.join(QUEUE_DIR, `${tid}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(readText(p)); } catch { return null; }
}

export function deleteTrigger(tid) {
  if (!exists(QUEUE_DIR)) return false;
  const p = path.join(QUEUE_DIR, `${tid}.json`);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

// Score a trigger against caller hints. Higher = better fit for the agent's
// already-warm context. 0 means "no affinity, FIFO order applies".
//   iteration match → strongest signal (same goal, same plan)
//   track match     → weaker but still saves re-reading the spec
function affinityScore(trig, hints) {
  if (!hints) return 0;
  let s = 0;
  if (hints.preferIteration && trig.iteration && trig.iteration === hints.preferIteration) s += 100;
  if (hints.preferTrack && trig.track && trig.track === hints.preferTrack) s += 10;
  return s;
}

// Pick the best candidate for an assignee from the queue, respecting context
// affinity hints. Falls back to FIFO (filename sort) when nothing matches.
function rankCandidates(assignee, hints) {
  if (!exists(QUEUE_DIR)) return [];
  const names = fs.readdirSync(QUEUE_DIR)
    .filter(n => n.endsWith('.json'))
    .sort(); // FIFO baseline (filenames are time-prefixed task ids)
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    let trig;
    try { trig = JSON.parse(readText(path.join(QUEUE_DIR, n))); } catch { continue; }
    if (assignee && trig.assignee !== assignee) continue;
    out.push({ name: n, trig, score: affinityScore(trig, hints), order: i });
  }
  out.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  return out;
}

// Atomically claim the next trigger for assignee. Hints bias selection toward
// tasks whose iteration/track matches the instance's recent work so the agent
// reuses already-loaded context. Concurrent callers race via rename.
export function popNextForAssignee(assignee, instanceId, hints = null) {
  const ranked = rankCandidates(assignee, hints);
  if (!ranked.length) return null;
  const tag = String(instanceId || `pid${process.pid}`).replace(/[^a-z0-9-]/gi, '_');
  for (const { name, trig } of ranked) {
    const src = path.join(QUEUE_DIR, name);
    const claimed = path.join(QUEUE_DIR, `${name}.claimed-${tag}-${Date.now()}`);
    try { fs.renameSync(src, claimed); }
    catch { continue; } // someone else got it
    try { fs.unlinkSync(claimed); } catch {}
    return trig;
  }
  return null;
}

// Peek the next queued trigger for an assignee without removing it. Honors the
// same affinity hints as popNextForAssignee so the loop_stop "next task" hint
// matches what handleNextTask will actually claim.
export function peekNextForAssignee(assignee, hints = null) {
  const ranked = rankCandidates(assignee, hints);
  return ranked.length ? ranked[0].trig : null;
}

export function writeTrigger(tid, fm, taskPath, opts = {}) {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  const trigger = path.join(QUEUE_DIR, `${tid}.json`);
  const source = fm.iteration ? `iter:${fm.iteration}` : (fm.track ? `track:${fm.track}` : null);
  const payload = {
    task_id: tid,
    source,
    iteration: fm.iteration || null,
    track: fm.track || null,
    assignee: fm.assignee || null,
    task_path: rel(taskPath),
    queued_at: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
    attempts: Number(fm.attempts || 0),
    reason: opts.reason || 'dispatch',
    rework_notes: opts.reworkNotes || null,
  };
  fs.writeFileSync(trigger, JSON.stringify(payload, null, 2), 'utf-8');
}
