#!/usr/bin/env node
// Stop hook for spawned agent instances. Reads $WORKFLOW_INSTANCE_ID from env,
// asks the kanban server whether the loop should continue or exit, and either
// blocks Claude from stopping (so it picks up the next task) or lets it exit.
//
// Hook contract (Claude Code Stop hook): consume JSON on stdin, optionally
// emit JSON on stdout. To block stop: { "decision": "block", "reason": "..." }.
// To allow stop (default): exit 0 with no output.

import http from 'node:http';
import { URL } from 'node:url';

const KANBAN = (process.env.WORKFLOW_KANBAN || 'http://127.0.0.1:7777').replace(/\/$/, '');
const INSTANCE_ID = process.env.WORKFLOW_INSTANCE_ID || '';

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
  try { stopHookActive = !!JSON.parse(raw).stop_hook_active; } catch {}
  const decision = await postDecide({ instance_id: INSTANCE_ID, stop_hook_active: stopHookActive });
  if (!decision) { process.exit(0); } // server unreachable — allow stop
  if (decision.decision === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason || 'continue loop' }));
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
