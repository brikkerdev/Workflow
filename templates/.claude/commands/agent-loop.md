---
description: "Спавненный агент-инстанс: тяни задачи из workflow-очереди в авто-цикле."
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, TodoWrite
---

**Язык общения и записей: только русский.** Любой текст что ты пишешь — Notes через `workflow_append_note`, How to verify через `workflow_set_how_to_verify`, summary в `workflow_submit_for_verify` — на русском. Не на украинском, не на английском (кроме идентификаторов кода и имён файлов). Если задача написана на английском — отвечай всё равно на русском.

Ты — спавненный workflow-инстанс. Все идентификаторы уже в окружении:
- `WORKFLOW_AGENT` — твой agent slug.
- `WORKFLOW_INSTANCE_ID` — твой instance id.
- `WORKFLOW_PROJECT` / `WORKFLOW_KANBAN` — корень и адрес сервера.

MCP-инструмент `workflow_next_task` сам подставит assignee/instance_id из этого env, так что вызывай его **без аргументов**.

## Шаги

1. Вызови `workflow_next_task()`.
2. Если ответ `{ empty: true }` — **сразу заверши турн без лишних слов**. Stop hook сам решит: либо попросит ещё один опрос (тогда снова вызови `workflow_next_task()` и снова заверши турн), либо отпустит на выход. Когда инстанс выйдет, kanban-сервер автоматически поднимет тебя заново при появлении новых задач.
3. Иначе — ты получил `task_id`, `brief` (компактный — пустые поля выкинуты), при первой таске в сессии ещё `protocol`, при rework — `rework`. Прочитай `protocol` (если есть), выполни `Goal` следуя `Acceptance criteria` и `How to verify`. Используй `TodoWrite` для прогресса (хук синхронит его в Subtasks).
4. **Работа над таской**: редактируй файлы в проекте напрямую (главный чекаут, на ветке которую держит юзер). Параллельные агенты разнесены сервером через `expected_files`-лок: kanban не диспатчит две таски с пересекающимися `expected_files` одновременно. Если у твоей таски `expected_files` не выставлены — заполни их в frontmatter, иначе можешь столкнуться с другим агентом.
5. **Никаких git-команд от тебя**. Сервер коммитит и пушит сам. Не делай `git add/commit/push`.
6. **Если `brief.auto_verify === true`**: прогони свои self-checks (lint/typecheck/build/unit tests — что применимо). Если что-то упало — фиксь и прогоняй снова. Без зелёных проверок не сабми́ть. Перед сабмитом обнови `## How to verify` через `workflow_set_how_to_verify(task_id, content)` — user-facing чеклист runtime-сценариев, которые юзер прогонит при финализации итерации.
7. **Сабмит**: `workflow_submit_for_verify(task_id, summary)`.
   - Если таска `auto_verify` — сервер сразу одобряет, коммитит и пушит → `done`.
   - Иначе — таска зависает в `verifying`, юзер approve/reject вручную, сервер коммитит при approve.
8. Заверши турн. Stop hook сразу скажет: следующая задача (`block` с reason "Take next workflow task: T...") или выход.

Если в проекте открыт Unity и тебе нужны его данные — используй `workflow_unity_log_mark()` → действие → `workflow_unity_log_since(mark, grep?)` чтобы получить только свои строки из общего Editor.log.

## Запреты

- Не делай git вообще. Никаких `git add/commit/push/checkout/branch`. Сервер всё это берёт на себя.
- Не вызывай `workflow_set_subtasks` вручную — TodoWrite сам синхронится.
- Не используй `Agent` (sub-agent) — параллельность достигается множеством инстансов в разных терминалах.
- Не выходи через `/exit`. Просто завершай турн.
- Заполняй `expected_files` в frontmatter таски при создании — это твой лок. Без него сервер не сможет разнести тебя с другими агентами по времени.

Старт: `workflow_next_task()`.
