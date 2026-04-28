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

const KANBAN = (process.env.WORKFLOW_KANBAN || 'http://127.0.0.1:7777').replace(/\/$/, '');
const ROOT = path.resolve(process.env.WORKFLOW_PROJECT || process.cwd());

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
    catch { continue; }
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

// ---------- tool definitions ----------
const tools = [
  {
    name: 'workflow_get_task',
    description: 'Read full task: frontmatter, sections (Goal, Context, Acceptance criteria, How to verify, Notes), subtasks list, attempts.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    handler: async ({ task_id }) => api('GET', `/api/task/${encodeURIComponent(task_id)}`),
  },
  {
    name: 'workflow_claim_task',
    description: 'Mark a queued task as in-progress (call this first when you start working). Removes its dispatch trigger. Returns current attempts counter.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    handler: async ({ task_id }) => api('POST', `/api/task/${encodeURIComponent(task_id)}/claim`, {}),
  },
  {
    name: 'workflow_set_subtasks',
    description: 'Replace the Subtasks section with a fresh checklist. Use this once after claim to lay out your plan. Items: [{text, checked?}]',
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
    description: 'Mark subtask at given 0-based index as done. Reads current list, flips one checkbox, writes back.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        index: { type: 'integer', minimum: 0 },
        checked: { type: 'boolean', description: 'default true' },
      },
      required: ['task_id', 'index'],
    },
    handler: async ({ task_id, index, checked = true }) => {
      const t = await api('GET', `/api/task/${encodeURIComponent(task_id)}`);
      const items = (t._subtasks || []).map((s, i) => ({ text: s.text, checked: i === index ? !!checked : !!s.checked }));
      if (index >= items.length) throw new Error(`index ${index} out of range (have ${items.length})`);
      return api('POST', `/api/task/${encodeURIComponent(task_id)}/subtasks`, { items });
    },
  },
  {
    name: 'workflow_append_note',
    description: 'Append free-form markdown to the task Notes section. Use for decisions, findings, files touched.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, text: { type: 'string' } },
      required: ['task_id', 'text'],
    },
    handler: async ({ task_id, text }) => api('POST', `/api/task/${encodeURIComponent(task_id)}/note`, { text }),
  },
  {
    name: 'workflow_submit_for_verify',
    description: 'Move task from in-progress to verifying so the user can run verification. Pass a brief summary that will be appended to Notes.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, summary: { type: 'string' } },
      required: ['task_id'],
    },
    handler: async ({ task_id, summary }) => api('POST', `/api/task/${encodeURIComponent(task_id)}/submit`, { summary: summary || '' }),
  },
  {
    name: 'workflow_list_queue',
    description: 'List pending dispatch triggers (rework + new). Each item: task_id, assignee, attempts, reason, rework_notes.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => api('GET', `/api/queue`),
  },
  {
    name: 'workflow_project_info',
    description: 'Project name and absolute root path.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const p = await api('GET', `/api/project`).catch(() => ({}));
      return { ...p, mcp_root: ROOT };
    },
  },
];

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
        result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] },
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

log(`up · kanban=${KANBAN} · root=${ROOT}`);
