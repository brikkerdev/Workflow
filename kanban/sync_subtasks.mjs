#!/usr/bin/env node
// PostToolUse hook for TodoWrite: mirror the agent's todo list into the
// kanban task's "Subtasks" section.
//
// Detects task id by scanning the transcript for "Workflow task T###" (the
// dispatch.md prompt template). If no task id is found we exit silently —
// this hook also fires in the user's own session where TodoWrite is not
// task-bound.

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

function findTaskId(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  // Anchor on the exact dispatch.md prompt template so we do not match
  // unrelated mentions of a task id in the user's own session.
  const re = /Workflow task (T\d+)\. attempts=/;
  // Transcripts can grow large; scan line-by-line and stop at first match.
  const text = fs.readFileSync(transcriptPath, 'utf-8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
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

  const tid = findTaskId(payload.transcript_path);
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
