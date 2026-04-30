#!/usr/bin/env node
// Workflow CLI. Subcommands: up, init, check-queue, help.
//
// All subcommands operate on the current working directory as project root,
// unless --project <path> is passed.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { createLogger } from '../kanban/lib/logger.mjs';
const logger = createLogger('workflow');

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const KANBAN = path.join(REPO, 'kanban');

function parseGlobalArgs(argv) {
  const out = { project: null, agents: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') out.project = path.resolve(argv[++i]);
    else if (argv[i] === '--agents') out.agents = argv[++i];
    else out.rest.push(argv[i]);
  }
  if (!out.project) out.project = process.env.WORKFLOW_PROJECT
    ? path.resolve(process.env.WORKFLOW_PROJECT)
    : process.cwd();
  return out;
}

function help() {
  console.log(`workflow — per-project kanban + agent dispatch over .workflow/

Usage:
  workflow <command> [--project <path>] [args]

Commands:
  up [--port N] [--host H]   Start the local kanban web server and open the browser.
  init [--agents <list>]     Scaffold .workflow/ + .claude/ in current project.
  agents                     List available and installed agents.
  spawn <agent>              Spawn a new agent instance terminal (requires running kanban).
  migrate [--apply]          Migrate legacy layout to new track-as-timeline structure.
  session-capture            SessionStart hook: record claude session_id on the instance.
  sync-subtasks              PostToolUse(TodoWrite) hook: mirror todos to task subtasks.
  track-stats                Stop hook: sum agent token usage and POST to kanban.
  agent-loop-stop            Stop hook for spawned agent instances (decides continue/exit).
  agent-precompact           PreCompact hook: mark instance for clean respawn.
  help                       Show this help.

Agent selection (--agents):
  workflow init --agents developer,architect   install only these agents
  workflow init --agents none                  install no agents
  workflow init                                install all available agents

Global agents (~/.workflow/agents/):
  Place custom .md agent files there — they take priority over bundled agents
  and are available to all projects.

Project root resolution:
  --project <path>  >  $WORKFLOW_PROJECT  >  current directory

Examples:
  cd ~/projects/myapp && workflow up
  workflow init --project ~/code/new-thing
`);
}

function ensureWorkflowDir(project) {
  const wf = path.join(project, '.workflow');
  if (!fs.existsSync(wf)) {
    logger.error('workflow', `no .workflow/ at ${project}`);
    logger.error('workflow', "run 'workflow init' to scaffold one.");
    process.exit(1);
  }
}

function findClaude() {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  const names = ['claude'];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const extraDirs = process.platform !== 'win32'
    ? [path.join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin']
    : [];
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...extraDirs];
  for (const d of dirs) {
    for (const n of names) {
      for (const e of exts) {
        const p = path.join(d, n + e);
        try { if (fs.statSync(p).isFile()) return p; } catch {}
      }
    }
  }
  return null;
}

function findLinuxTerminal() {
  // Prefer the running terminal first (e.g. kitty, alacritty set $TERM_PROGRAM or $TERMINAL)
  const hint = process.env.TERM_PROGRAM || process.env.TERMINAL || '';
  const candidates = [hint, 'kitty', 'alacritty', 'wezterm', 'gnome-terminal', 'konsole', 'tilix', 'xterm'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of candidates) {
    if (!name) continue;
    for (const d of dirs) {
      const p = path.join(d, name);
      try { if (fs.statSync(p).isFile()) return name; } catch {}
    }
  }
  return null;
}

function launchClaude(project) {
  if (!fs.existsSync(path.join(project, '.claude'))) {
    console.log('[workflow] no .claude/ in project — skipping Claude Code launch');
    return;
  }
  const claudePath = findClaude();
  if (!claudePath) {
    console.log('[workflow] claude not found on PATH — skipping Claude Code launch');
    return;
  }
  console.log(`[workflow] launching claude in new window: ${claudePath}`);
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '""', '/D', project, claudePath], {
      cwd: project, detached: true, stdio: 'ignore', windowsHide: false,
    }).unref();
  } else if (process.platform === 'linux') {
    const term = findLinuxTerminal();
    if (!term) {
      console.log('[workflow] no terminal emulator found — skipping Claude Code launch');
      console.log('[workflow] install kitty, alacritty, gnome-terminal, or set $TERMINAL');
      return;
    }
    // Build exec args per terminal
    let args;
    if (term === 'kitty') {
      args = ['-d', project, claudePath];
    } else if (term === 'alacritty') {
      args = ['--working-directory', project, '-e', claudePath];
    } else if (term === 'wezterm') {
      args = ['start', '--cwd', project, '--', claudePath];
    } else if (term === 'gnome-terminal') {
      args = ['--working-directory', project, '--', claudePath];
    } else if (term === 'konsole') {
      args = ['--workdir', project, '-e', claudePath];
    } else {
      // tilix, xterm, generic fallback
      args = ['-e', claudePath];
    }
    spawn(term, args, { cwd: project, detached: true, stdio: 'ignore' }).unref();
  } else {
    // macOS: open a new Terminal window
    spawn('open', ['-a', 'Terminal', project], { detached: true, stdio: 'ignore' }).unref();
  }
}

