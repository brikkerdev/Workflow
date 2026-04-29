#!/usr/bin/env node
// PreCompact hook: Claude is about to compact the context, which means the
// session is heavy. Mark this instance for clean exit + respawn. The Stop
// hook will see the flag and let Claude exit; the instance monitor will
// then spawn a fresh terminal for the same agent.

import http from 'node:http';
import { URL } from 'node:url';

const KANBAN = (process.env.WORKFLOW_KANBAN || 'http://127.0.0.1:7777').replace(/\/$/, '');
const INSTANCE_ID = process.env.WORKFLOW_INSTANCE_ID || '';

function post(path) {
  return new Promise((resolve) => {
    const u = new URL(KANBAN + path);
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2' },
      timeout: 2000,
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write('{}'); req.end();
  });
}

async function main() {
  // Drain stdin (hook contract).
  process.stdin.on('data', () => {});
  await new Promise(r => process.stdin.on('end', r).on('error', r));
  if (!INSTANCE_ID) process.exit(0);
  await post(`/api/instance/${encodeURIComponent(INSTANCE_ID)}/precompact`);
  process.exit(0);
}

main().catch(() => process.exit(0));
