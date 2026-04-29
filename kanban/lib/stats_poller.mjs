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

const TICK_MS = 15_000;
const FILE_MTIME = new Map();
const WORKFLOW_TOOL_RE = /^mcp__workflow__workflow_/;
const TASK_ID_RE = /"task_id"\s*:\s*"(T\d+)"/;

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

// Walk one transcript and return Map<tid, totals>.
function attributeTokens(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf-8'); }
  catch { return null; }

  const perTid = new Map(); // tid → totals
  let currentTid = null;

  function bump(tid, usage) {
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

  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const msg = row.message;
    if (!msg) continue;
    const content = msg.content;

    // Update currentTid from tool calls + tool results.
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'tool_use' && WORKFLOW_TOOL_RE.test(c.name || '')) {
          const tid = c.input && c.input.task_id;
          if (typeof tid === 'string' && /^T\d+$/.test(tid)) currentTid = tid;
        } else if (c?.type === 'tool_result') {
          // workflow_next_task returns { task_id } in its content[].text JSON.
          let blob = '';
          if (typeof c.content === 'string') blob = c.content;
          else if (Array.isArray(c.content)) {
            for (const x of c.content) if (typeof x?.text === 'string') blob += x.text;
          }
          const m = TASK_ID_RE.exec(blob);
          if (m) currentTid = m[1];
        }
      }
    }

    // Attribute usage for assistant turns when we know the task.
    const usage = msg.usage;
    if (usage && currentTid) bump(currentTid, usage);
  }
  return perTid;
}

function tick() {
  const root = transcriptRoot();
  if (!fs.existsSync(root)) return;
  for (const fp of walkJsonl(root)) {
    let st; try { st = fs.statSync(fp); } catch { continue; }
    if (FILE_MTIME.get(fp) === st.mtimeMs) continue;
    FILE_MTIME.set(fp, st.mtimeMs);

    const sessionId = path.basename(fp, '.jsonl');
    const perTid = attributeTokens(fp);
    if (!perTid || !perTid.size) continue;
    for (const [tid, totals] of perTid) {
      if (totals.input + totals.output === 0) continue;
      try {
        // Synthetic key per (session, tid) so a single auto-loop session that
        // worked on multiple tasks doesn't overwrite earlier attribution.
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
