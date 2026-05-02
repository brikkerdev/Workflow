// Per-iteration token aggregation. Mirrors stats.mjs but keyed by
// (track, iter_id). Drives the Runs tab and answers "how many tokens
// did /iterate burn on this iteration".

import fs from 'node:fs';
import path from 'node:path';
import { WORKFLOW } from './config.mjs';

const ITER_STATS_DIR = path.join(WORKFLOW, 'iter-stats');

function fileFor(track, iterId) {
  // <track>__<iter>.json — slugged so pathsep can't sneak in.
  const safe = `${String(track).replace(/[^A-Za-z0-9_-]/g, '_')}__${String(iterId).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return path.join(ITER_STATS_DIR, `${safe}.json`);
}

function emptyTotals() {
  return { input: 0, output: 0, cache_read: 0, cache_creation: 0, messages: 0, runs: 0 };
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

export function loadIterStats(track, iterId) {
  const f = fileFor(track, iterId);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); }
  catch { return null; }
}

// Replace-by-session-id semantics — same as stats.mjs. The poller re-walks
// the entire transcript each tick, so each call ships cumulative totals for
// that session. Keep one entry per session and recompute aggregate.
export function recordIterRun(track, iterId, sessionId, run) {
  fs.mkdirSync(ITER_STATS_DIR, { recursive: true });
  const cur = loadIterStats(track, iterId) || { track, iter_id: iterId, by_session: {} };
  cur.track = track;
  cur.iter_id = iterId;
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
  fs.writeFileSync(fileFor(track, iterId), JSON.stringify(cur, null, 2), 'utf-8');
  return cur;
}

// All on-disk iter stats: [{ track, iter_id, totals, by_session }, ...]
export function allIterStats() {
  if (!fs.existsSync(ITER_STATS_DIR)) return [];
  const out = [];
  for (const n of fs.readdirSync(ITER_STATS_DIR)) {
    if (!n.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ITER_STATS_DIR, n), 'utf-8'));
      if (data && data.track && data.iter_id) out.push(data);
    } catch {}
  }
  return out;
}
