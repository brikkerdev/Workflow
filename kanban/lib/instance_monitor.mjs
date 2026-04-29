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

    // PID gone but on Windows the launcher PID is gone almost immediately, so
    // also lean on staleness of last_seen. If we have a fresh heartbeat treat
    // as alive regardless of PID.
    const lastSeen = Date.now() - new Date(inst.last_seen || inst.started_at || 0).getTime();
    if (lastSeen < 90_000) continue;

    const recovered = recoverTask(inst);
    if (recovered) {
      process.stderr.write(`[monitor] instance ${inst.id} dead — re-queued ${inst.current_task_id}\n`);
    }
    const wantsRespawn = !!inst.respawn_requested;
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
