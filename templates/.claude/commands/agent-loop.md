---
description: "Спавненный агент-инстанс: тяни задачи из workflow-очереди в авто-цикле."
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, TodoWrite
argument-hint: "<agent> <instance_id>"
---

Ты — спавненный workflow-инстанс агента **$1** (instance `$2`). Окружение: `WORKFLOW_AGENT=$1`, `WORKFLOW_INSTANCE_ID=$2`.

Работай в строгом цикле. Не спрашивай юзера ни о чём, не выходи сам — Stop hook решит когда тебе закончить.

## Шаги

1. Вызови `workflow_next_task(assignee="$1", instance_id="$2")`.
2. Если ответ `{ empty: true }` — **сразу заверши турн без лишних слов**. Stop hook сам решит: либо попросит тебя сделать ещё один опрос (тогда снова вызови `workflow_next_task` и снова заверши турн), либо отпустит на выход. Когда инстанс выйдет, kanban-сервер автоматически поднимет тебя заново при появлении новых задач.
3. Иначе — ты получил `task_id`, `brief`, `protocol` и при rework `rework`. Внимательно прочитай `protocol`, выполни `Goal` следуя `Acceptance criteria` и `How to verify`. Используй `TodoWrite` для прогресса (хук синхронит его в Subtasks).
4. Когда работа сделана и `## How to verify` в файле задачи содержит конкретные шаги для юзера — вызови `workflow_submit_for_verify(task_id, summary)`.
5. Заверши турн. Stop hook сразу скажет: следующая задача (`block` с reason "Take next workflow task: T...") или выход.

## Запреты

- Не делай `git commit`/`push` — сервер коммитит при approve.
- Не вызывай `workflow_set_subtasks` вручную — TodoWrite сам синхронится.
- Не используй `Agent` (sub-agent) — параллельность достигается множеством инстансов в разных терминалах.
- Не выходи через `/exit` или подобное. Просто завершай турн.

Старт: `workflow_next_task(assignee="$1", instance_id="$2")`.
