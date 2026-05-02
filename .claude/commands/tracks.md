---
description: "Все треки с подсчётом итераций и активной."
allowed-tools: Read, Bash
---

Список треков.

Шаги:
1. `curl http://127.0.0.1:7777/api/tracks`. Если пусто — "Нет треков. /new-track" и стоп.
2. Для каждого:
   ```
   <slug> — <title>
     iters: planned N · active N · done N · total N · ACTIVE: <id-or-none>
   ```
3. Подсказка: подробности `/track <slug>`, активная итерация `/iter <slug>`.
