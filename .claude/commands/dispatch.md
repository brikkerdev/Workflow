---
description: "Поставить таск в очередь — спавнер сам поднимет инстанс агента."
allowed-tools: Bash
argument-hint: "<task-id>"
---

Поставь в очередь: $ARGUMENTS.

1. `curl -s -X POST http://127.0.0.1:7777/api/task/$ARGUMENTS/dispatch`.
2. Покажи результат: `queued`, `queue_size`, либо `error` (status, deps, agent missing — что вернул сервер).
3. Если ok — скажи: триггер в очереди, kanban-сервер автоматически поднимет инстанс агента (или передаст уже работающему). Verify пойдёт через kanban UI.

Не вызывай `Agent`/sub-agent — параллельность даёт пул терминальных инстансов, которыми рулит spawner.
