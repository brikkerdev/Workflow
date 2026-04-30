---
description: "Показать активные итерации (опционально по треку): таски сгруппированы по статусу."
allowed-tools: Read, Bash
argument-hint: "[track-slug]"
---

Покажи статус активных итераций: $ARGUMENTS.

Шаги:
1. Если `$ARGUMENTS` задан — `curl http://127.0.0.1:7777/api/board?track=<slug>`. Иначе — `curl http://127.0.0.1:7777/api/board` (агрегат по всем активным).
2. Для каждой активной итерации выведи:
   - `<track> · iter <id> · <iter title>` (одна строка)
   - таски сгруппированы по статусу в порядке: `in-progress` → `verifying` → `queued` → `todo` → `done`
   - каждая строка: `T### · status · assignee · estimate · title` + `deps: [...]` если непусто
3. В конце сводка: total + ready-to-dispatch (todo с закрытыми deps).

Не редактируй ничего.
