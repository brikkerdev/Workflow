// Periodic scanner of Claude Code transcripts. Runs inside the kanban server
// independent of any hooks — even pre-existing sessions get attributed.
//
// Walks ~/.claude/projects/<encoded-cwd>/ (and subagents/*) reading every
// *.jsonl. For each transcript: tracks the currently-claimed Workflow task
// across the conversation (via mcp__workflow__workflow_claim_task /
// workflow_next_task / workflow_submit_for_verify tool calls), and
// attributes per-message token usage to that task.
//
// Project encoding (Claude Code rule): every non-alphanumeric char of the
// absolute project path becomes '-'. e.g. C:\Workflow → C--Workflow.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { recordRun } from './stats.mjs';
import { recordIterRun } from './iter_stats.mjs';

const TICK_MS = 15_000;
const FILE_MTIME = new Map();
const WORKFLOW_TOOL_RE = /^mcp__workflow__workflow_/;
const TASK_ID_RE = /"task_id"\s*:\s*"(T\d+)"/;
const ITER_LOAD_TOOL = 'mcp__workflow__workflow_iteration_load';
// Pulls track + id from the iteration_load tool_result payload. The handler
// returns iteration:{track:"...",id:"..."} — match that pair regardless of
// whitespace.
const ITER_TRACK_RE = /"iteration"\s*:\s*\{[^}]*?"track"\s*:\s*"([^"]+)"/;
const ITER_ID_RE = /"iteration"\s*:\s*\{[^}]*?"id"\s*:\s*"([^"]+)"/;

function encodeProjectPath(abs) {
  return abs.replace(/[^A-Za-z0-9]/g, '-');
}

function transcriptRoot() {
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(ROOT));
}

function* walkJsonl(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { yield* walkJsonl(full); continue; }
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    yield full;
  }
}

// Walk one transcript. Returns:
//   { perTid: Map<tid, totals>, iter: { track, iter_id, totals } | null }
// A transcript is *either* a per-task session (kanban-dispatched agent that
// claims tasks) *or* an iteration session (orchestrator that called
// iteration_load). The first iteration_load detected pins the transcript as
// an iter session and we sum every assistant turn against that iteration —
// per-task attribution doesn't apply to the orchestrator.
function attributeTokens(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf-8'); }
  catch { return null; }

  const perTid = new Map();
  let currentTid = null;
  const iterTotals = { input: 0, output: 0, cache_read: 0, cache_creation: 0, messages: 0 };
  let iterTrack = null, iterId = null;
  let pendingIterLoad = null; // { track?, id? } from tool_use input, awaiting tool_result

  function bumpTid(tid, usage) {
    if (!perTid.has(tid)) {
      perTid.set(tid, { input: 0, output: 0, cache_read: 0, cache_creation: 0, messages: 0 });
    }
    const t = perTid.get(tid);
    t.input += Number(usage.input_tokens || 0);
    t.output += Number(usage.output_tokens || 0);
    t.cache_read += Number(usage.cache_read_input_tokens || 0);
    t.cache_creation += Number(usage.cache_creation_input_tokens || 0);
    t.messages += 1;
  }
  function bumpIter(usage) {
    iterTotals.input += Number(usage.input_tokens || 0);
    iterTotals.output += Number(usage.output_tokens || 0);
    iterTotals.cache_read += Number(usage.cache_read_input_tokens || 0);
    iterTotals.cache_creation += Number(usage.cache_creation_input_tokens || 0);
    iterTotals.messages += 1;
  }

  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const msg = row.message;
    if (!msg) continue;
    const content = msg.content;

    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'tool_use') {
          const name = c.name || '';
          if (name === ITER_LOAD_TOOL) {
            pendingIterLoad = (c.input && typeof c.input === 'object') ? c.input : {};
            // If the caller passed both track+id explicitly, we already know
            // the binding; no need to wait for the response.
            if (pendingIterLoad.track && pendingIterLoad.id) {
              iterTrack = String(pendingIterLoad.track);
              iterId = String(pendingIterLoad.id);
              pendingIterLoad = null;
            }
          } else if (WORKFLOW_TOOL_RE.test(name) && !iterTrack) {
            const tid = c.input && c.input.task_id;
            if (typeof tid === 'string' && /^T\d+$/.test(tid)) currentTid = tid;
          }
        } else if (c?.type === 'tool_result') {
          let blob = '';
          if (typeof c.content === 'string') blob = c.content;
          else if (Array.isArray(c.content)) {
            for (const x of c.content) if (typeof x?.text === 'string') blob += x.text;
          }
          if (pendingIterLoad) {
            const tm = ITER_TRACK_RE.exec(blob);
            const im = ITER_ID_RE.exec(blob);
            if (tm && im) { iterTrack = tm[1]; iterId = im[1]; }
            pendingIterLoad = null;
          } else if (!iterTrack) {
            // workflow_next_task / workflow_claim_task return { task_id }.
            const m = TASK_ID_RE.exec(blob);
            if (m) currentTid = m[1];
          }
        }
      }
    }

    const usage = msg.usage;
    if (usage) {
      if (iterTrack) bumpIter(usage);
      else if (currentTid) bumpTid(currentTid, usage);
    }
  }

  const iter = iterTrack
    ? { track: iterTrack, iter_id: iterId, totals: iterTotals }
    : null;
  // If this is an iter session, drop any per-task fragments collected before
  // the iteration_load call — they belong to the same session and would
  // double-count if attributed twice.
  if (iter) perTid.clear();
  return { perTid, iter };
}

function tick() {
  const root = transcriptRoot();
  if (!fs.existsSync(root)) return;
  for (const fp of walkJsonl(root)) {
    let st; try { st = fs.statSync(fp); } catch { continue; }
    if (FILE_MTIME.get(fp) === st.mtimeMs) continue;
    FILE_MTIME.set(fp, st.mtimeMs);

    const sessionId = path.basename(fp, '.jsonl');
    const result = attributeTokens(fp);
    if (!result) continue;
    const { perTid, iter } = result;
    if (iter && (iter.totals.input + iter.totals.output > 0)) {
      try {
        recordIterRun(iter.track, iter.iter_id, sessionId, iter.totals);
      } catch (e) {
        process.stderr.write(`[stats-poller] recordIterRun ${iter.track}/${iter.iter_id} failed: ${e.message}\n`);
      }
    }
    for (const [tid, totals] of perTid) {
      if (totals.input + totals.output === 0) continue;
      try {
        recordRun(tid, `${sessionId}:${tid}`, totals);
      } catch (e) {
        process.stderr.write(`[stats-poller] recordRun ${tid} failed: ${e.message}\n`);
      }
    }
  }
}

export function startStatsPoller() {
  try { tick(); } catch (e) { process.stderr.write(`[stats-poller] init: ${e.stack || e}\n`); }
  setInterval(() => {
    try { tick(); } catch (e) { process.stderr.write(`[stats-poller] tick: ${e.stack || e}\n`); }
  }, TICK_MS);
  process.stderr.write(`[stats-poller] watching ${transcriptRoot()} every ${TICK_MS / 1000}s\n`);
}
