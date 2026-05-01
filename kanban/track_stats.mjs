#!/usr/bin/env node
// Stop hook: when an agent finishes, walk its transcript JSONL, sum token
// usage from every assistant message, and POST the totals to the kanban
// server keyed by session_id (so re-runs replace, not double-count).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const LOG = path.join(process.env.WORKFLOW_PROJECT || process.cwd(), '.workflow', 'stats', '.hook.log');
function log(...a) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${a.join(' ')}\n`);
  } catch {}
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function findTaskIdInTranscript(text) {
  const legacy = /Workflow task (T\d+)\. attempts=/.exec(text);
  if (legacy) return legacy[1];
  // MCP tool results from workflow_next_task / workflow_claim_task contain
  // {"task_id":"T###"}. Walk JSONL and keep the most recent.
  let last = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const txt = typeof part?.content === 'string' ? part.content
                : Array.isArray(part?.content) ? part.content.map(c => c?.text || '').join('') : '';
      if (!txt) continue;
      const m = /"task_id"\s*:\s*"(T\d+)"/.exec(txt);
      if (m) last = m[1];
    }
  }
  return last;
}

function getJSON(pathname) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: 7777, path: pathname, method: 'GET', timeout: 1500,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(buf)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function resolveTaskId(transcriptPath) {
  const id = process.env.WORKFLOW_INSTANCE_ID;
  if (id) {
    const inst = await getJSON(`/api/instance/${encodeURIComponent(id)}`);
    if (inst && inst.current_task_id) return inst.current_task_id;
  }
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  return findTaskIdInTranscript(fs.readFileSync(transcriptPath, 'utf-8'));
}

function emptyTotals() { return { input: 0, output: 0, cache_read: 0, cache_creation: 0, messages: 0 }; }

function partContent(part) {
  if (typeof part?.content === 'string') return part.content;
  if (Array.isArray(part?.content)) return part.content.map(c => c?.text || '').join('');
  return '';
}

// Walk the transcript and split usage into per-task segments. The agent-loop
// completes many tasks in one Claude session, so we must attribute each
// turn's tokens to whichever task was active at the moment — not lump it
// all onto the last claimed task (the bug in the previous implementation).
//
// State machine:
//   - tool_result containing { "task_id": "T###" } → currentTid := T###
//   - assistant turn with usage → accumulate into segments[currentTid]
//   - tool_use mcp__workflow__workflow_submit_for_verify(task_id=X)
//     → close segment for X (currentTid stays; next claim will switch)
// If no tid is active (e.g. before first claim), tokens are dropped on the
// floor — they belong to bootstrap, not to any task.
function segmentUsage(transcriptPath, fallbackTid) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  const text = fs.readFileSync(transcriptPath, 'utf-8');
  const segments = new Map();
  let currentTid = null;
  function ensure(tid) {
    if (!segments.has(tid)) segments.set(tid, emptyTotals());
    return segments.get(tid);
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const content = row?.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'tool_result') {
          const txt = partContent(part);
          const m = /"task_id"\s*:\s*"(T\d+)"/.exec(txt);
          if (m) currentTid = m[1];
        }
        if (part?.type === 'tool_use' && part.name && part.name.endsWith('workflow_submit_for_verify')) {
          // submit closes its task; next claim/next_task will set a new tid.
          // Don't clear currentTid yet — the assistant's submit-turn usage
          // belongs to the submitted task. Clear lazily when a new tid arrives.
        }
      }
    }
    if (row.type === 'assistant') {
      const usage = row?.message?.usage;
      if (usage && currentTid) {
        const t = ensure(currentTid);
        t.input += Number(usage.input_tokens || 0);
        t.output += Number(usage.output_tokens || 0);
        t.cache_read += Number(usage.cache_read_input_tokens || 0);
        t.cache_creation += Number(usage.cache_creation_input_tokens || 0);
        t.messages += 1;
      }
    }
  }
  // Fallback: if we never saw a claim/next_task tool_result (legacy session),
  // attribute everything to fallbackTid so we don't lose data.
  if (!segments.size && fallbackTid) {
    const totals = emptyTotals();
    for (const line of text.split('\n')) {
      if (!line) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== 'assistant') continue;
      const u = row?.message?.usage; if (!u) continue;
      totals.input += Number(u.input_tokens || 0);
      totals.output += Number(u.output_tokens || 0);
      totals.cache_read += Number(u.cache_read_input_tokens || 0);
      totals.cache_creation += Number(u.cache_creation_input_tokens || 0);
      totals.messages += 1;
    }
    segments.set(fallbackTid, totals);
  }
  return [...segments.entries()].map(([tid, totals]) => ({ tid, totals }));
}

function postStats(taskId, sessionId, totals) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ session_id: sessionId, ...totals });
    const req = http.request({
      host: '127.0.0.1', port: 7777,
      path: `/api/task/${encodeURIComponent(taskId)}/stats`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 2000,
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

function postJSON(path, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port: 7777, path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 2000,
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// Per-model respawn threshold. Sonnet sits at ~200k usable context, Opus at
// ~1M. We trigger respawn before natural compaction kicks in so the cold
// restart preserves affinity (last_iteration/recent_files) instead of dying
// mid-turn. Override via WORKFLOW_RESPAWN_AT.
function thresholdForModel(model) {
  if (process.env.WORKFLOW_RESPAWN_AT) return parseInt(process.env.WORKFLOW_RESPAWN_AT, 10);
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return 800_000;
  return 180_000; // sonnet, haiku, unknown
}

async function main() {
  const raw = await readStdin();
  if (!raw) { log('no stdin'); process.exit(0); }
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { log('bad json:', e.message); process.exit(0); }

  log(`fired transcript=${payload.transcript_path || '?'} session=${payload.session_id || '?'}`);
  const fallbackTid = await resolveTaskId(payload.transcript_path);
  const segments = segmentUsage(payload.transcript_path, fallbackTid);
  if (!segments.length) { log('no task segments found in transcript'); process.exit(0); }
  const sessionId = payload.session_id || 'unknown';
  let totalTokensThisSession = 0;
  for (const seg of segments) {
    log(`seg tid=${seg.tid} totals=${JSON.stringify(seg.totals)}`);
    // Compose key per (session, task) so each task's slice replaces cleanly
    // on subsequent Stop firings within the same session.
    const code = await postStats(seg.tid, `${sessionId}:${seg.tid}`, seg.totals);
    log(`POST tid=${seg.tid} status=${code}`);
    totalTokensThisSession += (seg.totals.input || 0) + (seg.totals.output || 0);
  }

  // If running inside a spawned instance, heartbeat + maybe request respawn.
  const instanceId = process.env.WORKFLOW_INSTANCE_ID;
  if (instanceId) {
    const inst = await getJSON(`/api/instance/${encodeURIComponent(instanceId)}`);
    const threshold = thresholdForModel(inst?.model);
    await postJSON(`/api/instance/${encodeURIComponent(instanceId)}/heartbeat`, {
      tokens_used: totalTokensThisSession,
      session_id: sessionId,
    });
    if (totalTokensThisSession > threshold) {
      log(`tokens=${totalTokensThisSession} > ${threshold} (model=${inst?.model || 'unknown'}) — requesting respawn`);
      await postJSON(`/api/instance/${encodeURIComponent(instanceId)}/respawn`, {});
    }
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
