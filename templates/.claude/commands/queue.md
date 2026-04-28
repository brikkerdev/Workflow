---
description: "Разгрести .workflow/queue/ — для каждого триггера запустить background-агента."
allowed-tools: Read, Glob, Bash, Agent
---

Разгреби `.workflow/queue/`.

1. Glob `.workflow/queue/*.json`. Пусто — "очередь пуста" и стоп.
2. Для каждого триггера (по порядку):
   - Прочитай JSON: `task_id`, `assignee`, `attempts`, `reason`.
   - Проверь `.claude/agents/<assignee>.md` существует. Нет — error в лог.
   - Запусти background Agent (`run_in_background: true`):
     - `subagent_type`: `assignee`
     - `description`: `<task_id>` (3-5 слов из title опционально)
     - `prompt`: `Workflow task <task_id>. attempts=<N>. Call workflow_claim_task("<task_id>") first; the response contains the protocol and task brief.`
3. В конце: лог `dispatched/errored: <ids>`. Триггеры удаляет сам сервер при claim.

Все агенты — фоновые. Foreground заблокирует сессию.
