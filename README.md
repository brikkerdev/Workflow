# Workflow

Per-project kanban board + Claude Code agent dispatch + iteration manager, backed by plain Markdown files in `.workflow/`. Pure Node.js, no npm dependencies.

Project-agnostic. Drop it into any codebase, scaffold once, and drive it from a browser kanban + Claude slash commands. Unity is supported as an optional plug-in (auto-detected).

## What it gives you

- A local kanban (Backlog · Pending · In progress · Review · Blocked · Done) at `http://127.0.0.1:7777`.
- Tracks (long-lived parallel work streams) and Iterations (timed milestones inside a track).
- Tasks as Markdown files with frontmatter — readable by humans, git-diffable, edited by agents via MCP.
- Agent dispatch: hit ▶ on a card, the kanban writes a queue trigger, your Claude Code session picks it up and spawns the relevant subagent — or spawns a dedicated terminal that pulls tasks in a loop.
- Auto-verify pipeline: agents submit, server commits + pushes, optional auto-approval, finalize ritual at iteration close.
- An MCP server so dispatched agents can manipulate tasks (claim, append notes, submit, mark subtasks) without editing files directly.

## Install

Requires **Node.js 18+** and `claude` (Claude Code CLI) on `PATH`.

Windows:

```
git clone https://github.com/brikkerdev/Workflow C:\Workflow
```

Add `C:\Workflow\bin` to your `PATH`. `workflow` is now available globally.

Linux / macOS:

```
git clone https://github.com/brikkerdev/Workflow ~/.workflow-tool
echo 'export PATH="$HOME/.workflow-tool/bin:$PATH"' >> ~/.bashrc
```

> **Cross-platform status.** Developed and used daily on Windows. Linux and macOS code paths exist (terminal spawn via kitty/alacritty/wezterm/gnome-terminal/konsole/tilix/xterm or `Terminal.app`), but they have only been code-reviewed for this release — not exercised end-to-end. Please file an issue if something breaks.

## Quickstart

```
cd /path/to/your/project
workflow init        # scaffolds .workflow/ + .claude/ from templates
workflow up          # kanban at http://127.0.0.1:7777
```

Open the URL. Create a track → create an iteration → create tasks. Hit ▶ Start on a task to queue it. In your Claude Code session run `/queue` (or wait for the SessionStart hook to nudge you).

## Concepts

- **Track** — long-lived parallel stream of work (e.g. "core gameplay", "infra", "marketing site"). Lives in `.workflow/tracks/<slug>/`.
- **Iteration** — a timed milestone inside a track (e.g. `001-onboarding`). Lives in `.workflow/tracks/<slug>/iterations/<iter-id>-<slug>/`.
- **Task** — a kanban card, stored as a `.md` file with YAML frontmatter inside its iteration directory. Status, assignee, deps, expected_files, and verify steps live in frontmatter; goal / acceptance / notes live in the body.
- **Agent** — a Claude Code subagent definition under `.claude/agents/<slug>.md`. Tasks dispatch to agents by slug.
- **Queue** — `.workflow/queue/<task-id>.json` trigger files. Written when you click ▶, consumed by `/queue` or `workflow_next_task`.
- **Verify queue** — file-level lock so two agents never edit overlapping `expected_files` simultaneously.
- **MCP server** — stdio JSON-RPC, registered via `.mcp.json`, exposes `workflow_*` tools to dispatched agents.

## Commands

| Command                                  | What it does                                                |
|---                                       |---                                                          |
| `workflow up [--port N] [--host H]`      | Start the kanban server for current project root.           |
| `workflow init [--agents <list>] [--force]` | Scaffold `.workflow/` + `.claude/` here.                 |
| `workflow agents`                        | List available + installed agents.                          |
| `workflow spawn <agent>`                 | Spawn a new agent-loop terminal (server must be running).   |
| `workflow migrate [--apply]`             | Migrate legacy layout to the current track-as-timeline shape. |
| `workflow check-queue`                   | Print Claude `<system-reminder>` if queue is non-empty.     |
| `workflow session-capture`               | SessionStart hook: record claude `session_id` on the instance. |
| `workflow sync-subtasks`                 | PostToolUse(TodoWrite) hook: mirror todos to task subtasks. |
| `workflow track-stats`                   | Stop hook: sum agent token usage and POST to kanban.        |
| `workflow agent-loop-stop`               | Stop hook for spawned agent instances (decides continue/exit). |
| `workflow agent-precompact`              | PreCompact hook: mark instance for clean respawn.           |
| `workflow help`                          | Show usage.                                                 |
| Global flag: `--project <path>`          | Override project root (also via `$WORKFLOW_PROJECT`).       |

`--agents` accepts a comma list (`developer,architect`), `none`, or `all` (default).

## Slash commands (in your Claude Code session)

| Command                       | What it does                                                                |
|---                            |---                                                                          |
| `/new-task <agent> <title>`   | Create a task in the active iteration.                                      |
| `/new-iter <slug> <title>`    | Create an iteration in the active track.                                    |
| `/new-track <slug> <title>`   | Create a track.                                                             |
| `/plan-track <slug>`          | Walk through track planning interactively.                                  |
| `/track <slug>` / `/tracks`   | Print track summary / list.                                                 |
| `/iter`                       | Show current iteration state.                                               |
| `/activate-iter <id>` / `/archive-iter <id>` / `/archive-track <slug>` | Lifecycle moves.                  |
| `/dispatch <task-id>`         | Send a queued task to its agent right now.                                  |
| `/queue`                      | Drain the queue: dispatch every trigger to its agent.                       |
| `/verify <task-id>`           | Walk the verification steps for a submitted task.                           |
| `/agent-loop`                 | Used by spawned terminals — pulls next task and runs.                       |

