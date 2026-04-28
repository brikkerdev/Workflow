---
description: "Создать новый таск в активной итерации указанного трека (или текущего активного)."
allowed-tools: Read, Bash, AskUserQuestion
argument-hint: "[track-slug]"
---

Создай новый таск.

Шаги:
1. Через `curl http://127.0.0.1:7777/api/tracks` получи список треков. Если `$ARGUMENTS` пустой — спроси через AskUserQuestion какой трек.
2. Проверь `active` в выбранном треке. Если null — стоп: "У трека нет активной итерации. Активируй через `/activate-iter <track> <id>` или создай через `/new-iter <track>`".
3. Через AskUserQuestion спроси:
   - **title** (free text)
   - **assignee** (один из: `user`, `architect`, `developer`, `ugui-designer`, `pencil-designer`, `2d-artist`, `animator`, `sound-designer`, `game-designer`)
   - **estimate** (S | M | L)
   - **deps** (T### через запятую, либо пусто)
4. POST:
   ```
   curl -s -X POST http://127.0.0.1:7777/api/track/<track>/iteration/<active>/tasks \
     -H 'content-type: application/json' \
     -d '{"title":"<title>","assignee":"<assignee>","estimate":"<estimate>","deps":[<deps>]}'
   ```
5. Сообщи путь и id нового таска. Goal/Context/Acceptance criteria/How to verify пользователь заполнит сам или попросит отдельно.
