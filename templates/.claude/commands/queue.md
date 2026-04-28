---
description: "Разгрести .workflow/queue/ — для каждого триггера запустить background-агента. Никаких git-операций; commit/push делает сервер kanban после approve пользователя."
allowed-tools: Read, Glob, Bash, Edit, Agent
---

Разгреби очередь dispatch-триггеров из `.workflow/queue/`.

Шаги:
1. Через Glob найди все `.workflow/queue/*.json`. Если пусто — скажи "Очередь пуста" и закончи.
2. Для каждого триггер-файла (по порядку):
   - Прочитай JSON. Достань `task_id`, `iteration`, `track`, `assignee`, `task_path`, `attempts`, `reason`, `rework_notes`.
   - Проверь что `.claude/agents/<assignee>.md` существует. Если нет — оставь триггер, в логе error.
   - Запусти **background Agent** (`run_in_background: true`):
     - `subagent_type`: `assignee`
     - `description`: `<task_id> · <attempt N>` или просто 3-5 слов title
     - `prompt`: см. шаблон ниже. Сервер сам поставит claim → in-progress, удалит триггер; коммит/пуш сервер сделает после approve пользователя.

   Шаблон промпта:
   ```
   Это таск из workflow-системы. Файл: <абсолютный путь к task_path>.
   Reason: <reason>. Attempts so far: <attempts>.
   <если есть rework_notes: вставить блок>

   Используй MCP инструменты `workflow_*` (stdio MCP сервер уже подключён):
   1. workflow_claim_task(task_id) — переведёт таск в in-progress.
   2. workflow_get_task(task_id) — прочитай весь таск с подзадачами.
   3. Распиши план как подзадачи: workflow_set_subtasks(task_id, [...]).
   4. По мере выполнения отмечай: workflow_complete_subtask(task_id, index).
   5. Заметки/решения: workflow_append_note(task_id, text).
   6. Когда все Acceptance criteria выполнены: workflow_submit_for_verify(task_id, summary).

   НЕ коммить и не пушь. НЕ делай git операций. Сервер kanban сделает commit+push сам после того как пользователь approve через UI.
   ```
3. В конце выведи компактный лог: сколько dispatched / errored, какие task-id.
4. Напомни: уведомления о завершении придут асинхронно; verify проходит через UI кanban.

Не запускай foreground-Agent. Все агенты — фоновые.
