#!/usr/bin/env node
// Workflow Kanban server. Pure Node.js — no npm deps.
// Project root: --project <path> | $WORKFLOW_PROJECT | cwd
// Usage: node kanban/server.mjs [--port 7777] [--host 127.0.0.1] [--project <path>]

import http from 'node:http';
import url from 'node:url';
import fs from 'node:fs';
import { ROOT, WORKFLOW } from './lib/config.mjs';
import { exists } from './lib/repo.mjs';
import { sendJson, serveStatic, attachSseClient, broadcastChange } from './lib/http.mjs';
import {
  handleBoard, handleTracks, handleTrack,
  handleTrackCreate, handleTrackUpdate, handleTrackDelete,
  handleIterCreate, handleIterUpdate, handleIterActivate, handleIterArchive, handleIterDelete, handleIterReorder,
  handleTaskCreate, handleTaskDelete,
  handleAgentsList, handleAgent, handleAgentCreate, handleAgentUpdate, handleAgentDelete,
  handleTask, handlePatch, handleDispatch, handleCancelDispatch, handleQueueStatus,
  handleListAttachments, handleUploadAttachment, handleDeleteAttachment, handleReadAttachment,
  handleProject, handleVerify, handleClaim, handleSubmitVerify, handleAppendNote, handleSubtasks,
  handleRecordStats, handleStatsAggregate,
} from './lib/handlers.mjs';

