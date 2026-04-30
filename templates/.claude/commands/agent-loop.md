---
description: "Спавненный агент-инстанс: тяни задачи из workflow-очереди в авто-цикле."
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, TodoWrite
---

Ты — спавненный workflow-инстанс. Все идентификаторы уже в окружении:
- `WORKFLOW_AGENT` — твой agent slug.
- `WORKFLOW_INSTANCE_ID` — твой instance id.
- `WORKFLOW_PROJECT` / `WORKFLOW_KANBAN` — корень и адрес сервера.

MCP-инструмент `workflow_next_task` сам подставит assignee/instance_id из этого env, так что вызывай его **без аргументов**.

## Шаги

1. Вызови `workflow_next_task()`.
2. Если ответ `{ empty: true }` — **сразу заверши турн без лишних слов**. Stop hook сам решит: либо попросит ещё один опрос (тогда снова вызови `workflow_next_task()` и снова заверши турн), либо отпустит на выход. Когда инстанс выйдет, kanban-сервер автоматически поднимет тебя заново при появлении новых задач.
3. Иначе — ты получил `task_id`, `brief` (компактный — пустые поля выкинуты), при первой таске в сессии ещё `protocol`, при rework — `rework`. Прочитай `protocol` (если есть), выполни `Goal` следуя `Acceptance criteria` и `How to verify`. Используй `TodoWrite` для прогресса (хук синхронит его в Subtasks).
4. **Если в брифе есть `worktree_path`** (таска привязана к итерации):
   - Работай **строго в `brief.worktree_path`** — все Edit/Write/Bash используй абсолютными путями внутри этой директории. Это общий worktree итерации на ветке `auto/iter-<id>`. Здесь же открыт Unity, через который ты можешь использовать unity-mcp — Editor видит твои сохранённые ассеты, сцены, прешты сразу.
   - Файловые конфликты с другими агентами уже отсечены: kanban-сервер не диспатчит две таски с пересекающимися `expected_files` одновременно. Если ты не вписал `expected_files` в frontmatter — пиши, иначе тебя могут спарить с агентом который правит те же файлы.
   - Когда код готов: `workflow_commit_task(task_id, summary?)` — сервер сделает коммит на ветке `auto/iter-<id>` с автором=твой slug, сообщение `<tid>: <title>`. Делай это перед auto-verify-result/submit.
5. **Auto-verify** (если `brief.auto_verify === true`):
   - `workflow_auto_verify_start(task_id)`.
   - Прогони свои проверки (lint, typecheck, build, юнит-тесты — что применимо). Результаты:
     - **Unity-проверка нужна** (batch-режим, runTests, build-pipeline): `workflow_auto_verify_result(task_id, { needs_unity: true, unity_payload: { argv: [...], cwd?, timeout_ms?, log_grep? } })`. Сервер поставит job в очередь под локом `unity_editor` и прогонит Unity batch против iter-worktree.
     - **Прошло**: `workflow_auto_verify_result(task_id, { passed: true, log: "..." })` → `passed-auto`.
     - **Не прошло**: `workflow_auto_verify_result(task_id, { passed: false, log: "что упало" })` → возврат в `in-progress`, исправляй и снова коммить + start. Лимит исчерпан → `red-auto`.
   - **Перед** auto-verify-result с `passed: true`: обнови `## How to verify` через `workflow_set_how_to_verify(task_id, content)` — user-facing чеклист (открыть сцену X, нажать Y, увидеть Z), runtime-проверки которые автомат не покрывает.
   - Атрибуция в общем Unity Editor.log: `workflow_unity_log_mark()` → действие → `workflow_unity_log_since(mark, grep?)`.
6. **Manual** (если `auto_verify` не выставлен): когда `## How to verify` готов и ты сделал `workflow_commit_task` — `workflow_submit_for_verify(task_id, summary)`. Юзер approve/reject вручную.
7. Заверши турн. Stop hook сразу скажет: следующая задача (`block` с reason "Take next workflow task: T...") или выход.

## Запреты

- В main чекаут (ROOT) ничего не пиши — это пользовательский checkout, ты его не видишь. Все правки в `worktree_path`.
- Не делай `git push` — финальный мердж `auto/iter-<id>` в `main` это решение пользователя.
- Не вызывай `workflow_set_subtasks` вручную — TodoWrite сам синхронится.
- Не используй `Agent` (sub-agent) — параллельность достигается множеством инстансов в разных терминалах.
- Не выходи через `/exit`. Просто завершай турн.
- Заполняй `expected_files` в frontmatter таски при создании — это твой лок. Без него сервер не сможет разнести тебя с другими агентами по времени.

Старт: `workflow_next_task()`.
