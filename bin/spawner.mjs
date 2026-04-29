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

export async function spawnInstance({ agent, instanceId, project, kanbanUrl = 'http://127.0.0.1:7777' }) {
  const claudePath = findOnPath('claude');
  if (!claudePath) throw new Error('claude not found on PATH');
  const initialPrompt = `/agent-loop ${agent} ${instanceId}`;
  const env = {
    ...process.env,
    WORKFLOW_PROJECT: project,
    WORKFLOW_INSTANCE_ID: instanceId,
    WORKFLOW_AGENT: agent,
    WORKFLOW_KANBAN: kanbanUrl,
  };

  if (process.platform === 'win32') {
    // `start` opens new window. The first quoted arg is the title (must be present).
    // Pass the prompt as a single argument to claude.
    const title = `workflow:${agent}:${instanceId}`;
    const child = spawn(
      'cmd.exe',
      ['/c', 'start', `"${title}"`, '/D', project, claudePath, initialPrompt],
      { cwd: project, detached: true, stdio: 'ignore', env, windowsHide: false },
    );
    child.unref();
    return { terminalPid: child.pid };
  }

  if (process.platform === 'linux') {
    const term = findLinuxTerminal();
    if (!term) throw new Error('no terminal emulator found (tried kitty, alacritty, wezterm, gnome-terminal, konsole, tilix, xterm)');
    let args;
    if (term === 'kitty')              args = ['-d', project, claudePath, initialPrompt];
    else if (term === 'alacritty')     args = ['--working-directory', project, '-e', claudePath, initialPrompt];
    else if (term === 'wezterm')       args = ['start', '--cwd', project, '--', claudePath, initialPrompt];
    else if (term === 'gnome-terminal') args = ['--working-directory', project, '--', claudePath, initialPrompt];
    else if (term === 'konsole')       args = ['--workdir', project, '-e', claudePath, initialPrompt];
    else                                args = ['-e', claudePath, initialPrompt];
    const child = spawn(term, args, { cwd: project, detached: true, stdio: 'ignore', env });
    child.unref();
    return { terminalPid: child.pid };
  }

  // macOS — Terminal.app via osascript so we can pass the prompt.
  const escProject = project.replace(/"/g, '\\"');
  const escClaude = claudePath.replace(/"/g, '\\"');
  const escPrompt = initialPrompt.replace(/"/g, '\\"');
  const envExports = Object.entries({
    WORKFLOW_PROJECT: project,
    WORKFLOW_INSTANCE_ID: instanceId,
    WORKFLOW_AGENT: agent,
    WORKFLOW_KANBAN: kanbanUrl,
  }).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('; ');
  const cmd = `cd "${escProject}" && ${envExports} && "${escClaude}" "${escPrompt}"`;
  const script = `tell application "Terminal" to do script ${JSON.stringify(cmd)}`;
  const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore', env });
  child.unref();
  return { terminalPid: child.pid };
}