function matchAttachment(p) {
  const m = /^\/api\/task\/([^/]+)\/attachments(?:\/(.+))?$/.exec(p);
  if (!m) return null;
  return { tid: decodeURIComponent(m[1]), name: m[2] ? decodeURIComponent(m[2]) : null };
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  process.stderr.write(`[kanban] ${req.method} ${p}\n`);

  // Auto-broadcast change events after any successful non-GET request.
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        broadcastChange('change', { method: req.method, path: p });
      }
    });
  }

  try {
    if (req.method === 'GET') {
      if (p === '/') return serveStatic(res, 'index.html');
      if (p.startsWith('/static/')) return serveStatic(res, p.slice(1));
      if (p === '/api/events') return attachSseClient(req, res);
      if (p === '/api/board') return handleBoard(res, u.query);
      if (p === '/api/tracks') return handleTracks(res);
      if (p === '/api/queue') return handleQueueStatus(res);
      if (p === '/api/project') return handleProject(res);
      if (p === '/api/agents') return handleAgentsList(res);
      if (p === '/api/stats') return handleStatsAggregate(res);

      let m;
      m = /^\/api\/agent\/([^/]+)$/.exec(p);
      if (m) return handleAgent(res, decodeURIComponent(m[1]));
      m = /^\/api\/track\/([^/]+)$/.exec(p);
      if (m) return handleTrack(res, decodeURIComponent(m[1]));

      const att = matchAttachment(p);
      if (att) {
        if (att.name) return handleReadAttachment(res, att.tid, att.name);
        return handleListAttachments(res, att.tid);
      }
      if (p.startsWith('/api/task/')) return handleTask(res, decodeURIComponent(p.split('/').pop()), u.query);
    } else if (req.method === 'POST') {
      // task lifecycle actions
      let m = /^\/api\/task\/([^/]+)\/(dispatch|verify|claim|submit|note|subtasks|stats)$/.exec(p);
      if (m) {
        const tid = decodeURIComponent(m[1]); const action = m[2];
        if (action === 'dispatch') return handleDispatch(res, tid);
        if (action === 'verify') return handleVerify(req, res, tid);
        if (action === 'claim') return handleClaim(req, res, tid);
        if (action === 'submit') return handleSubmitVerify(req, res, tid);
        if (action === 'note') return handleAppendNote(req, res, tid);
        if (action === 'subtasks') return handleSubtasks(req, res, tid);
        if (action === 'stats') return handleRecordStats(req, res, tid);
      }

      // tracks
      if (p === '/api/tracks') return handleTrackCreate(req, res);

      // agents
      if (p === '/api/agents') return handleAgentCreate(req, res);

      // iterations under a track
      m = /^\/api\/track\/([^/]+)\/iterations$/.exec(p);
      if (m) return handleIterCreate(req, res, decodeURIComponent(m[1]));
      m = /^\/api\/track\/([^/]+)\/iterations\/reorder$/.exec(p);
      if (m) return handleIterReorder(req, res, decodeURIComponent(m[1]));
      m = /^\/api\/track\/([^/]+)\/iteration\/([^/]+)\/(activate|archive)$/.exec(p);
      if (m) {
        const ts = decodeURIComponent(m[1]); const iid = decodeURIComponent(m[2]); const action = m[3];
        if (action === 'activate') return handleIterActivate(res, ts, iid);
        if (action === 'archive') return handleIterArchive(req, res, ts, iid);
      }
      m = /^\/api\/track\/([^/]+)\/iteration\/([^/]+)\/tasks$/.exec(p);
      if (m) return handleTaskCreate(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));

      const att = matchAttachment(p);
      if (att && !att.name) return handleUploadAttachment(req, res, att.tid);
    } else if (req.method === 'PATCH') {
      let m = /^\/api\/track\/([^/]+)$/.exec(p);
      if (m) return handleTrackUpdate(req, res, decodeURIComponent(m[1]));
      m = /^\/api\/track\/([^/]+)\/iteration\/([^/]+)$/.exec(p);
      if (m) return handleIterUpdate(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      m = /^\/api\/agent\/([^/]+)$/.exec(p);
      if (m) return handleAgentUpdate(req, res, decodeURIComponent(m[1]));
      if (p.startsWith('/api/task/')) return handlePatch(req, res, decodeURIComponent(p.split('/').pop()));
    } else if (req.method === 'DELETE') {
      let m = /^\/api\/track\/([^/]+)$/.exec(p);
      if (m) return handleTrackDelete(res, decodeURIComponent(m[1]));
      m = /^\/api\/track\/([^/]+)\/iteration\/([^/]+)$/.exec(p);
      if (m) return handleIterDelete(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      if (p.startsWith('/api/task/') && p.endsWith('/dispatch')) {
        const parts = p.split('/');
        return handleCancelDispatch(res, decodeURIComponent(parts[parts.length - 2]));
      }
      const att = matchAttachment(p);
      if (att && att.name) return handleDeleteAttachment(res, att.tid, att.name);
      m = /^\/api\/task\/([^/]+)$/.exec(p);
      if (m) return handleTaskDelete(res, decodeURIComponent(m[1]));
      m = /^\/api\/agent\/([^/]+)$/.exec(p);
      if (m) return handleAgentDelete(res, decodeURIComponent(m[1]));
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    process.stderr.write(`[kanban] error: ${e.stack || e}\n`);
    return sendJson(res, 500, { error: String(e.message || e) });
  }
});

function parseArgs(argv) {
  const out = { port: parseInt(process.env.KANBAN_PORT || '7777', 10), host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--host') out.host = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!exists(WORKFLOW)) {
  process.stderr.write(`[kanban] no .workflow/ dir at ${WORKFLOW}\n`);
  process.exit(1);
}

console.log(`[kanban] root: ${ROOT}`);
console.log(`[kanban] open http://${args.host}:${args.port}`);
server.listen(args.port, args.host);

// Watch .workflow/ for external edits (agents writing task files etc.)
try {
  let wTimer = null;
  fs.watch(WORKFLOW, { recursive: true, persistent: false }, (event, name) => {
    if (!name) return;
    // Ignore queue trigger churn — already covered by the API broadcast.
    if (name.startsWith('queue/')) return;
    if (wTimer) return;
    wTimer = setTimeout(() => {
      wTimer = null;
      broadcastChange('disk', { name: String(name) });
    }, 200);
  });
} catch (e) {
  process.stderr.write(`[kanban] fs.watch unavailable: ${e.message}\n`);
  process.stderr.write(`[kanban] live board updates disabled — refresh manually\n`);
}

function shutdown() { console.log('\n[kanban] bye'); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
