import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WORKFLOW } from './config.mjs';

export const INSTANCES_DIR = path.join(WORKFLOW, 'instances');

function ensureDir() {
  fs.mkdirSync(INSTANCES_DIR, { recursive: true });
}

function fileFor(id) {
  return path.join(INSTANCES_DIR, `${id}.json`);
}

export function newInstanceId(agent) {
  const slug = String(agent || 'agent').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const rnd = crypto.randomBytes(3).toString('hex');
  return `${slug}-${rnd}`;
}

// Friendly names so the UI / task cards can say "Nova is on T012" instead of
// "developer-a3f2c1 is on T012". Pick one not already in use.
const NAME_POOL = [
  'Nova', 'Atlas', 'Mira', 'Echo', 'Sable', 'Vega', 'Lyra', 'Onyx',
  'Juno', 'Kepler', 'Orion', 'Pax', 'Quill', 'Rune', 'Sage', 'Tessa',
  'Umber', 'Vesper', 'Wren', 'Yara', 'Zephyr', 'Aria', 'Brio', 'Cinder',
  'Dune', 'Ember', 'Fable', 'Gale', 'Halo', 'Indigo',
];

function pickName(taken) {
  const free = NAME_POOL.filter(n => !taken.has(n));
  const pool = free.length ? free : NAME_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function createInstance({ agent, terminalPid = null, claudePid = null, name = null }) {
  ensureDir();
  const id = newInstanceId(agent);
  const taken = new Set(listInstances().filter(i => i.status !== 'dead').map(i => i.name).filter(Boolean));
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const data = {
    id,
    name: name || pickName(taken),
    agent,
    terminal_pid: terminalPid,
    claude_pid: claudePid,
    session_id: null,
    started_at: now,
    last_seen: now,
    current_task_id: null,
    status: 'starting',
    tokens_used: 0,
    respawn_requested: false,
    exit_reason: null,
    protocol_sent: false,
  };
  fs.writeFileSync(fileFor(id), JSON.stringify(data, null, 2), 'utf-8');
  return data;
}

export function getInstance(id) {
  try { return JSON.parse(fs.readFileSync(fileFor(id), 'utf-8')); }
  catch { return null; }
}

export function listInstances() {
  if (!fs.existsSync(INSTANCES_DIR)) return [];
  const out = [];
  for (const n of fs.readdirSync(INSTANCES_DIR)) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, n), 'utf-8'))); }
    catch {}
  }
  return out.sort((a, b) => (a.started_at || '').localeCompare(b.started_at || ''));
}

export function updateInstance(id, patch) {
  const cur = getInstance(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, last_seen: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
  fs.writeFileSync(fileFor(id), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

export function removeInstance(id) {
  try { fs.unlinkSync(fileFor(id)); return true; }
  catch { return false; }
}

export function markExiting(id, reason) {
  return updateInstance(id, { status: 'exiting', exit_reason: reason || 'requested' });
}

export function markDead(id, reason) {
  return updateInstance(id, { status: 'dead', exit_reason: reason || 'dead' });
}

export function claimTaskForInstance(id, taskId) {
  return updateInstance(id, { current_task_id: taskId, status: 'working' });
}

export function releaseTask(id) {
  return updateInstance(id, { current_task_id: null, status: 'idle' });
}

// Cross-platform alive check. process.kill(pid, 0) throws ESRCH if dead, EPERM if no permission (still alive).
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}
