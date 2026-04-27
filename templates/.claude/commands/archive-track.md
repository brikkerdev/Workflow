---
description: "Архивировать трек: переместить .workflow/tracks/<slug>/ в .workflow/archive/tracks/<slug>/."
allowed-tools: Read, Glob, Bash, AskUserQuestion
argument-hint: "<track-slug>"
---

Архивируй трек: $ARGUMENTS.

Шаги:
1. Проверь что `.workflow/tracks/<slug>/` существует. Если нет — стоп.
2. Покажи короткую сводку трека: сколько тасков в каждом статусе. Если есть таски в `in-progress` или `review` — спроси через AskUserQuestion подтверждение «всё равно архивировать?». Без явного «да» — стоп.
3. Через Bash создай `.workflow/archive/tracks/` если ещё нет (`mkdir -p`).
4. Через Bash перенеси папку: `mv .workflow/tracks/<slug> .workflow/archive/tracks/<slug>`.
5. Сообщи: трек архивирован, виден в `.workflow/archive/tracks/<slug>/`.

Не правь содержимое тасков и README — архив сохраняет состояние as-is.