function parsePort(rest) {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--port') return parseInt(rest[i + 1], 10) || 7777;
  }
  return parseInt(process.env.KANBAN_PORT || '7777', 10);
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    console.log(`[workflow] open ${url} manually (${e.message})`);
  }
}

function cmdUp(project, rest) {
  ensureWorkflowDir(project);
  // Sync tool-shipped files (commands, .workflow/templates, .mcp.json) so
  // existing projects pick up new commands and template fields automatically.
  syncShippedFiles(project);
  autoMigrate(project);
  const port = parsePort(rest);
  const env = { ...process.env, WORKFLOW_PROJECT: project };
  const args = [path.join(KANBAN, 'server.mjs'), ...rest];
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
  setTimeout(() => openBrowser(`http://127.0.0.1:${port}`), 600);
  child.on('exit', code => process.exit(code ?? 0));
}

async function cmdSpawn(project, rest) {
  ensureWorkflowDir(project);
  const agent = rest[0];
  if (!agent) {
    console.error('[workflow] usage: workflow spawn <agent>');
    process.exit(2);
  }
  const port = parseInt(process.env.KANBAN_PORT || '7777', 10);
  const url = `http://127.0.0.1:${port}/api/instance/spawn`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent }),
    });
    const text = await r.text();
    if (!r.ok) {
      logger.error('workflow', `spawn failed: ${text}`);
      process.exit(1);
    }
    console.log(text);
  } catch (e) {
    logger.error('workflow', `kanban server not reachable on :${port} — run 'workflow up' first.`, e);
    process.exit(1);
  }
}

function cmdAgentLoopStop() {
  const child = spawn(process.execPath, [path.join(KANBAN, 'agent_loop_stop.mjs')], {
    env: process.env, stdio: ['inherit', 'inherit', 'inherit'],
  });
  child.on('exit', code => process.exit(code ?? 0));
}

function cmdAgentPrecompact() {
  const child = spawn(process.execPath, [path.join(KANBAN, 'agent_precompact.mjs')], {
    env: process.env, stdio: ['inherit', 'inherit', 'inherit'],
  });
  child.on('exit', code => process.exit(code ?? 0));
}

function autoMigrate(project) {
  const env = { ...process.env, WORKFLOW_PROJECT: project };
  spawnSync(process.execPath, [path.join(KANBAN, 'migrate.mjs'), '--apply'], { env, stdio: 'inherit' });
}

// Mirror tool-shipped files into the project. Called on every `workflow up`
// so command updates and new templates land in old projects without effort.
//
// Touched (overwrite-on-diff):
//   .claude/commands/*.md      — managed by tool, not user
//   .workflow/templates/*.md   — managed by tool
//   .mcp.json                  — managed by tool (regenerated, paths absolute)
// Pruned (deleted on the project side if not in shipped templates):
//   .claude/commands/*.md      — removes deprecated commands like new-track-task.md
// Never touched:
//   .claude/agents/*.md        — user-customizable agent definitions
//   .claude/settings.json      — user hooks/permissions
//   .workflow/PROJECT, README.md, tracks/, archive/, queue/ — runtime data
function syncShippedFiles(project) {
  const tplRoot = path.join(REPO, 'templates');
  let touched = 0, pruned = 0;

  // .claude/commands — mirror with prune (the source of truth for slash cmds).
  const cmdSrc = path.join(tplRoot, '.claude', 'commands');
  const cmdDst = path.join(project, '.claude', 'commands');
  if (fs.existsSync(cmdSrc)) {
    fs.mkdirSync(cmdDst, { recursive: true });
    const shipped = new Set(fs.readdirSync(cmdSrc).filter(n => n.endsWith('.md')));
    // Prune: delete project-side commands no longer shipped.
    if (fs.existsSync(cmdDst)) {
      for (const n of fs.readdirSync(cmdDst)) {
        if (!n.endsWith('.md')) continue;
        if (!shipped.has(n)) {
          try { fs.unlinkSync(path.join(cmdDst, n)); pruned++; } catch {}
        }
      }
    }
    // Mirror: overwrite if content differs.
    for (const n of shipped) {
      const s = path.join(cmdSrc, n), d = path.join(cmdDst, n);
      if (!sameFile(s, d)) { fs.copyFileSync(s, d); touched++; }
    }
  }

  // .workflow/templates — overwrite-on-diff (no prune; user may add custom).
  const wtSrc = path.join(tplRoot, '.workflow', 'templates');
  const wtDst = path.join(project, '.workflow', 'templates');
  if (fs.existsSync(wtSrc)) {
    fs.mkdirSync(wtDst, { recursive: true });
    for (const n of fs.readdirSync(wtSrc)) {
      const s = path.join(wtSrc, n), d = path.join(wtDst, n);
      if (fs.statSync(s).isFile() && !sameFile(s, d)) { fs.copyFileSync(s, d); touched++; }
    }
  }

  // .mcp.json — always regenerate so the MCP server path points at the live repo.
  const mcpDst = path.join(project, '.mcp.json');
  const mcpServerPath = path.join(REPO, 'kanban', 'mcp', 'server.mjs').replace(/\\/g, '/');
  const desired = {
    mcpServers: {
      workflow: {
        type: 'stdio',
        command: 'node',
        args: [mcpServerPath],
        env: {
          WORKFLOW_PROJECT: project.replace(/\\/g, '/'),
          WORKFLOW_KANBAN: 'http://127.0.0.1:7777',
        },
      },
    },
  };
  const desiredText = JSON.stringify(desired, null, 2) + '\n';
  let current = '';
  try { current = fs.readFileSync(mcpDst, 'utf-8'); } catch {}
  if (current.trim() !== desiredText.trim()) {
    fs.writeFileSync(mcpDst, desiredText, 'utf-8');
    touched++;
  }

  if (touched || pruned) {
    console.log(`[workflow] sync: ${touched} updated, ${pruned} pruned`);
  }
}

