---
description: "Открыть верификацию таска. Чек-лист и approve/reject делается в kanban UI; команда показывает что чекать."
allowed-tools: Read, Glob
argument-hint: "<task-id>"
---

Покажи блок верификации для таска: $ARGUMENTS.

Шаги:
1. Найди файл таска в iter или track. Если не найден — стоп.
2. Выведи в порядке:
   - `T### · <title> · status: <status> · attempts: <N> · assignee: <assignee>`
   - **Acceptance criteria** (как чек-лист)
   - **How to verify** (нумерованные шаги)
   - **Subtasks** (что агент сделал)
   - **Notes** (отчёт + предыдущие reject-блоки)
3. Скажи пользователю: открой таск в kanban → нажми **Verify**, отметь каждый пункт ✓/✗ + комментарий, затем Approve (commit+push+done) или Reject (rework, agent re-dispatched).
