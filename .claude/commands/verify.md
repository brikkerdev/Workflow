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
   - **Acceptance criteria** (как чек-лист, каждый пункт + indented "как проверить")
   - **How to verify** (общий setup перед прогонкой пунктов)
   - **Subtasks** (что агент сделал)
   - **Notes** (отчёт + предыдущие reject-блоки)
3. Скажи пользователю: открой таск в kanban → панель Verify откроется автоматически (status=verifying). Шеврон ▸ слева раскрывает индивидуальные шаги под каждым пунктом. Отметь каждый ✓/✗ + комментарий, затем Approve (commit+push+done) или Reject (rework, agent re-dispatched).

**Если пункты Acceptance criteria без indented details** — это значит автор таска не описал как именно проверить. Подскажи пользователю, что в новом формате под каждым `- [ ]` ожидаются 1-3 строки с конкретными шагами проверки именно этого условия (видны раскрывающейся подсказкой в Verify-панели).
