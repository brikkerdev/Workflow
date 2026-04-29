// Periodically check liveness of agent instances. If an instance terminal
// process is gone:
//   - re-queue its in-progress task (status -> queued, attempts++).
//   - if respawn_requested, fire a fresh spawn for the same agent.
//   - otherwise remove the dead instance record.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listInstances, getInstance, updateInstance, removeInstance,
  markDead, pidAlive,
} from './instances.mjs';
import { findTask, saveTask } from './repo.mjs';
import { writeTrigger, peekNextForAssignee } from './queue.mjs';
import { deleteSnapshot } from './snapshot.mjs';
import { broadcastChange } from './http.mjs';
import { ROOT } from './config.mjs';

// Claude Code writes a JSONL transcript per session at
// ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl. Its mtime advances on
// every assistant message + tool result, so it's the most reliable liveness
// signal we have on Windows where the spawned cmd.exe PID dies instantly.
function transcriptMtime(sessionId) {
  if (!sessionId) return 0;
  const dir = path.join(os.homedir(), '.claude', 'projects', ROOT.replace(/[^A-Za-z0-9]/g, '-'));
  const fp = path.join(dir, `${sessionId}.jsonl`);
  try { return fs.statSync(fp).mtimeMs; }
  catch { return 0; }
}

const TICK_MS = 5000;

async function spawnFresh(agent) {
  try {
    const { spawnInstance } = await import('../../bin/spawner.mjs');
    const { createInstance, updateInstance: upd } = await import('./instances.mjs');
    const { getAgentModel } = await import('./repo.mjs');
    const inst = createInstance({ agent });
    const model = getAgentModel(agent);
    const { terminalPid } = await spawnInstance({ agent, instanceId: inst.id, project: ROOT, model });
    upd(inst.id, { terminal_pid: terminalPid, model: model || null });
    broadcastChange('instances', { kind: 'respawn', instance_id: inst.id, agent });
    return inst.id;
  } catch (e) {
    process.stderr.write(`[monitor] respawn failed for ${agent}: ${e.message}\n`);
    return null;
  }
}

// Reopen the SAME claude session in a new terminal. Keeps the registry record
// (id, current_task_id, session_id) — only the terminal_pid changes. Used when
// a user accidentally closed the terminal so we don't burn fresh tokens
// rebooting the agent's context.
async function resumeInPlace(inst) {
  if (!inst.session_id) return false;
  try {
    const { spawnInstance } = await import('../../bin/spawner.mjs');
    const { getAgentModel } = await import('./repo.mjs');
    const model = inst.model || getAgentModel(inst.agent);
    const { terminalPid } = await spawnInstance({
      agent: inst.agent,
      instanceId: inst.id,
      project: ROOT,
      resumeSessionId: inst.session_id,
      model,
    });
    updateInstance(inst.id, {
      terminal_pid: terminalPid,
      status: inst.current_task_id ? 'working' : 'idle',
      exit_reason: null,
    });
    broadcastChange('instances', { kind: 'resumed', instance_id: inst.id, agent: inst.agent });
    process.stderr.write(`[monitor] resumed session ${inst.session_id.slice(0,8)} for ${inst.id}\n`);
    return true;
  } catch (e) {
    process.stderr.write(`[monitor] resume failed for ${inst.id}: ${e.message}\n`);
    return false;
  }
}

function recoverTask(inst) {
  if (!inst.current_task_id) return false;
  const [p, fm, body] = findTask(inst.current_task_id);
  if (!p) return false;
  if (fm.status !== 'in-progress' && fm.status !== 'verifying') return false;
  fm.status = 'queued';
  fm.attempts = Number(fm.attempts || 0) + 1;
  saveTask(p, fm, body);
  writeTrigger(inst.current_task_id, fm, p, { reason: `instance_dead:${inst.id}` });
  try { deleteSnapshot(inst.current_task_id); } catch {}
  return true;
}

