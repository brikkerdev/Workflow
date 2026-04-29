// Cross-platform terminal spawner for agent instances.
// Usage:
//   const { terminalPid } = await spawnInstance({ agent, instanceId, project });
//
// Opens a new terminal window in the project dir running:
//   claude "/agent-loop <agent> <instanceId>"
// with WORKFLOW_PROJECT, WORKFLOW_INSTANCE_ID, WORKFLOW_AGENT, WORKFLOW_KANBAN env.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function findOnPath(name) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

function findLinuxTerminal() {
  const hint = process.env.TERM_PROGRAM || process.env.TERMINAL || '';
  const candidates = [hint, 'kitty', 'alacritty', 'wezterm', 'gnome-terminal', 'konsole', 'tilix', 'xterm'];
  for (const name of candidates) {
    if (!name) continue;
    if (findOnPath(name)) return name;
  }
  return null;
}

export async function spawnInstance({ agent, instanceId, project, kanbanUrl = 'http://127.0.0.1:7777', resumeSessionId = null, model = null }) {
  const claudePath = findOnPath('claude');
  if (!claudePath) throw new Error('claude not found on PATH');
  // When resuming a prior session: just `claude --resume <session_id>` — Claude
  // restores the conversation, no fresh /agent-loop prompt needed (it's already
  // in context). When starting fresh: run the slash command as the first turn.
  // The slash command itself reads identifiers from env (WORKFLOW_AGENT,
  // WORKFLOW_INSTANCE_ID), so no positional args are needed and we sidestep
  // any quoting/substitution surprises.
  const baseArgs = resumeSessionId
    ? ['--resume', resumeSessionId]
    : ['/agent-loop'];
  // Auto-approve all MCP tools for spawned instances so Sonnet (no auto-mode)
  // doesn't stall on permission prompts inside the agent loop. Scoped to the
  // spawn — interactive sessions outside the loop are unaffected.
  const permArgs = ['--allowedTools', 'mcp__*'];
  // `--model` honours the agent's declared tier (opus/sonnet/haiku or full id).
  // Skipped when null so we don't override the user's default for unset agents.
  const modelArgs = model ? ['--model', model] : [];
  const claudeArgs = [...modelArgs, ...permArgs, ...baseArgs];
  const env = {
    ...process.env,
    WORKFLOW_PROJECT: project,
    WORKFLOW_INSTANCE_ID: instanceId,
    WORKFLOW_AGENT: agent,
    WORKFLOW_KANBAN: kanbanUrl,
  };

  if (process.platform === 'win32') {
    const title = `workflow:${agent}:${instanceId}`;
    const child = spawn(
      'cmd.exe',
      ['/c', 'start', `"${title}"`, '/D', project, claudePath, ...claudeArgs],
      { cwd: project, detached: true, stdio: 'ignore', env, windowsHide: false },
    );
    child.unref();
    return { terminalPid: child.pid };
  }

  if (process.platform === 'linux') {
    const term = findLinuxTerminal();
    if (!term) throw new Error('no terminal emulator found (tried kitty, alacritty, wezterm, gnome-terminal, konsole, tilix, xterm)');
    let args;
    if (term === 'kitty')              args = ['-d', project, claudePath, ...claudeArgs];
    else if (term === 'alacritty')     args = ['--working-directory', project, '-e', claudePath, ...claudeArgs];
    else if (term === 'wezterm')       args = ['start', '--cwd', project, '--', claudePath, ...claudeArgs];
    else if (term === 'gnome-terminal') args = ['--working-directory', project, '--', claudePath, ...claudeArgs];
    else if (term === 'konsole')       args = ['--workdir', project, '-e', claudePath, ...claudeArgs];
    else                                args = ['-e', claudePath, ...claudeArgs];
    const child = spawn(term, args, { cwd: project, detached: true, stdio: 'ignore', env });
    child.unref();
    return { terminalPid: child.pid };
  }

  // macOS — Terminal.app via osascript so we can pass arguments.
  const escProject = project.replace(/"/g, '\\"');
  const escClaude = claudePath.replace(/"/g, '\\"');
  const argString = claudeArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
  const envExports = Object.entries({
    WORKFLOW_PROJECT: project,
    WORKFLOW_INSTANCE_ID: instanceId,
    WORKFLOW_AGENT: agent,
    WORKFLOW_KANBAN: kanbanUrl,
  }).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('; ');
  const cmd = `cd "${escProject}" && ${envExports} && "${escClaude}" ${argString}`;
  const script = `tell application "Terminal" to do script ${JSON.stringify(cmd)}`;
  const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore', env });
  child.unref();
  return { terminalPid: child.pid };
}
