import fs from 'node:fs';
import path from 'node:path';
import { WORKFLOW } from './config.mjs';

const STATS_DIR = path.join(WORKFLOW, 'stats');

function statsFile(tid) { return path.join(STATS_DIR, `${tid}.json`); }

function emptyTotals() {
  return { input: 0, output: 0, cache_read: 0, cache_creation: 0, messages: 0, runs: 0 };
}

export function loadStats(tid) {
  const f = statsFile(tid);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); }
  catch { return null; }
}

// Replace-by-session-id semantics: the Stop hook re-walks the entire
// transcript each time, so each call ships the *cumulative* totals for that
// session. Keep one entry per session and recompute the aggregate.
export function recordRun(tid, sessionId, run) {
  fs.mkdirSync(STATS_DIR, { recursive: true });
  const cur = loadStats(tid) || { task_id: tid, by_session: {} };
  cur.task_id = tid;
  cur.by_session = cur.by_session || {};
  cur.by_session[sessionId || 'unknown'] = {
    ts: new Date().toISOString(),
    input: Number(run.input || 0),
    output: Number(run.output || 0),
    cache_read: Number(run.cache_read || 0),
    cache_creation: Number(run.cache_creation || 0),
    messages: Number(run.messages || 0),
  };
  cur.totals = computeTotals(cur.by_session);
  fs.writeFileSync(statsFile(tid), JSON.stringify(cur, null, 2), 'utf-8');
  return cur;
}

function computeTotals(bySession) {
  const t = emptyTotals();
  for (const v of Object.values(bySession || {})) {
    t.input += Number(v.input || 0);
    t.output += Number(v.output || 0);
    t.cache_read += Number(v.cache_read || 0);
    t.cache_creation += Number(v.cache_creation || 0);
    t.messages += Number(v.messages || 0);
    t.runs += 1;
  }
  return t;
}

export function statsTotals(tid) {
  const s = loadStats(tid);
  return s?.totals || null;
}

// Map of tid → totals for all on-disk stats files.
export function allTaskTotals() {
  if (!fs.existsSync(STATS_DIR)) return {};
  const out = {};
  for (const n of fs.readdirSync(STATS_DIR)) {
    if (!n.endsWith('.json')) continue;
    const tid = n.slice(0, -5);
    const s = loadStats(tid);
    if (s?.totals) out[tid] = s.totals;
  }
  return out;
}
