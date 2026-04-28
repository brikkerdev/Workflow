---
description: "Активировать итерацию в треке. Предыдущая активная переезжает в done. Аргументы: <track> <id>"
allowed-tools: Read, Bash
argument-hint: "<track-slug> <iter-id>"
---

Активируй итерацию: $ARGUMENTS.

Шаги:
1. Распарсь аргументы как `<track> <id>`. Если чего-то не хватает — стоп с usage.
2. POST на API:
   ```
   curl -s -X POST http://127.0.0.1:7777/api/track/<track>/iteration/<id>/activate
   ```
3. Сообщи результат. Если в треке была другая активная итерация — она автоматически отметилась done.
