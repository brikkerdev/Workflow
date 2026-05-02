#!/usr/bin/env node
// Workflow MCP server (stdio, JSON-RPC 2.0). Exposes task-manipulation
// tools so dispatched agents only need to call MCP, not edit files.
//
// All operations go through the kanban HTTP server on $WORKFLOW_KANBAN
// (default http://127.0.0.1:7777). The MCP layer is a thin shim — that
// way the kanban remains the single writer of .workflow/ files and the
// frontend sees changes live.
//
// Project root resolution: $WORKFLOW_PROJECT or process.cwd(); only used
// for surfacing in tool responses (the server itself is project-agnostic
// because the kanban already knows its own ROOT).

import path from 'node:path';
import { isUnityProject } from '../lib/project_kind.mjs';

const KANBAN = (process.env.WORKFLOW_KANBAN || 'http://127.0.0.1:7777').replace(/\/$/, '');
const ROOT = path.resolve(process.env.WORKFLOW_PROJECT || process.cwd());
const INSTANCE_ID = process.env.WORKFLOW_INSTANCE_ID || null;
const AGENT = process.env.WORKFLOW_AGENT || null;
const UNITY = isUnityProject(ROOT);

// ---------- stdio JSON-RPC framing ----------
let stdinBuf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => {
  stdinBuf += chunk;
  let nl;
  while ((nl = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, nl).trim();
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch (e) { log(`JSON parse error: ${e.message} | input: ${line.slice(0, 120)}`); continue; }
    handle(msg).catch(err => {
      log('handler error: ' + (err.stack || err));
      if (msg && msg.id != null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err.message || err) } });
    });
  }
});

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function log(...a) { process.stderr.write('[workflow-mcp] ' + a.join(' ') + '\n'); }

