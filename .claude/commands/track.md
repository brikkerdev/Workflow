---
description: "Показать таймлайн трека: цель, активная итерация, все запланированные/закрытые итерации."
allowed-tools: Read, Bash
argument-hint: "<track-slug>"
---

Покажи трек: $ARGUMENTS.

Шаги:
1. `curl http://127.0.0.1:7777/api/track/<slug>`. Если 404 — стоп.
2. Выведи:
   - заголовок `<slug> · <title>`
   - первый параграф из README (после `## Цель`)
   - active iter id (или "нет активной")
3. Таймлайн итераций сверху вниз: `<id> · <slug> · <status> · <task_count> tasks · <title>`. Outline statuses: planned (◯), active (●), done (✓), abandoned (×).
4. В конце сводка: total iters, по статусу.

Не редактируй ничего.
