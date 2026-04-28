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
// Descriptions are kept terse on purpose — tools/list is sent every session.
const idArg = { task_id: { type: 'string' } };

const PROTOCOL = [
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
  '5. workflow_submit_for_verify(id, summary) — when done.',
  'Do NOT git commit/push. Server handles that on user approval.',
].join('\n');

const tools = [
  {
    name: 'workflow_claim_task',
    description: 'Claim queued task → in-progress. Returns brief, protocol, last reject (if rework).',
    inputSchema: { type: 'object', properties: idArg, required: ['task_id'] },
    handler: async ({ task_id }) => {
      const claim = await api('POST', `/api/task/${encodeURIComponent(task_id)}/claim`, {});
      const brief = await api('GET', `/api/task/${encodeURIComponent(task_id)}?view=brief`);
      // If rework, fetch the most recent reject block from Notes.
      let rework = null;
      if (Number(brief.attempts) > 0) {
        const r = await api('GET', `/api/task/${encodeURIComponent(task_id)}?view=notes`);
        const m = /### Reject —[\s\S]*?(?=###|\s*$)/g.exec(r.notes || '');
        if (m) rework = m[0].trim();
      }
      return { protocol: PROTOCOL, brief, rework, status: claim.status };
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
    handler: async ({ task_id, summary }) => api('POST', `/api/task/${encodeURIComponent(task_id)}/submit`, { summary: summary || '' }),
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

log(`up · kanban=${KANBAN} · root=${ROOT}`);
