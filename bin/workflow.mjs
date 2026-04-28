#!/usr/bin/env node
// Workflow CLI. Subcommands: up, init, check-queue, help.
//
// All subcommands operate on the current working directory as project root,
// unless --project <path> is passed.

import { spawn } from 'node:child_process';
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
  check-queue                Print system-reminder if .workflow/queue/ has triggers.
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
  launchClaude(project);
  const env = { ...process.env, WORKFLOW_PROJECT: project };
  const args = [path.join(KANBAN, 'server.mjs'), ...rest];
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

  // .workflow/ skeleton
  const wfTarget = path.join(project, '.workflow');
  fs.mkdirSync(path.join(wfTarget, 'iterations'), { recursive: true });
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

  // .claude/commands + agents
  const claudeTarget = path.join(project, '.claude');
  copyDirRecursive(path.join(tplRoot, '.claude', 'commands'), path.join(claudeTarget, 'commands'));
  copyDirRecursive(path.join(tplRoot, '.claude', 'agents'),   path.join(claudeTarget, 'agents'));
  // settings.json — only if absent
  const settingsSrc = path.join(tplRoot, '.claude', 'settings.json');
  const settingsDst = path.join(claudeTarget, 'settings.json');
  if (fs.existsSync(settingsSrc) && !fs.existsSync(settingsDst)) {
    fs.mkdirSync(claudeTarget, { recursive: true });
    fs.copyFileSync(settingsSrc, settingsDst);
  }

  // .mcp.json — wire the workflow stdio MCP server using this repo's absolute path
  const mcpDst = path.join(project, '.mcp.json');
  if (!fs.existsSync(mcpDst)) {
    const mcpServerPath = path.join(REPO, 'kanban', 'mcp', 'server.mjs').replace(/\\/g, '/');
    const mcp = {
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
    fs.writeFileSync(mcpDst, JSON.stringify(mcp, null, 2) + '\n', 'utf-8');
  }

  console.log(`[workflow] done. Next:`);
  console.log(`           cd ${project}`);
  console.log(`           workflow up`);
}

const [, , sub, ...rawRest] = process.argv;
const { project, rest } = parseGlobalArgs(rawRest);

switch (sub) {
  case 'up':           cmdUp(project, rest); break;
  case 'init':         cmdInit(project); break;
  case 'check-queue':  cmdCheckQueue(project); break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:      help(); break;
  default:
    console.error(`[workflow] unknown command: ${sub}`);
    help();
    process.exit(2);
}