## Agent dispatch flow

1. You click ▶ Start on a card whose deps are `done`.
2. Server writes `.workflow/queue/<id>.json`, moves task to `queued`.
3. Either:
   - a spawned terminal running `/agent-loop` calls `workflow_next_task` and atomically claims the trigger, OR
   - your interactive session runs `/queue` / `/dispatch <id>` and dispatches via the bundled subagent.
4. The agent calls `workflow_claim_task`, edits files, then `workflow_submit_for_verify`.
5. Server commits + pushes the diff scoped to that task's `expected_files`. If `auto_verify: true` it auto-approves and lands the task at `done`. Otherwise the task waits at `verifying` until you approve in the kanban.
6. When every task in the iteration is `done` (or you ack incomplete), the **Finalize** modal generates `CHECKLIST.md` — your manual smoke-test list pulled from each task's "How to verify".

The SessionStart hook (`workflow check-queue`) reminds Claude about pending triggers when a session starts.

## Auto-verify and iteration close

- **`auto_verify: true`** in task frontmatter → server auto-approves on submit and commits without waiting for you. The agent is responsible for running its own self-checks (lint / typecheck / build / unit tests) before submitting.
- **Manual tasks** → submit lands at `verifying`, you review the diff + the agent's "How to verify" notes in the kanban, click Approve or Reject. Reject sends rework notes back; agent picks the task up again.
- **`expected_files`** in frontmatter is a soft lock: the dispatcher won't queue two tasks with overlapping files at once.
- **Iteration close** writes `CHECKLIST.md` aggregating every closed task's verify steps. Open the iteration's directory, walk the list, smoke-test, and you're done.

## Project layout (after `workflow init`)

```
your-project/
├── .workflow/
│   ├── PROJECT              # display name shown in the kanban brand
│   ├── tracks/
│   │   └── <slug>/
│   │       ├── README.md           # track frontmatter + body
│   │       ├── ACTIVE              # active iteration id
│   │       └── iterations/
│   │           └── <id>-<slug>/
│   │               ├── README.md
│   │               ├── CHECKLIST.md (after finalize)
│   │               └── T001.md, T002.md, ...
│   ├── archive/             # done iterations / tracks
│   ├── queue/               # dispatch trigger files (transient)
│   ├── snapshots/           # per-task git snapshots used by the commit worker
│   ├── stats/               # per-task token usage (written by track-stats hook)
│   ├── templates/           # iteration / task / track / commit templates
│   └── README.md
├── .claude/
│   ├── commands/            # slash commands (managed — don't hand-edit)
│   ├── agents/              # per-project agent definitions (customize freely)
│   └── settings.json        # SessionStart / Stop / PostToolUse hooks
└── .mcp.json                # registers the workflow MCP server with Claude Code
```

`.workflow/PROJECT` controls the brand name shown on the kanban; defaults to the directory basename.

## Customizing agents

`workflow init` seeds `.claude/agents/` from generic stubs (developer, architect, game-designer, sound-designer, pencil-designer). Open them and customize:

- `description` — when this agent should be invoked.
- The body — role, conventions, allowed tools, escalation rules.

Agent files become Claude Code subagent types automatically.

**Global agents.** Drop custom agents into `~/.workflow/agents/` (per-user) — they take priority over bundled stubs and become available to every project on the next `workflow init`.

**Agent colors.** Known agent slugs get a stable hand-picked color in the kanban; unknown agents get a hash-derived hue. Add an entry in `bin/spawner.mjs` and `kanban/static/agentColors.js` to pin a color (keep the two files in sync).

## Unity integration (optional)

If a `.workflow up` project root contains both `Assets/` and `ProjectSettings/ProjectVersion.txt`, the tool detects it as a Unity project and adds:

- MCP tools `workflow_unity_log_mark` / `workflow_unity_log_since` — slice the Unity Editor.log around an action so parallel agents don't see each other's noise.
- Honored frontmatter flag `unity_verify: true` — surfaced to the agent loop alongside `auto_verify` for Unity-specific verification checklists.

If you're not in a Unity project, none of this exists and the kanban is fully generic. The `WORKFLOW_UNITY_LOG` env var overrides the default Editor.log path if you keep yours somewhere unusual.

## Hooks (optional but recommended)

`workflow init` writes a default `.claude/settings.json` that wires up:

- `SessionStart` → `workflow check-queue` (reminds Claude about pending triggers)
- `SessionStart` → `workflow session-capture` (records claude `session_id` on spawned instances)
- `PostToolUse(TodoWrite)` → `workflow sync-subtasks` (mirrors your TodoWrite list to the task's Subtasks section)
- `Stop` → `workflow track-stats` (records per-task token usage)
- `Stop` → `workflow agent-loop-stop` (decides continue / exit for spawned agent instances)
- `PreCompact` → `workflow agent-precompact` (marks the instance for clean respawn after a compaction)

You can edit `settings.json` freely — `workflow up` does not overwrite it on subsequent runs.

## License

MIT.