function sameFile(a, b) {
  try {
    const A = fs.readFileSync(a);
    const B = fs.readFileSync(b);
    return A.length === B.length && A.equals(B);
  } catch { return false; }
}

function cmdMigrate(project, rest) {
  const env = { ...process.env, WORKFLOW_PROJECT: project };
  const args = [path.join(KANBAN, 'migrate.mjs'), ...rest];
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 0));
}

function cmdSessionCapture(project) {
  const env = { ...process.env, WORKFLOW_PROJECT: project };
  const child = spawn(process.execPath, [path.join(KANBAN, 'session_capture.mjs')], {
    env, stdio: ['inherit', 'inherit', 'inherit'],
  });
  child.on('exit', code => process.exit(code ?? 0));
}

function cmdSyncSubtasks(project) {
  const env = { ...process.env, WORKFLOW_PROJECT: project };
  const child = spawn(process.execPath, [path.join(KANBAN, 'sync_subtasks.mjs')], {
    env, stdio: ['inherit', 'inherit', 'inherit'],
  });
  child.on('exit', code => process.exit(code ?? 0));
}

function cmdTrackStats(project) {
  const env = { ...process.env, WORKFLOW_PROJECT: project };
  const child = spawn(process.execPath, [path.join(KANBAN, 'track_stats.mjs')], {
    env, stdio: ['inherit', 'inherit', 'inherit'],
  });
  child.on('exit', code => process.exit(code ?? 0));
}

function copyDirRecursive(src, dst, opts = {}) {
  const { overwrite = false } = opts;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDirRecursive(s, d, opts);
    else if (!fs.existsSync(d) || overwrite) fs.copyFileSync(s, d);
  }
}

// Build ordered list of agent source dirs: global (~/.workflow/agents/) first, then bundled.
function agentSources() {
  const sources = [];
  const global = path.join(os.homedir(), '.workflow', 'agents');
  if (fs.existsSync(global)) sources.push(global);
  const bundled = path.join(REPO, 'templates', '.claude', 'agents');
  if (fs.existsSync(bundled)) sources.push(bundled);
  return sources;
}