// ---------- HTTP helper ----------
async function api(method, pathname, body) {
  const url = KANBAN + pathname;
  const init = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(url, init);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  if (!r.ok) {
    const msg = (json && json.error) || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return json;
}

// Drop empty strings, empty arrays, and null/undefined fields. Saves a few
// hundred tokens per task brief over a long auto-loop.
function compactBrief(b) {
  if (!b || typeof b !== 'object') return b;
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (v == null) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
}

// ---------- tool definitions ----------
// Descriptions are kept terse on purpose — tools/list is sent every session.
const idArg = { task_id: { type: 'string' } };

const PROTOCOL = [
  'LANGUAGE: All free-text you produce — Notes, How to verify, submit summaries — must be in Russian. Not Ukrainian, not English. Code identifiers, file paths, and shell commands stay as they are.',
  '',
  '1. workflow_claim_task(id) — sets in-progress, returns brief + rework notes if any.',
  '2. Plan your work via the built-in TodoWrite tool and tick items off as you',
  '   go. A hook auto-mirrors your todo list into the task\'s "Subtasks" section,',
  '   so the kanban always reflects your live progress — do NOT call',
  '   workflow_set_subtasks manually.',
  '3. workflow_append_note(id, text) — ONLY for non-obvious findings: a',
  '   surprising constraint, a workaround you had to apply, a thing the user',
  '   should know before verifying. Skip routine progress, file lists,',
  '   step-by-step recaps — those are noise. If nothing surprising came up,',
  '   do not call this tool at all.',
  '4. Before submit: ensure "## How to verify" in the task .md contains',
  '   concrete, runnable steps the user can follow to check every Acceptance',
  '   criterion (paths, commands, exact expected output). It is shown at the',
  '   top of the kanban Verify panel; if it is empty or vague the user cannot',
  '   test your work. Use Edit to fill it in.',
  '5. workflow_submit_for_verify(id, summary) — when done. Always the same call,',
  '   regardless of auto_verify. Server commits and pushes either way:',
  '   - auto_verify tasks: server auto-approves on submit and lands the task at done.',
  '   - manual tasks: task sits at verifying until the user approves through the kanban.',
  '   For auto_verify tasks you are responsible for running your own self-checks',
  '   (lint/typecheck/build/unit tests) before submitting.',
  'Do NOT run git yourself — server owns commits and pushes.',
].join('\n');

const tools = [
  {
    name: 'workflow_claim_task',
    description: 'Claim queued task → in-progress. Returns brief, protocol, last reject (if rework).',
    inputSchema: { type: 'object', properties: idArg, required: ['task_id'] },
    handler: async ({ task_id }) => {
      const claim = await api('POST', `/api/task/${encodeURIComponent(task_id)}/claim`, {});
      const briefRaw = await api('GET', `/api/task/${encodeURIComponent(task_id)}?view=brief`);
      const brief = compactBrief(briefRaw);
      const out = { protocol: PROTOCOL, brief, status: claim.status };
      if (Number(brief.attempts) > 0) {
        const r = await api('GET', `/api/task/${encodeURIComponent(task_id)}?view=notes`);
        const m = /### Reject —[\s\S]*?(?=###|\s*$)/g.exec(r.notes || '');
        if (m) out.rework = m[0].trim();
      }
      return out;
    },
  },
  {
    name: 'workflow_get_brief',
    description: 'Re-read minimal task: title/status/attempts/deps/goal/criteria/subtasks/verify.',
    inputSchema: { type: 'object', properties: idArg, required: ['task_id'] },
    handler: async ({ task_id }) => api('GET', `/api/task/${encodeURIComponent(task_id)}?view=brief`),
  },
  {
    name: 'workflow_get_notes',
    description: 'Read full Notes section (history of submits, rejects, approvals). Use only when needed.',
    inputSchema: { type: 'object', properties: idArg, required: ['task_id'] },
    handler: async ({ task_id }) => api('GET', `/api/task/${encodeURIComponent(task_id)}?view=notes`),
  },
  {
    name: 'workflow_get_attachments',
    description: 'List image attachments [{name,url}]. Empty if none.',
    inputSchema: { type: 'object', properties: idArg, required: ['task_id'] },
    handler: async ({ task_id }) => api('GET', `/api/task/${encodeURIComponent(task_id)}/attachments`),
  },
  {
    name: 'workflow_set_subtasks',
    description: 'Replace Subtasks checklist. items: [{text, checked?}].',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, checked: { type: 'boolean' } }, required: ['text'] } },
      },
      required: ['task_id', 'items'],
    },
    handler: async ({ task_id, items }) => api('POST', `/api/task/${encodeURIComponent(task_id)}/subtasks`, { items }),
  },
  {
    name: 'workflow_complete_subtask',
    description: 'Tick subtask by 0-based index.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, index: { type: 'integer', minimum: 0 }, checked: { type: 'boolean' } },
      required: ['task_id', 'index'],
    },
    handler: async ({ task_id, index, checked = true }) => {
      const t = await api('GET', `/api/task/${encodeURIComponent(task_id)}?view=brief`);
      const items = (t.subtasks || []).map((s, i) => ({ text: s.text, checked: i === index ? !!checked : !!s.checked }));
      if (index >= items.length) throw new Error(`index ${index} out of range (have ${items.length})`);
      return api('POST', `/api/task/${encodeURIComponent(task_id)}/subtasks`, { items });
    },
  },
  {
    name: 'workflow_append_note',
    description: 'Append markdown to Notes section.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, text: { type: 'string' } },
      required: ['task_id', 'text'],
    },
    handler: async ({ task_id, text }) => api('POST', `/api/task/${encodeURIComponent(task_id)}/note`, { text }),
  },
  {
    name: 'workflow_submit_for_verify',
    description: 'in-progress → verifying. summary appended to Notes.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, summary: { type: 'string' } },
      required: ['task_id'],
    },
    handler: async ({ task_id, summary }) => api('POST', `/api/task/${encodeURIComponent(task_id)}/submit`, {
      summary: summary || '', instance_id: INSTANCE_ID || undefined,
    }),
  },
  {
    name: 'workflow_set_how_to_verify',
    description: 'Replace the "How to verify" section of the task with a user-facing checklist. Call this AFTER auto-verify passes — the user reads this to manually validate runtime behavior.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, content: { type: 'string' } },
      required: ['task_id', 'content'],
    },
    handler: async ({ task_id, content }) => api('POST', `/api/task/${encodeURIComponent(task_id)}/how-to-verify`, { content }),
  },
  {
    name: 'workflow_next_task',
    description: 'Pop next queued task for this agent and atomically claim it. Use inside the spawned-agent loop. Returns { empty: true } if queue empty, otherwise { task_id, status, attempts }.',
    inputSchema: {
      type: 'object',
      properties: {
        assignee: { type: 'string', description: 'agent slug; defaults to $WORKFLOW_AGENT' },
        instance_id: { type: 'string', description: 'instance id; defaults to $WORKFLOW_INSTANCE_ID' },
      },
    },
    handler: async ({ assignee, instance_id }) => {
      const a = assignee || AGENT;
      const i = instance_id || INSTANCE_ID;
      if (!a) throw new Error('assignee required (no WORKFLOW_AGENT in env)');
      const r = await api('POST', '/api/next-task', { assignee: a, instance_id: i });
      if (r.empty) return { empty: true };
      const briefRaw = await api('GET', `/api/task/${encodeURIComponent(r.task_id)}?view=brief`);
      const brief = compactBrief(briefRaw);
      const out = { task_id: r.task_id, status: r.status, attempts: r.attempts, brief };
      if (Number(brief.attempts) > 0) {
        const notes = await api('GET', `/api/task/${encodeURIComponent(r.task_id)}?view=notes`);
        const m = /### Reject —[\s\S]*?(?=###|\s*$)/g.exec(notes.notes || '');
        if (m) out.rework = m[0].trim();
      }
      // Protocol is static; ship it only on the first task per instance.
      if (r.first_call) out.protocol = PROTOCOL;
      return out;
    },
  },
];

