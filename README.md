# Workflow

Per-project kanban board + Claude Code agent dispatch system, backed by plain Markdown files in `.workflow/`. Pure Node.js, no npm dependencies.

Designed for any project on disk: scaffold once with `workflow init`, then drive it from a browser kanban + Claude slash commands.

## Install

Clone this repo somewhere stable (example uses `C:\Workflow`):

```
git clone https://github.com/brikkerdev/Workflow C:\Workflow
```

Add `C:\Workflow\bin` to your `PATH`. Then `workflow` is available globally.

POSIX:

```
git clone https://github.com/brikkerdev/Workflow ~/.workflow-tool
echo 'export PATH="$HOME/.workflow-tool/bin:$PATH"' >> ~/.bashrc
```

Requires **Node.js 18+**.

## Quickstart

```
cd /path/to/your/project
workflow init        # scaffolds .workflow/ + .claude/ from templates
workflow up          # kanban at http://127.0.0.1:7777
```

Open the URL, hit **▶ Start** on a card to queue an agent dispatch. Then in your Claude Code session run `/queue` (or wait for the SessionStart hook to nudge you).

## Commands

| Command                          | What it does                                                |
|---                               |---                                                          |
| `workflow up [--port N]`         | Start the kanban server for current project root.           |
| `workflow init`                  | Scaffold `.workflow/` + `.claude/commands` + `agents` here. |
| `workflow check-queue`           | Print Claude `<system-reminder>` if queue is non-empty.     |
| `workflow help`                  | Show usage.                                                 |
| Global flag: `--project <path>`  | Override project root (also via `$WORKFLOW_PROJECT`).       |

## Project layout (after `workflow init`)

```
your-project/
├── .workflow/
│   ├── PROJECT              # display name in kanban brand
│   ├── ACTIVE               # active iteration id (set by /new-iter)
│   ├── iterations/          # 001-slug/, 002-slug/, …
│   ├── tracks/              # long-lived parallel work streams
│   ├── archive/             # done iterations / tracks
│   ├── queue/               # dispatch trigger files (transient)
│   ├── templates/           # iteration / task / track / commit templates
│   └── README.md
└── .claude/
    ├── commands/            # /new-task, /new-iter, /queue, /verify, …
    ├── agents/              # per-project agent definitions (customizable)
    └── settings.json        # SessionStart hook → workflow check-queue
```

`.workflow/PROJECT` controls the brand name shown on the kanban; defaults to the directory basename.

## Kanban features

- 5 columns: **Backlog · In progress · Review · Blocked · Done**. Drag-drop between them with validated transitions and dep checks.
- Per-task modal: status / assignee / estimate / **deps chip picker** / **image attachments** (read by agents).
- Each agent gets a stable color → cards show a left-edge accent strip in that color.
- Agent dispatch via per-task `▶ Start` → writes a JSON trigger to `.workflow/queue/`. The Claude `/queue` command picks them up.
- **Light + dark theme** toggle (top-right).

## Customizing agents

`workflow init` seeds `.claude/agents/` from generic stubs. Open them and customize:
- `description` — when this agent should be invoked.
- The body — role, conventions, allowed tools, escalation rules.

Agent files become available as Claude Code subagent types automatically.

## How dispatch works

1. In the kanban: click **▶ Start** on a `todo` card whose deps are `done`. The server writes `.workflow/queue/T001.json`.
2. Inside your Claude Code session: `/queue` validates each trigger, moves the task to `in-progress`, launches the relevant background agent, deletes the trigger.
3. Agent finishes → notifies; you `/verify <id>` to walk the verification steps.

The SessionStart hook (`workflow check-queue`) reminds Claude about pending triggers when a session starts.

## License

MIT.
