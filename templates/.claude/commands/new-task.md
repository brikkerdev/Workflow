---
description: "Создать новый таск в активной итерации из шаблона. Спрашивает title/assignee/deps/estimate, заполняет frontmatter."
allowed-tools: Read, Glob, Write, Edit, Bash
---

Создай новый таск.

Шаги:
1. Прочитай `.workflow/ACTIVE`. Если пусто — стоп с "Сначала /new-iter (или используй /new-track-task для трек-таска)".
2. Найди папку активной итерации `.workflow/iterations/<id>-*/`.
3. Найди наибольший id таска **глобально** — просканируй `.workflow/iterations/*/tasks/T*.md` и `.workflow/tracks/*/tasks/T*.md`. Новый id = max + 1, формат `T###`. Это нужно чтобы id были уникальны на весь проект.
4. Спроси пользователя через AskUserQuestion (или прими параметры из аргумента, если он передан):
   - **title** (free text)
   - **assignee** (один из: `user`, `architect`, `developer`, `ugui-designer`, `pencil-designer`, `2d-artist`, `animator`, `sound-designer`, `game-designer`)
   - **estimate** (S | M | L)
   - **deps** (список существующих T### через запятую, либо пусто)
5. Прочитай README активной итерации, достань `track` из её frontmatter (итерация всегда привязана к треку через /new-iter).
6. Прочитай `.workflow/templates/task.md`. Подставь:
   - `id` → новый T###
   - `title` → ответ пользователя
   - `iteration` → id активной итерации
   - `track` → slug трека из шага 5
   - `attempts` → 0
   - `assignee`, `estimate`, `deps` → ответы пользователя
6. Slug файла: `<title>` в нижнем регистре, пробелы → дефисы, не-латиница транслитерирована или укорочена. Имя файла: `T###-<slug>.md`.
7. Запиши новый файл через Write.
8. Сообщи путь и id нового таска.

После создания не редактируй секции Goal / Context / Acceptance criteria / How to verify — это пользователь заполнит сам или скажет тебе заполнить отдельной просьбой. Файл с TODO-плейсхолдерами это нормально на этом этапе.
