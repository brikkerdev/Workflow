#!/usr/bin/env node
// Workflow Kanban server. Pure Node.js — no npm deps.
// Project root: --project <path> | $WORKFLOW_PROJECT | cwd
// Usage: node kanban/server.mjs [--port 7777] [--host 127.0.0.1] [--project <path>]

import http from 'node:http';
import url from 'node:url';
import fs from 'node:fs';
import { ROOT, WORKFLOW } from './lib/config.mjs';
import { logger } from './lib/logger.mjs';
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
  handleAutoVerifyStart, handleAutoVerifyResult, handleHowToVerify, handleVerifyQueueList,
  handleIterCloseAuto, handleIterChecklistRead, handleIterChecklistWrite, handleIterStart,
  handleIterFinalizeInfo, handleIterFinalize,
  applyVerifyJobResult,
  handleInstancesList, handleInstanceGet, handleInstanceSpawn, handleInstanceKill,
  handleInstanceHeartbeat, handleInstanceRespawn, handleInstancePrecompact,
  handleAgentLoopDecide, handleNextTask,
} from './lib/handlers.mjs';
import { startInstanceMonitor } from './lib/instance_monitor.mjs';
import { startStatsPoller } from './lib/stats_poller.mjs';
import { startVerifyWorker, registerRunner, deleteJob as deleteVerifyJob } from './lib/verify_queue.mjs';
import { unityRunner } from './lib/unity_runner.mjs';

function matchAttachment(p) {
  const m = /^\/api\/task\/([^/]+)\/attachments(?:\/(.+))?$/.exec(p);
  if (!m) return null;
  return { tid: decodeURIComponent(m[1]), name: m[2] ? decodeURIComponent(m[2]) : null };
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  logger.info('kanban', `${req.method} ${p}`);

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
      if (p === '/api/instances') return handleInstancesList(res);
      if (p === '/api/verify-queue') return handleVerifyQueueList(res);

      let m;
      m = /^\/api\/instance\/([^/]+)$/.exec(p);
      if (m) return handleInstanceGet(res, decodeURIComponent(m[1]));
      m = /^\/api\/agent\/([^/]+)$/.exec(p);
      if (m) return handleAgent(res, decodeURIComponent(m[1]));
      m = /^\/api\/track\/([^/]+)$/.exec(p);
      if (m) return handleTrack(res, decodeURIComponent(m[1]));
      m = /^\/api\/track\/([^/]+)\/iteration\/([^/]+)\/checklist$/.exec(p);
      if (m) return handleIterChecklistRead(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      m = /^\/api\/track\/([^/]+)\/iteration\/([^/]+)\/finalize-info$/.exec(p);
      if (m) return handleIterFinalizeInfo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));

      const att = matchAttachment(p);
      if (att) {
        if (att.name) return handleReadAttachment(res, att.tid, att.name);
        return handleListAttachments(res, att.tid);
      }
      if (p.startsWith('/api/task/')) return handleTask(res, decodeURIComponent(p.split('/').pop()), u.query);
    } else if (req.method === 'POST') {
      // task lifecycle actions
      let m = /^\/api\/task\/([^/]+)\/(dispatch|verify|claim|submit|note|subtasks|stats|auto-verify-start|auto-verify-result|how-to-verify)$/.exec(p);
      if (m) {
        const tid = decodeURIComponent(m[1]); const action = m[2];
        if (action === 'dispatch') return handleDispatch(res, tid);
        if (action === 'verify') return handleVerify(req, res, tid);
        if (action === 'claim') return handleClaim(req, res, tid);
        if (action === 'submit') return handleSubmitVerify(req, res, tid);
        if (action === 'note') return handleAppendNote(req, res, tid);
        if (action === 'subtasks') return handleSubtasks(req, res, tid);
        if (action === 'stats') return handleRecordStats(req, res, tid);
        if (action === 'auto-verify-start') return handleAutoVerifyStart(req, res, tid);
        if (action === 'auto-verify-result') return handleAutoVerifyResult(req, res, tid);
        if (action === 'how-to-verify') return handleHowToVerify(req, res, tid);
      }

      // tracks
      if (p === '/api/tracks') return handleTrackCreate(req, res);

      // agents
      if (p === '/api/agents') return handleAgentCreate(req, res);

      // instances
      if (p === '/api/instance/spawn') return handleInstanceSpawn(req, res);
      if (p === '/api/agent-loop/decide') return handleAgentLoopDecide(req, res);
      if (p === '/api/next-task') return handleNextTask(req, res);
      m = /^\/api\/instance\/([^/]+)\/(kill|heartbeat|respawn|precompact)$/.exec(p);
      if (m) {
        const id = decodeURIComponent(m[1]); const action = m[2];
        if (action === 'kill') return handleInstanceKill(req, res, id);
        if (action === 'heartbeat') return handleInstanceHeartbeat(req, res, id);
        if (action === 'respawn') return handleInstanceRespawn(req, res, id);
        if (action === 'precompact') return handleInstancePrecompact(req, res, id);
      }

      // iterations under a track
      m = /^\/api\/track\/([^/]+)\/iterations$/.exec(p);
      if (m) return handleIterCreate(req, res, decodeURIComponent(m[1]));
      m = /^\/api\/track\/([^/]+)\/iterations\/reorder$/.exec(p);
      if (m) return handleIterReorder(req, res, decodeURIComponent(m[1]));
      m = /^\/api\/track\/([^/]+)\/iteration\/([^/]+)\/(activate|archive|close-auto|start|finalize)$/.exec(p);
      if (m) {
        const ts = decodeURIComponent(m[1]); const iid = decodeURIComponent(m[2]); const action = m[3];
        if (action === 'activate') return handleIterActivate(res, ts, iid);
        if (action === 'archive') return handleIterArchive(req, res, ts, iid);
        if (action === 'close-auto') return handleIterCloseAuto(req, res, ts, iid);
        if (action === 'start') return handleIterStart(req, res, ts, iid);
        if (action === 'finalize') return handleIterFinalize(req, res, ts, iid);
      }
      m = /^\/api\/track\/([^/]+)\/iteration\/([^/]+)\/tasks$/.exec(p);
      if (m) return handleTaskCreate(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));

      const att = matchAttachment(p);
      if (att && !att.name) return handleUploadAttachment(req, res, att.tid);
    } else if (req.method === 'PUT') {
      let m = /^\/api\/track\/([^/]+)\/iteration\/([^/]+)\/checklist$/.exec(p);
      if (m) return handleIterChecklistWrite(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
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
    logger.error('kanban', 'unhandled request error', e);
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
  logger.error('kanban', `no .workflow/ dir at ${WORKFLOW}`);
  process.exit(1);
}

logger.info('kanban', `root: ${ROOT}`);
logger.info('kanban', `open http://${args.host}:${args.port}`);
server.listen(args.port, args.host);
startInstanceMonitor();
startStatsPoller();

registerRunner('unity', unityRunner);

startVerifyWorker((job, result) => {
  try {
    applyVerifyJobResult(job, result);
  } catch (e) {
    logger.error('kanban', `applyVerifyJobResult failed for ${job.id}`, e);
  }
  // Whatever happened, retire the job from disk now that the task carries the outcome.
  deleteVerifyJob(job.id);
});

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
  logger.warn('kanban', `fs.watch unavailable: ${e.message}`);
  logger.warn('kanban', 'live board updates disabled — refresh manually');
}

function shutdown() { logger.info('kanban', 'bye'); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
