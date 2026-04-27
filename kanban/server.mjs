#!/usr/bin/env node
// Workflow Kanban server. Pure Node.js — no npm deps.
// Project root: --project <path> | $WORKFLOW_PROJECT | cwd
// Usage: node kanban/server.mjs [--port 7777] [--host 127.0.0.1] [--project <path>]

import http from 'node:http';
import url from 'node:url';
import { ROOT, WORKFLOW } from './lib/config.mjs';
import { exists } from './lib/repo.mjs';
import { sendJson, serveStatic } from './lib/http.mjs';
import {
  handleBoard, handleTracks, handleTask, handlePatch, handleDispatch, handleCancelDispatch, handleQueueStatus,
  handleListAttachments, handleUploadAttachment, handleDeleteAttachment, handleReadAttachment,
  handleProject,
} from './lib/handlers.mjs';

function matchAttachment(p) {
  // /api/task/:id/attachments[/:name]
  const m = /^\/api\/task\/([^/]+)\/attachments(?:\/(.+))?$/.exec(p);
  if (!m) return null;
  return { tid: decodeURIComponent(m[1]), name: m[2] ? decodeURIComponent(m[2]) : null };
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url);
  const p = u.pathname;
  process.stderr.write(`[kanban] ${req.method} ${p}\n`);

  try {
    if (req.method === 'GET') {
      if (p === '/') return serveStatic(res, 'index.html');
      if (p.startsWith('/static/')) return serveStatic(res, p.slice(1));
      if (p === '/api/board') return handleBoard(res);
      if (p === '/api/tracks') return handleTracks(res);
      if (p === '/api/queue') return handleQueueStatus(res);
      if (p === '/api/project') return handleProject(res);
      const att = matchAttachment(p);
      if (att) {
        if (att.name) return handleReadAttachment(res, att.tid, att.name);
        return handleListAttachments(res, att.tid);
      }
      if (p.startsWith('/api/task/')) return handleTask(res, decodeURIComponent(p.split('/').pop()));
    } else if (req.method === 'POST') {
      if (p.startsWith('/api/task/') && p.endsWith('/dispatch')) {
        const parts = p.split('/');
        return handleDispatch(res, decodeURIComponent(parts[parts.length - 2]));
      }
      const att = matchAttachment(p);
      if (att && !att.name) return handleUploadAttachment(req, res, att.tid);
    } else if (req.method === 'PATCH') {
      if (p.startsWith('/api/task/')) return handlePatch(req, res, decodeURIComponent(p.split('/').pop()));
    } else if (req.method === 'DELETE') {
      if (p.startsWith('/api/task/') && p.endsWith('/dispatch')) {
        const parts = p.split('/');
        return handleCancelDispatch(res, decodeURIComponent(parts[parts.length - 2]));
      }
      const att = matchAttachment(p);
      if (att && att.name) return handleDeleteAttachment(res, att.tid, att.name);
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

process.on('SIGINT', () => { console.log('\n[kanban] bye'); process.exit(0); });
