// Periodically check liveness of agent instances. If an instance terminal
// process is gone:
//   - re-queue its in-progress task (status -> queued, attempts++).
//   - if respawn_requested, fire a fresh spawn for the same agent.
//   - otherwise remove the dead instance record.

import {
  listInstances, getInstance, updateInstance, removeInstance,
  markDead, pidAlive,
} from './instances.mjs';
import { findTask, saveTask } from './repo.mjs';
import { writeTrigger, peekNextForAssignee } from './queue.mjs';
import { deleteSnapshot } from './snapshot.mjs';
import { broadcastChange } from './http.mjs';
import { ROOT } from './config.mjs';

const TICK_MS = 5000;

async function spawnFresh(agent) {
  try {
    const { spawnInstance } = await import('../../bin/spawner.mjs');
    const { createInstance, updateInstance: upd } = await import('./instances.mjs');
    const inst = createInstance({ agent });
    const { terminalPid } = await spawnInstance({ agent, instanceId: inst.id, project: ROOT });
    upd(inst.id, { terminal_pid: terminalPid });
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
    const { terminalPid } = await spawnInstance({
      agent: inst.agent,
      instanceId: inst.id,
      project: ROOT,
      resumeSessionId: inst.session_id,
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

    if (inst.terminal_pid && pidAlive(inst.terminal_pid)) continue;

    // On Windows the launcher PID dies near-instantly, so also trust a fresh
    // heartbeat as proof of life regardless of PID.
    const lastSeen = Date.now() - new Date(inst.last_seen || inst.started_at || 0).getTime();
    if (lastSeen < 90_000) continue;

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

export function startInstanceMonitor() {
  setInterval(() => { tick().catch(e => process.stderr.write(`[monitor] ${e.stack || e}\n`)); }, TICK_MS);
}
