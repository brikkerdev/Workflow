---
description: "Запустить background-агента на одиночный таск. Без git-операций — commit/push делает сервер kanban после approve."
allowed-tools: Read, Glob, Edit, Bash, Agent
argument-hint: "<task-id>"
---

Запусти агента на таск с id из аргумента: $ARGUMENTS.

Шаги:
1. Найди файл таска (`.workflow/iterations/*/tasks/<id>-*.md` или `.workflow/tracks/*/tasks/<id>-*.md`). Если не найден — стоп.
2. Прочитай frontmatter. Проверки:
   - `status` должен быть `todo` или `queued`. Иначе скажи в каком он состоянии.
   - `deps` все в `done` (ищи во всех источниках).
   - `assignee` ≠ `user`, и `.claude/agents/<assignee>.md` существует.
3. Если status=todo — попроси пользователя сначала нажать ▶ Start в kanban (это поставит queued + создаст триггер). Если status=queued и триггер есть — продолжай.
4. Запусти Agent в **background-режиме** (`run_in_background: true`):
   - `subagent_type`: значение `assignee`
   - `description`: первые 3-5 слов title таска
   - `prompt`:
     ```
     Workflow task. Файл: <абсолютный путь>. attempts=<N>.

     Используй MCP инструменты `workflow_*`:
     1. workflow_claim_task(task_id)
     2. workflow_get_task(task_id)
     3. workflow_set_subtasks(task_id, [...]) — распланируй
     4. workflow_complete_subtask(task_id, index) — по ходу
     5. workflow_append_note(task_id, text) — решения/находки
     6. workflow_submit_for_verify(task_id, summary) — когда готово

     НЕ делай git add/commit/push. Сервер kanban закоммитит после approve пользователя.
     ```
5. Сообщи пользователю: какой агент запущен, что после возврата нужно открыть таск в kanban и пройти verify.
