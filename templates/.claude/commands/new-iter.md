---
description: "Создать одну итерацию внутри трека. Аргумент — slug трека (опционально)."
allowed-tools: Read, Bash, AskUserQuestion
argument-hint: "<track-slug>"
---

Создай новую итерацию: $ARGUMENTS.

Шаги:
1. Если `$ARGUMENTS` пустой — через `curl http://127.0.0.1:7777/api/tracks` получи список треков, спроси через AskUserQuestion какой выбрать.
2. Через AskUserQuestion спроси:
   - **slug** итерации (kebab-case, например `tooltips-mvp`)
   - **title** (короткое название)
   - **цель** (что итерация должна выдать на выходе, 1-2 предложения)
   - **scope** (список 3-7 пунктов что входит)
   - **status** (planned по умолчанию; activate сразу — ответь `active`)
3. Собери body:
   ```
   ## Цель
   <цель>

   ## Scope
   <scope как bullet list>

   ## Exit criteria
   - [ ] Все таски done
   - [ ] (заполни конкретные условия)

   ## Заметки
   ```
4. POST на API:
   ```
   curl -s -X POST http://127.0.0.1:7777/api/track/<track>/iterations \
     -H 'content-type: application/json' \
     -d '{"slug":"<slug>","title":"<title>","status":"<status>","body":"<body>"}'
   ```
5. Если status был `active` — а в треке уже была активная итерация — она автоматически НЕ переключится. Если хочешь активировать — отдельным вызовом:
   ```
   curl -s -X POST http://127.0.0.1:7777/api/track/<track>/iteration/<id>/activate
   ```
6. Сообщи: итерация создана, id, добавляй таски через `/new-task` или прямо в kanban UI.
