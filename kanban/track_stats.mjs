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

function sumUsage(transcriptPath, tid) {
  if (!tid) return null;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const text = fs.readFileSync(transcriptPath, 'utf-8');

  const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0, messages: 0 };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    // Shape varies across Claude Code transcript versions; try a few.
    const usage = row?.message?.usage || row?.usage;
    if (!usage) continue;
    totals.input += Number(usage.input_tokens || 0);
    totals.output += Number(usage.output_tokens || 0);
    totals.cache_read += Number(usage.cache_read_input_tokens || 0);
    totals.cache_creation += Number(usage.cache_creation_input_tokens || 0);
    totals.messages += 1;
  }
  return { tid, totals };
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

// Thresholds per Anthropic per-turn windows. When current session usage
// exceeds the limit, mark the instance for clean respawn.
// Sonnet's 200k context (or Opus 1M) gives plenty of room. We respawn near
// the high-water mark, not at half, so cold-restart waste is rare. Override
// via WORKFLOW_RESPAWN_AT.
const RESPAWN_THRESHOLD = parseInt(process.env.WORKFLOW_RESPAWN_AT || '220000', 10);

async function main() {
  const raw = await readStdin();
  if (!raw) { log('no stdin'); process.exit(0); }
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { log('bad json:', e.message); process.exit(0); }

  log(`fired transcript=${payload.transcript_path || '?'} session=${payload.session_id || '?'}`);
  const tid = await resolveTaskId(payload.transcript_path);
  if (!tid) { log('no task id found (instance lookup + transcript)'); process.exit(0); }
  const result = sumUsage(payload.transcript_path, tid);
  if (!result) { log(`tid=${tid} but transcript empty`); process.exit(0); }
  log(`tid=${result.tid} totals=`, JSON.stringify(result.totals));
  const sessionId = payload.session_id || 'unknown';
  const code = await postStats(result.tid, sessionId, result.totals);
  log(`POST status=${code}`);

  // If running inside a spawned instance, post a heartbeat with token usage
  // and request respawn if we crossed the threshold.
  const instanceId = process.env.WORKFLOW_INSTANCE_ID;
  if (instanceId) {
    const used = (result.totals.input || 0) + (result.totals.output || 0);
    await postJSON(`/api/instance/${encodeURIComponent(instanceId)}/heartbeat`, {
      tokens_used: used,
      session_id: sessionId,
    });
    if (used > RESPAWN_THRESHOLD) {
      log(`tokens=${used} > ${RESPAWN_THRESHOLD} — requesting respawn`);
      await postJSON(`/api/instance/${encodeURIComponent(instanceId)}/respawn`, {});
    }
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
