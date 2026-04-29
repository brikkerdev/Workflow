#!/usr/bin/env node
// SessionStart hook for spawned agent instances. Captures Claude's session_id
// from the hook payload and posts it to the kanban heartbeat so accidental
// terminal closures can be respawned via `claude --resume <session_id>`.

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

function postHeartbeat(payload) {
  return new Promise((resolve) => {
    const u = new URL(KANBAN + `/api/instance/${encodeURIComponent(INSTANCE_ID)}/heartbeat`);
    const body = JSON.stringify(payload);
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 2000,
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

async function main() {
  const raw = await readStdin();
  if (!INSTANCE_ID) { process.exit(0); }
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch {}
  const sessionId = payload.session_id || null;
  if (sessionId) {
    await postHeartbeat({ session_id: sessionId, status: 'idle' });
  }
  // Note: we deliberately do NOT capture process.ppid here. On Windows the
  // hook chain is claude.exe → cmd.exe (workflow.cmd) → node workflow.mjs →
  // node session_capture.mjs, so ppid is the transient wrapper that exits
  // immediately. claude_pid is bound by the MCP server instead, where ppid
  // really is claude.exe.
  process.exit(0);
}

main().catch(() => process.exit(0));
