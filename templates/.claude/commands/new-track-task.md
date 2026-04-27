---
description: "Создать новый таск в указанном треке. Аргумент — slug трека. T### нумерация глобальная по итерации + всем трекам."
allowed-tools: Read, Glob, Write, Bash, AskUserQuestion
argument-hint: "<track-slug>"
---

Создай новый таск в треке: $ARGUMENTS.

Шаги:
1. Проверь что папка `.workflow/tracks/<slug>/` существует. Если нет — стоп: "Трек не найден, создай через /new-track".
2. Найди наибольший id таска **глобально** — просканируй:
   - `.workflow/iterations/*/tasks/T*.md`
   - `.workflow/tracks/*/tasks/T*.md`
   Новый id = max + 1, формат `T###`.
3. Через AskUserQuestion спроси:
   - **title** (free text)
   - **assignee** (`user`, `architect`, `developer`, `ugui-designer`, `pencil-designer`, `2d-artist`, `animator`, `sound-designer`, `game-designer`)
   - **estimate** (S | M | L)
   - **deps** (список существующих T### через запятую, либо пусто; деп может быть из любого источника — итерация или другой трек)
4. Прочитай `.workflow/templates/task.md`. В frontmatter:
   - `id` → новый T###
   - `title`
   - **Удали** строку `iteration: 000`
   - **Добавь** строку `track: <slug>`
   - `assignee`, `estimate`, `deps` → ответы
5. Slug файла: title в нижнем регистре, пробелы → дефисы, не-латиница транслитерирована или укорочена. Имя: `T###-<slug>.md` в `.workflow/tracks/<slug>/tasks/`.
6. Запиши через Write.
7. Сообщи путь и id.

Goal / Context / Acceptance criteria / How to verify не заполняй — пользователь сам или попросит отдельно.
