---
description: "Архивировать трек (move в .workflow/archive/tracks/)."
allowed-tools: Read, Bash, AskUserQuestion
argument-hint: "<track-slug>"
---

Архивируй трек: $ARGUMENTS.

Шаги:
1. `curl http://127.0.0.1:7777/api/track/<slug>` — если 404 стоп.
2. Покажи сводку (iter counts). Если есть active iter — спроси через AskUserQuestion подтверждение.
3. После подтверждения:
   ```
   curl -s -X DELETE http://127.0.0.1:7777/api/track/<slug>
   ```
4. Сообщи куда архив переехал (поле `archived_to` в ответе).
