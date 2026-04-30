// Unity verify_queue runner.
//
// Runs the Unity-touching verify step under the queue's `unity_editor` mutex
// so it never overlaps with another agent. Uses the agent-supplied argv to
// invoke Unity (typically `Unity.exe -batchmode -runTests -projectPath ...`)
// inside the task's worktree, then captures the Editor.log delta to give the
// agent (and the user) clean attribution of any errors.
//
// Job payload shape:
//   {
//     argv: ["C:/Program Files/Unity/Editor/Unity.exe", "-batchmode", ...],
//     cwd?: "<worktree-relative path>",   // defaults to worktree root
//     timeout_ms?: number,                  // default 15min
//     log_grep?: string,                    // optional regex filter for the log slice
//   }

import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { worktreePath } from './worktrees.mjs';
import { logMark, readLogSince, classifyLines } from './unity_log.mjs';
import { logger } from './logger.mjs';

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

function runArgv(argv, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (!cmd) return resolve({ code: -1, stdout: '', stderr: 'empty argv' });
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let stdout = ''; let stderr = '';
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString('utf-8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf-8'); });
    child.on('error', e => {
      clearTimeout(t);
      resolve({ code: -1, stdout, stderr: stderr + `\nspawn error: ${e.message}`, timedOut });
    });
    child.on('close', code => {
      clearTimeout(t);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export async function unityRunner(job) {
  const argv = Array.isArray(job.payload?.argv) ? job.payload.argv : null;
  if (!argv || !argv.length) {
    return { passed: false, log: 'unity job missing payload.argv (Unity invocation command)' };
  }
  const wt = worktreePath(job.task_id);
  const cwd = job.payload.cwd
    ? path.resolve(wt, job.payload.cwd)
    : wt;

  const mark = logMark();
  const timeoutMs = Number(job.payload.timeout_ms) || DEFAULT_TIMEOUT_MS;
  logger.info('unity_runner', `task=${job.task_id} argv=${argv[0]} cwd=${cwd}`);

  const r = await runArgv(argv, cwd, timeoutMs);
  const slice = readLogSince(mark, { grep: job.payload.log_grep, limit: 400 });
  const cls = classifyLines(slice);

  const passed = !r.timedOut && r.code === 0 && cls.errors.length === 0;
  const summary = [
    `exit=${r.code}${r.timedOut ? ' (TIMED OUT)' : ''}`,
    `errors=${cls.errors.length} warnings=${cls.warnings.length}`,
  ].join('  ');

  // Trim noisy fields. The agent's transcript will see the verdict + a bounded
  // tail of stdout/stderr + the classified log slice.
  const tail = (s, n = 40) => {
    const lines = String(s || '').split(/\r?\n/);
    return lines.slice(-n).join('\n');
  };

  const log = [
    `Unity verify — ${summary}`,
    '',
    cls.errors.length ? `## Editor.log errors\n${cls.errors.slice(0, 20).join('\n')}` : '',
    cls.warnings.length ? `## Editor.log warnings (top 10)\n${cls.warnings.slice(0, 10).join('\n')}` : '',
    r.stdout.trim() ? `## stdout (tail)\n${tail(r.stdout)}` : '',
    r.stderr.trim() ? `## stderr (tail)\n${tail(r.stderr)}` : '',
  ].filter(Boolean).join('\n\n');

  return {
    passed,
    log,
    details: {
      exit_code: r.code,
      timed_out: r.timedOut,
      error_count: cls.errors.length,
      warning_count: cls.warnings.length,
    },
  };
}