// ---------- Orchestrator tools ----------
// /iterate-mode: one Claude session owns the iteration end-to-end. These three
// tools cover the hot path so the orchestrator never has to glob/Read/Edit
// task files or run git itself.
tools.push(
  {
    name: 'workflow_iteration_load',
    description: 'Load the active iteration (or a specific track+id) with every task unpacked and a dependency graph. One call replaces glob+read of README and every T###-*.md. Use at the start of /iterate.',
    inputSchema: {
      type: 'object',
      properties: {
        track: { type: 'string', description: 'Track slug (optional — auto-detect if omitted).' },
        id: { type: 'string', description: 'Iteration id like "001" (optional).' },
      },
    },
    handler: async ({ track, id }) => {
      const qs = [];
      if (track) qs.push(`track=${encodeURIComponent(track)}`);
      if (id) qs.push(`id=${encodeURIComponent(id)}`);
      const path = '/api/iteration/load' + (qs.length ? `?${qs.join('&')}` : '');
      return api('GET', path);
    },
  },
  {
    name: 'workflow_task_done',
    description: 'Mark a task done in the orchestrator flow: status=done + summary appended to Notes. NO git work — the iteration is committed as one big commit later via workflow_iteration_submit. Replaces manual frontmatter edit.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        summary: { type: 'string', description: '1-3 lines on what was done; appended to Notes and reused in the iteration commit body.' },
      },
      required: ['task_id'],
    },
    handler: async ({ task_id, summary }) =>
      api('POST', `/api/task/${encodeURIComponent(task_id)}/done`, { summary }),
  },
  {
    name: 'workflow_iteration_submit',
    description: 'Final step of /iterate: ONE commit covering every done task in this iteration (their expected_files + task .md files + iteration README with status flipped). Bumps iteration status to done|abandoned and clears the track\'s ACTIVE pointer. No push — the user runs `git push` manually. Call only after the user explicitly approves the iteration.',
    inputSchema: {
      type: 'object',
      properties: {
        track: { type: 'string' },
        id: { type: 'string' },
        summary: { type: 'string', description: 'Iteration-level summary; lands in the commit body above the task list.' },
        status: { type: 'string', enum: ['done', 'abandoned'], default: 'done' },
        author: { type: 'string', description: 'Override commit author. Defaults to "orchestrator <orchestrator@workflow.local>".' },
      },
      required: ['track', 'id'],
    },
    handler: async ({ track, id, summary, status, author }) =>
      api('POST', '/api/iteration/submit', { track, id, summary, status: status || 'done', author }),
  },
);

if (UNITY) {
  tools.push(
    {
      name: 'workflow_unity_log_mark',
      description: 'Snapshot the current Unity Editor.log offset. Save the result and pass it to workflow_unity_log_since after running an action so you only see lines your action produced (not other agents).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { logMark } = await import('../lib/unity_log.mjs');
        return logMark();
      },
    },
    {
      name: 'workflow_unity_log_since',
      description: 'Read Unity Editor.log lines appended since a prior mark. Optional grep regex filter. Returns { lines, errors, warnings }.',
      inputSchema: {
        type: 'object',
        properties: {
          mark: { type: 'object', description: 'Result of workflow_unity_log_mark' },
          grep: { type: 'string', description: 'Optional regex (case-insensitive) to filter lines' },
          limit: { type: 'integer', minimum: 1, default: 200 },
        },
        required: ['mark'],
      },
      handler: async ({ mark, grep, limit = 200 }) => {
        const { readLogSince, classifyLines } = await import('../lib/unity_log.mjs');
        const lines = readLogSince(mark, { grep, limit });
        const cls = classifyLines(lines);
        return { lines, errors: cls.errors, warnings: cls.warnings };
      },
    },
  );
}

// ---------- JSON-RPC dispatch ----------
async function handle(msg) {
  if (msg.method === 'initialize') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'workflow', version: '0.1.0' },
      },
    });
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      },
    });
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params || {};
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown tool: ${name}` } });
    }
    try {
      const out = await tool.handler(args);
      return send({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify(out) }] },
      });
    } catch (e) {
      return send({
        jsonrpc: '2.0', id: msg.id,
        result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] },
      });
    }
  }
  if (msg.id != null) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method: ${msg.method}` } });
  }
}

log(`up · kanban=${KANBAN} · root=${ROOT}${UNITY ? ' · unity' : ''}`);

// Bind the real claude.exe PID to this instance. The MCP server is spawned
// directly by claude (`.mcp.json` runs `node <path>`), so process.ppid is the
// persistent claude process — not a transient wrapper, unlike Stop/SessionStart
// hooks which go through workflow.cmd → node workflow.mjs → node hook.mjs and
// see a short-lived intermediate parent. Posted once at startup so the
// instance monitor can do reliable pidAlive() checks instead of guessing from
// transcript mtime.
if (INSTANCE_ID && process.ppid) {
  api('POST', `/api/instance/${encodeURIComponent(INSTANCE_ID)}/heartbeat`, { claude_pid: process.ppid })
    .then(() => log(`bound claude_pid=${process.ppid} to instance ${INSTANCE_ID}`))
    .catch(e => log(`bind claude_pid failed: ${e.message}`));
}
