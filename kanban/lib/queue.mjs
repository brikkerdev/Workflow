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
