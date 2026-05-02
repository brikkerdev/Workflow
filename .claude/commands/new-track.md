---
description: "Создать новый трек (долгоживущий поток работы). Внутри трека живут итерации в виде таймлайна."
allowed-tools: Read, Bash, AskUserQuestion
---

Создай новый трек.

Шаги:
1. Через AskUserQuestion спроси:
   - **slug** (kebab-case, например `art-vol-1`, `core-loop`)
   - **title** (короткое название трека)
   - **цель** (1-2 предложения, что трек делает)
2. Сделай POST на kanban API:
   ```
   curl -s -X POST http://127.0.0.1:7777/api/tracks \
     -H 'content-type: application/json' \
     -d '{"slug":"<slug>","title":"<title>","body":"## Цель\n<цель>\n\n## Scope\n- ...\n\n## Заметки\n"}'
   ```
3. Если ответ `{"ok":true}` — сообщи: трек создан, добавляй итерации через `/new-iter <slug>` или `/plan-track <slug>`. Если ошибка — выведи её.

Не пиши файлы напрямую — kanban сервер единственный писатель `.workflow/`.
