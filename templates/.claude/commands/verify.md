---
description: "Показать блок 'How to verify' таска и его Notes (отчёт агента), чтобы пользователь мог проверить выполнение."
allowed-tools: Read, Glob, Edit
argument-hint: "<task-id>"
---

Покажи блок верификации для таска: $ARGUMENTS.

Шаги:
1. Найди файл таска. Ищи по обоим источникам:
   - `.workflow/iterations/*/tasks/<task-id>-*.md`
   - `.workflow/tracks/*/tasks/<task-id>-*.md`
   Если не найден — стоп.
2. Прочитай файл.
3. Выведи в порядке:
   - Заголовок: `T### · <title> · status: <status> · assignee: <assignee>`
   - Секция **Acceptance criteria** (как чек-лист)
   - Секция **How to verify** (пронумерованные шаги)
   - Секция **Notes** (отчёт агента)
4. В конце: "Когда проверишь — скажи 'done T###' или 'reject T### <причина>'. Я обновлю status."

Если в этом же сообщении пользователь уже сказал `done <id>` или `reject <id>` — соответственно поменяй frontmatter `status` через Edit (`done` или обратно `todo`, в случае reject — допиши причину в Notes под подзаголовком `### Reject from user (YYYY-MM-DD)`).
