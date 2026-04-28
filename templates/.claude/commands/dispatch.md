---
description: "Запустить background-агента на одиночный таск."
allowed-tools: Read, Glob, Bash, Agent
argument-hint: "<task-id>"
---

Запусти агента на: $ARGUMENTS.

1. Через `curl http://127.0.0.1:7777/api/task/$ARGUMENTS?view=brief` достань: `status`, `assignee`, `deps`, `attempts`.
2. Проверки: `status` ∈ {todo, queued}; `assignee` ≠ user; `.claude/agents/<assignee>.md` существует.
3. Если status=todo — попроси пользователя нажать ▶ Start в kanban (это поставит queued + создаст триггер).
4. Запусти Agent в **background** (`run_in_background: true`):
   - `subagent_type`: assignee
   - `description`: первые 3-5 слов title
   - `prompt`: `Workflow task $ARGUMENTS. attempts=<N>. Call workflow_claim_task("$ARGUMENTS") first; the response contains the protocol and task brief.`
5. Сообщи: какой агент стартовал, что ожидать verify через kanban UI.