async function tick() {
  for (const inst of listInstances()) {
    if (inst.status === 'dead') continue;

    // Auto-respawn cleanly-exited idle instances when new work appears for their agent.
    if (inst.status === 'idle_exited') {
      if (peekNextForAssignee(inst.agent)) {
        process.stderr.write(`[monitor] respawning idle ${inst.agent} (instance ${inst.id}) — queue has work\n`);
        removeInstance(inst.id);
        await spawnFresh(inst.agent);
      }
      continue;
    }

    // Grace period for fresh records — `cmd /c start` returns near-instantly on
    // Windows and the recorded PID is the launcher, not the new window. Give
    // Claude time to come up and report a heartbeat / status update.
    const ageMs = Date.now() - new Date(inst.started_at || 0).getTime();
    if (ageMs < 15000) continue;

    // claude_pid is bound by the MCP server at startup (process.ppid there is
    // the persistent claude.exe — MCP is spawned directly, no wrapper chain).
    // Alive PID is authoritative; dead PID still gets a transcript sanity-check
    // because old records may carry a stale PID from a previous hook chain
    // that mis-identified the parent.
    const now = Date.now();
    if (inst.claude_pid) {
      if (pidAlive(inst.claude_pid)) continue;
      const tMtime = transcriptMtime(inst.session_id);
      if (tMtime && (now - tMtime) < 5 * 60_000) {
        // PID dead but agent is clearly working — drop the bad PID, let the
        // next MCP startup or transcript tick rebind it.
        process.stderr.write(`[monitor] ${inst.id}: claude_pid ${inst.claude_pid} dead but transcript fresh — clearing stale PID\n`);
        updateInstance(inst.id, { claude_pid: null });
        continue;
      }
      // PID dead AND transcript stale → genuinely gone. Fall through.
    } else {
      // No claude_pid bound yet (early startup, or pre-MCP-bind). Use the
      // legacy fallbacks until MCP comes up.
      if (inst.terminal_pid && pidAlive(inst.terminal_pid)) continue;
      const lastSeen = now - new Date(inst.last_seen || inst.started_at || 0).getTime();
      if (lastSeen < 5 * 60_000) continue;
      const tMtime = transcriptMtime(inst.session_id);
      if (tMtime && (now - tMtime) < 5 * 60_000) continue;
    }

    const wantsRespawn = !!inst.respawn_requested;

    // Accidental close: terminal/session is gone, we have a session_id, and
    // no one explicitly asked for a fresh session. Reopen the same session.
    if (!wantsRespawn && inst.session_id) {
      const ok = await resumeInPlace(inst);
      if (ok) continue;
    }

    const recovered = recoverTask(inst);
    if (recovered) {
      process.stderr.write(`[monitor] instance ${inst.id} dead — re-queued ${inst.current_task_id}\n`);
    }
    markDead(inst.id, inst.exit_reason || 'pid_gone');
    broadcastChange('instances', { kind: 'dead', instance_id: inst.id });
    if (wantsRespawn) {
      removeInstance(inst.id);
      await spawnFresh(inst.agent);
    } else {
      const sinceDead = Date.now() - new Date(inst.last_seen || inst.started_at || 0).getTime();
      if (sinceDead > 60_000) removeInstance(inst.id);
    }
  }
}

// Server restart rehydration: instance records survive on disk, but their
// last_seen / terminal_pid are stale relative to the new server process.
// Walk the registry, peek at each instance's transcript file, and if it was
// touched in the recent past — assume Claude is still alive and refresh
// last_seen so the monitor doesn't immediately declare it dead.
function rehydrateInstances() {
  const now = Date.now();
  const FRESH_WINDOW = 30 * 60_000; // 30 min — covers a long pause between turns
  for (const inst of listInstances()) {
    if (inst.status === 'dead') continue;
    // If we have a claude_pid bound, trust the OS — alive PID means the
    // agent survived the server restart, no need to inspect the transcript.
    if (inst.claude_pid && pidAlive(inst.claude_pid)) {
      updateInstance(inst.id, { last_seen: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') });
      process.stderr.write(`[monitor] rehydrated ${inst.id} (${inst.agent}) — claude_pid ${inst.claude_pid} alive\n`);
      continue;
    }
    const mt = transcriptMtime(inst.session_id);
    if (mt && (now - mt) < FRESH_WINDOW) {
      // Reset last_seen to now so the standard tick gives this session a full
      // 5-minute grace from this point. Drop stale terminal_pid so the
      // monitor leans on transcript mtime (the launcher PID is meaningless
      // after a server restart anyway).
      updateInstance(inst.id, { last_seen: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), terminal_pid: null });
      process.stderr.write(`[monitor] rehydrated ${inst.id} (${inst.agent}) — transcript touched ${Math.round((now - mt) / 1000)}s ago\n`);
    } else if (inst.session_id) {
      // Transcript stale or missing — leave the record so the regular tick
      // handles dead-detection (re-queue + respawn or prune).
      process.stderr.write(`[monitor] stale ${inst.id} (${inst.agent}) — transcript ${mt ? Math.round((now - mt) / 1000) + 's old' : 'missing'}\n`);
    }
  }
}

export function startInstanceMonitor() {
  rehydrateInstances();
  setInterval(() => { tick().catch(e => process.stderr.write(`[monitor] ${e.stack || e}\n`)); }, TICK_MS);
}
