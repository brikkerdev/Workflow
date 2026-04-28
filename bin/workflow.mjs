#!/usr/bin/env node
// Workflow CLI. Subcommands: up, init, check-queue, help.
//
// All subcommands operate on the current working directory as project root,
// unless --project <path> is passed.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const KANBAN = path.join(REPO, 'kanban');

function parseGlobalArgs(argv) {
  const out = { project: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') out.project = path.resolve(argv[++i]);
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
  up [--port N] [--host H]   Start the local kanban web server.
  init                       Scaffold .workflow/ + .claude/ in current project.
  migrate [--apply]          Migrate legacy layout (.workflow/iterations/, global ACTIVE) to new track-as-timeline structure. Dry-run by default.
  check-queue                Print system-reminder if .workflow/queue/ has triggers.
  sync-subtasks              PostToolUse(TodoWrite) hook: mirror todos to task subtasks.
  track-stats                Stop hook: sum agent token usage and POST to kanban.
  help                       Show this help.

Project root resolution:
  --project <path>  >  $WORKFLOW_PROJECT  >  current directory

Examples:
  cd C:\\\\Unity\\ Games\\\\Hashkill && workflow up
  workflow init --project C:\\\\Code\\\\new-thing
`);
}

function ensureWorkflowDir(project) {
  const wf = path.join(project, '.workflow');
  if (!fs.existsSync(wf)) {
    console.error(`[workflow] no .workflow/ at ${project}`);
    console.error(`[workflow] run 'workflow init' to scaffold one.`);
    process.exit(1);
  }
}

function findClaude() {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  const names = ['claude'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
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
  } else {
    spawn(claudePath, [], {
      cwd: project, detached: true, stdio: 'ignore',
    }).unref();
  }
}

function cmdUp(project, rest) {
  ensureWorkflowDir(project);
  // Sync tool-shipped files (commands, .workflow/templates, .mcp.json) so
  // existing projects pick up new commands and template fields automatically.
  // Agents and settings.json are user-customizable and never overwritten.
  syncShippedFiles(project);
  // Migrate legacy layout (top-level iterations/, global ACTIVE, track-tasks).
  autoMigrate(project);
  launchClaude(project);
  const env = { ...process.env, WORKFLOW_PROJECT: project };
  const args = [path.join(KANBAN, 'server.mjs'), ...rest];
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
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

function cmdCheckQueue(project) {
  const env = { ...process.env, WORKFLOW_PROJECT: project };
  const child = spawn(process.execPath, [path.join(KANBAN, 'check_queue.mjs')], {
    env, stdio: 'inherit',
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

function cmdInit(project) {
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

  // .claude/agents — only seed if absent (user-customizable).
  const claudeTarget = path.join(project, '.claude');
  copyDirRecursive(path.join(tplRoot, '.claude', 'agents'), path.join(claudeTarget, 'agents'));
  // settings.json — only if absent
  const settingsSrc = path.join(tplRoot, '.claude', 'settings.json');
  const settingsDst = path.join(claudeTarget, 'settings.json');
  if (fs.existsSync(settingsSrc) && !fs.existsSync(settingsDst)) {
    fs.mkdirSync(claudeTarget, { recursive: true });
    fs.copyFileSync(settingsSrc, settingsDst);
  }
  // .claude/commands, .workflow/templates, .mcp.json — always synced.
  syncShippedFiles(project);

  console.log(`[workflow] done. Next:`);
  console.log(`           cd ${project}`);
  console.log(`           workflow up`);
}

const [, , sub, ...rawRest] = process.argv;
const { project, rest } = parseGlobalArgs(rawRest);

switch (sub) {
  case 'up':           cmdUp(project, rest); break;
  case 'init':         cmdInit(project); break;
  case 'migrate':      cmdMigrate(project, rest); break;
  case 'check-queue':  cmdCheckQueue(project); break;
  case 'sync-subtasks': cmdSyncSubtasks(project); break;
  case 'track-stats':  cmdTrackStats(project); break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:      help(); break;
  default:
    console.error(`[workflow] unknown command: ${sub}`);
    help();
    process.exit(2);
}
