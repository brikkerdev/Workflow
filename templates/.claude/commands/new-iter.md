---
description: "Создать новую итерацию (всегда привязана к треку) и сделать её активной."
allowed-tools: Read, Glob, Write, Edit, Bash, AskUserQuestion
---

Создай новую итерацию.

Шаги:
1. Прочитай `.workflow/ACTIVE`. Если **не пусто** — спроси через AskUserQuestion: завершить текущую (move в `archive/`, очистить ACTIVE) или прервать. Без явного подтверждения не создавай новую.
2. Просканируй `.workflow/tracks/`. Если треков нет — стоп, скажи "сначала создай трек через /new-track". Итерация всегда живёт внутри трека.
3. Спроси у пользователя через AskUserQuestion:
   - **track** (slug одного из существующих треков из шага 2)
   - **slug** итерации (kebab-case, например `tooltips-mvp`)
   - **цель итерации** (1-2 предложения)
4. Просканируй `.workflow/iterations/` и найди наибольший id. Новый id = max + 1, формат `###`.
5. Создай папку `.workflow/iterations/<id>-<slug>/`.
6. Прочитай `.workflow/templates/iteration.md`. Подставь `id`, `slug`, `track`, `started: <today>`, цель.
7. Запиши `README.md` итерации через Write.
8. Создай пустую `tasks/` внутри итерации.
9. Запиши id в `.workflow/ACTIVE`.
10. Сообщи: итерация создана внутри трека `<track>`, активна, добавляй таски через `/new-task`.
