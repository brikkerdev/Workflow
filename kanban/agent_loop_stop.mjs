#!/usr/bin/env node
// Stop hook for spawned agent instances. Reads $WORKFLOW_INSTANCE_ID from env,
// asks the kanban server whether the loop should continue or exit, and either
// blocks Claude from stopping (so it picks up the next task) or lets it exit.
//
// Hook contract (Claude Code Stop hook): consume JSON on stdin, optionally
// emit JSON on stdout. To block stop: { "decision": "block", "reason": "..." }.
// To allow stop (default): exit 0 with no output.

import fs from 'node:fs';
import http from 'node:http';
import { URL } from 'node:url';

const KANBAN = (process.env.WORKFLOW_KANBAN || 'http://127.0.0.1:7777').replace(/\/$/, '');
const INSTANCE_ID = process.env.WORKFLOW_INSTANCE_ID || '';

// Tail-scan the transcript for an API error in the most recent turn. We look
// at the last ~50 rows because errors arrive as a single row near the end of
// the JSONL right before Stop fires. Patterns observed in Claude Code 2.x:
//   - "isApiErrorMessage": true       — explicit flag set on the assistant row
//   - "API Error: ..."                 — visible text (Stream idle timeout,
//     partial response, ConnectionRefused, 5xx, etc.)
//   - "Overloaded" / "overloaded_error" — anthropic 529-like transient errors
function detectApiError(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  let text;
  try { text = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return null; }
  const lines = text.split('\n').filter(Boolean);
  const tail = lines.slice(-50);
  const re = /"isApiErrorMessage"\s*:\s*true|API Error:|Overloaded|overloaded_error|partial response/i;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (re.test(tail[i])) return tail[i].slice(0, 200);
  }
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function postDecide(payload) {
  return new Promise((resolve) => {
    const u = new URL(KANBAN + '/api/agent-loop/decide');
    const body = JSON.stringify(payload);
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 3000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf-8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

async function main() {
  const raw = await readStdin();
  if (!INSTANCE_ID) { process.exit(0); }
  // Claude Code marks the hook input with stop_hook_active=true on the second
  // (and subsequent) Stop firings to prevent infinite block loops. We respect
  // that — never block twice in a row.
  let stopHookActive = false;
  let transcriptPath = '';
  try {
    const j = JSON.parse(raw);
    stopHookActive = !!j.stop_hook_active;
    transcriptPath = j.transcript_path || '';
  } catch {}
  // If the turn ended on an API error (overloaded, partial response, stream
  // idle, connection refused, etc.) — don't ask the kanban for a next task,
  // just nudge Claude to retry. Skip when stop_hook_active is set so we never
  // wedge in an infinite retry loop; the monitor will respawn instead.
  if (!stopHookActive) {
    const err = detectApiError(transcriptPath);
    if (err) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: 'продолжай' }));
      process.exit(0);
    }
  }
  const decision = await postDecide({ instance_id: INSTANCE_ID, stop_hook_active: stopHookActive });
  if (!decision) { process.exit(0); } // server unreachable — allow stop
  if (decision.decision === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason || 'continue loop' }));
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
