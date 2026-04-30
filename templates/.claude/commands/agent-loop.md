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
4. **Auto-verify ветка** (если `brief.auto_verify === true` или `brief.worktree_path` присутствует):
   - Работай **строго в `brief.worktree_path`** — все Edit/Write/Bash используй абсолютными путями внутри этой директории. Это git worktree, изолированный от других агентов.
   - Когда код готов: вызови `workflow_auto_verify_start(task_id)`.
   - Прогони свои проверки (lint, typecheck, build, юнит-тесты — что применимо). Результаты:
     - **Unity-проверка нужна** (запуск редактора, play mode, runTests): вызови `workflow_auto_verify_result(task_id, { needs_unity: true, unity_payload: { argv: [...], cwd?, timeout_ms?, log_grep? } })`. Сервер поставит job в очередь под локом `unity_editor`, прогонит и сам проставит результат.
     - **Прошло**: `workflow_auto_verify_result(task_id, { passed: true, log: "..." })`.
     - **Не прошло**: `workflow_auto_verify_result(task_id, { passed: false, log: "что упало" })`. Сервер либо вернёт задачу в `in-progress` для rework (если попыток ещё хватает), либо запаркует как `red-auto`. На rework — исправляй и снова вызывай `workflow_auto_verify_start`.
   - **Перед** auto-verify-result с `passed: true`: обнови `## How to verify` секцию через `workflow_set_how_to_verify(task_id, content)` — это user-facing чеклист, что юзер запустит руками после итерации (открыть сцену X, нажать Y, увидеть Z). Это НЕ команды которые ты только что прогнал — это runtime-проверки которые автомат не покрывает.
   - Чтобы атрибутировать ошибки в общем Unity Editor.log (если играешь в editor через unity-mcp): сначала `workflow_unity_log_mark()`, потом действие, потом `workflow_unity_log_since(mark, grep?)` — увидишь только свои строки.
5. **Manual ветка** (если auto_verify не выставлен): когда `## How to verify` готов, вызови `workflow_submit_for_verify(task_id, summary)`. Юзер approve/reject вручную.
6. Заверши турн. Stop hook сразу скажет: следующая задача (`block` с reason "Take next workflow task: T...") или выход.

## Запреты

- Не делай `git commit`/`push` — сервер коммитит при approve / closeIteration.
- Не вызывай `workflow_set_subtasks` вручную — TodoWrite сам синхронится.
- Не используй `Agent` (sub-agent) — параллельность достигается множеством инстансов в разных терминалах.
- Не выходи через `/exit`. Просто завершай турн.
- В auto-verify: не работай за пределами `worktree_path` — другие агенты в это время правят те же файлы в своих worktree, твои правки в основном чекауте перетрут чужие.

Старт: `workflow_next_task()`.
