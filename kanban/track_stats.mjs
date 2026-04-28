#!/usr/bin/env node
// Stop hook: when an agent finishes, walk its transcript JSONL, sum token
// usage from every assistant message, and POST the totals to the kanban
// server keyed by session_id (so re-runs replace, not double-count).

import fs from 'node:fs';
import http from 'node:http';

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function findTaskId(text) {
  const m = /Workflow task (T\d+)\. attempts=/.exec(text);
  return m ? m[1] : null;
}

function sumUsage(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const text = fs.readFileSync(transcriptPath, 'utf-8');
  const tid = findTaskId(text);
  if (!tid) return null;

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

async function main() {
  const raw = await readStdin();
  if (!raw) process.exit(0);
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const result = sumUsage(payload.transcript_path);
  if (!result) process.exit(0);
  const sessionId = payload.session_id || 'unknown';
  await postStats(result.tid, sessionId, result.totals);
  process.exit(0);
}

main().catch(() => process.exit(0));
