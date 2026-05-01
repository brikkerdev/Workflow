#!/usr/bin/env node
// PostToolUse hook for TodoWrite: mirror the agent's todo list into the
// kanban task's "Subtasks" section.
//
// Detects task id in this order:
//   1. WORKFLOW_INSTANCE_ID env → ask kanban for that instance's current_task_id.
//      This is the canonical path for spawned agent instances.
//   2. Scan transcript for MCP tool results / legacy dispatch marker as fallback.
// If no task id is found we exit silently — this hook also fires in the
// user's own session where TodoWrite is not task-bound.

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

async function taskIdFromInstance() {
  const id = process.env.WORKFLOW_INSTANCE_ID;
  if (!id) return null;
  const inst = await getJSON(`/api/instance/${encodeURIComponent(id)}`);
  return inst && inst.current_task_id ? inst.current_task_id : null;
}

function taskIdFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const text = fs.readFileSync(transcriptPath, 'utf-8');
  // 1. Legacy dispatch.md marker.
  const legacy = /Workflow task (T\d+)\. attempts=/.exec(text);
  if (legacy) return legacy[1];
  // 2. MCP tool results from workflow_next_task / workflow_claim_task contain
  //    {"task_id":"T###",...}. Walk JSONL and return the most recent value so
  //    we follow the agent across multiple tasks in one session.
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

function postSubtasks(taskId, items) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ items });
    const req = http.request({
      host: '127.0.0.1', port: 7777,
      path: `/api/task/${encodeURIComponent(taskId)}/subtasks`,
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

  if (payload.tool_name !== 'TodoWrite') process.exit(0);
  const todos = payload.tool_input?.todos;
  if (!Array.isArray(todos) || !todos.length) process.exit(0);

  const tid = (await taskIdFromInstance()) || taskIdFromTranscript(payload.transcript_path);
  if (!tid) process.exit(0);

  const items = todos.map((t) => ({
    text: String(t.content || '').replace(/\s+/g, ' ').trim(),
    checked: t.status === 'completed',
  })).filter(it => it.text);
  if (!items.length) process.exit(0);

  await postSubtasks(tid, items);
  process.exit(0);
}

main().catch(() => process.exit(0));
