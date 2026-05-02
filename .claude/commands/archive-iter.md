---
description: "Закрыть итерацию (статус done или abandoned). Аргументы: <track> <id> [done|abandoned]"
allowed-tools: Read, Bash
argument-hint: "<track-slug> <iter-id> [done|abandoned]"
---

Закрой итерацию: $ARGUMENTS.

Шаги:
1. Распарсь `<track> <id> [status]`. Status default = `done`. Допустимы: `done`, `abandoned`.
2. POST:
   ```
   curl -s -X POST http://127.0.0.1:7777/api/track/<track>/iteration/<id>/archive \
     -H 'content-type: application/json' -d '{"status":"<status>"}'
   ```
3. Сообщи. Если итерация была активной — track ACTIVE сбросится; следующая active назначается вручную.
