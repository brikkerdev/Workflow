---
description: "Показать статус одного трека: список тасков с assignee/status/deps, как /iter но для трека."
allowed-tools: Read, Glob, Grep
argument-hint: "<track-slug>"
---

Покажи статус трека: $ARGUMENTS.

Шаги:
1. Проверь что папка `.workflow/tracks/<slug>/` существует. Если нет — стоп.
2. Прочитай `README.md` трека. Выведи строку с slug и целью (1-2 строки).
3. Прочитай все `tasks/T*.md` файлы трека. Для каждого извлеки frontmatter (`id`, `title`, `assignee`, `status`, `deps`, `estimate`).
4. Сгруппируй и выведи по статусу в порядке: `in-progress` → `review` → `todo` → `blocked` → `done`. Формат: `T### · status · assignee · estimate · title` + `deps: [...]` если не пусто.
5. В конце короткая сводка: сколько в каком статусе, есть ли ready-to-dispatch таски (`todo` с закрытыми deps; deps могут жить в итерации или других треках — ищи везде).

Не редактируй ничего. Только чтение.