// Extract `name:` field from YAML frontmatter, fall back to filename stem.
function agentName(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    if (!text.startsWith('---')) return null;
    const end = text.indexOf('\n---', 3);
    if (end === -1) return null;
    const m = text.slice(3, end).match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// Returns Map<name, filePath> — global agents shadow bundled ones with the same name.
function collectAgents() {
  const map = new Map();
  // Iterate in reverse so first source wins when we iterate later.
  for (const dir of [...agentSources()].reverse()) {
    for (const file of fs.readdirSync(dir).filter(n => n.endsWith('.md'))) {
      const filePath = path.join(dir, file);
      const name = agentName(filePath) || file.replace(/\.md$/, '');
      map.set(name, filePath);
    }
  }
  return map;
}

function installedAgents(project) {
  const projectDir = path.join(project, '.claude', 'agents');
  if (!fs.existsSync(projectDir)) return new Set();
  return new Set(
    fs.readdirSync(projectDir)
      .filter(n => n.endsWith('.md'))
      .map(n => agentName(path.join(projectDir, n)) || n.replace(/\.md$/, ''))
  );
}

function cmdAgents(project) {
  const all = collectAgents();
  const installed = installedAgents(project);

  console.log('\nAvailable agents (global ~/.workflow/agents/ + bundled):');
  for (const [name] of all) {
    const mark = installed.has(name) ? '[x]' : '[ ]';
    const globalDir = path.join(os.homedir(), '.workflow', 'agents');
    const src = all.get(name).startsWith(globalDir) ? '(global)' : '(bundled)';
    console.log(`  ${mark} ${name.padEnd(20)} ${src}`);
  }
  const extra = [...installed].filter(n => !all.has(n));
  if (extra.length) {
    console.log('\nProject-only agents (not in any source dir):');
    extra.forEach(n => console.log(`  [x] ${n}`));
  }
  console.log(`\nInstalled in project: ${installed.size ? [...installed].join(', ') : '(none)'}`);
  console.log('To add: workflow init --agents <name1,name2>  (re-running init is safe)');
}

function cmdInit(project, agentsArg) {
  const tplRoot = path.join(REPO, 'templates');
  console.log(`[workflow] scaffolding into ${project}`);

  // .workflow/ skeleton (new layout — iterations live inside tracks)
  const wfTarget = path.join(project, '.workflow');
  fs.mkdirSync(path.join(wfTarget, 'tracks'), { recursive: true });
  fs.mkdirSync(path.join(wfTarget, 'archive'), { recursive: true });
  fs.mkdirSync(path.join(wfTarget, 'queue'), { recursive: true });
  // templates/
  copyDirRecursive(path.join(tplRoot, '.workflow', 'templates'), path.join(wfTarget, 'templates'));
  // README
  const readmeSrc = path.join(tplRoot, '.workflow', 'README.md');
  const readmeDst = path.join(wfTarget, 'README.md');
  if (fs.existsSync(readmeSrc) && !fs.existsSync(readmeDst)) fs.copyFileSync(readmeSrc, readmeDst);
  // PROJECT name
  const pf = path.join(wfTarget, 'PROJECT');
  if (!fs.existsSync(pf)) fs.writeFileSync(pf, path.basename(project) + '\n');

  // .claude/agents — seeded from global + bundled sources, filtered by --agents if given.
  const claudeTarget = path.join(project, '.claude');
  const agentsTarget = path.join(claudeTarget, 'agents');
  fs.mkdirSync(agentsTarget, { recursive: true });

  const allAgents = collectAgents();

  let selected;
  if (agentsArg === 'none') {
    selected = [];
  } else if (agentsArg === 'all' || !agentsArg) {
    selected = [...allAgents.keys()];
  } else {
    selected = agentsArg.split(',').map(s => s.trim()).filter(Boolean);
    const unknown = selected.filter(n => !allAgents.has(n));
    if (unknown.length) {
      logger.error('workflow', `unknown agents: ${unknown.join(', ')}`);
      logger.error('workflow', `available: ${[...allAgents.keys()].join(', ')}`);
      process.exit(1);
    }
  }

  for (const name of selected) {
    const src = allAgents.get(name);
    const dst = path.join(agentsTarget, name + '.md');
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      const globalDir = path.join(os.homedir(), '.workflow', 'agents');
      console.log(`[workflow] agent: ${name} (${src.startsWith(globalDir) ? 'global' : 'bundled'})`);
    }
  }
  if (!selected.length) {
    console.log('[workflow] no agents installed (--agents none)');
  }

  // settings.json — only if absent
  const settingsSrc = path.join(tplRoot, '.claude', 'settings.json');
  const settingsDst = path.join(claudeTarget, 'settings.json');
  if (fs.existsSync(settingsSrc) && !fs.existsSync(settingsDst)) {
    fs.copyFileSync(settingsSrc, settingsDst);
  }
  // .claude/commands, .workflow/templates, .mcp.json — always synced.
  syncShippedFiles(project);

  console.log(`[workflow] done. Next:`);
  console.log(`           cd ${project}`);
  console.log(`           workflow up`);
}

const [, , sub, ...rawRest] = process.argv;
const { project, agents, rest } = parseGlobalArgs(rawRest);

switch (sub) {
  case 'up':           cmdUp(project, rest); break;
  case 'init':         cmdInit(project, agents); break;
  case 'agents':       cmdAgents(project); break;
  case 'spawn':        cmdSpawn(project, rest); break;
  case 'migrate':      cmdMigrate(project, rest); break;
  case 'session-capture': cmdSessionCapture(project); break;
  case 'sync-subtasks': cmdSyncSubtasks(project); break;
  case 'track-stats':  cmdTrackStats(project); break;
  case 'agent-loop-stop': cmdAgentLoopStop(); break;
  case 'agent-precompact': cmdAgentPrecompact(); break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:      help(); break;
  default:
    logger.error('workflow', `unknown command: ${sub}`);
    help();
    process.exit(2);
}
