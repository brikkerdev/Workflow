---
id: T105
title: Agents — relative last-seen в строках
iteration: 001
track: pilot
status: done
attempts: 0
deps: []
estimate: S
expected_files:
  - kanban/static/agents.js
---

## Goal
В строках таблицы агентов на agents-странице показать колонку «last seen» с относительным временем (`5s ago`, `2m ago`, `1h ago`).

## Context
- `kanban/static/agents.js` рендерит список агентов. Источник данных — `/api/agents` или `/api/instances` (проверь, что используется в `agents.js`).
- В response может быть поле `last_seen`/`updated_at` (ISO). Если нет — в качестве фолбэка покажи `—`.
- Никакого live-обновления каждую секунду — просто формат «time since N» при каждом рендере. Достаточно.
- Не трогать css. Можно использовать inline-style или существующие классы.

## Acceptance criteria
- [ ] У каждой строки агента есть значение last-seen.
  Открой agents-страницу — у активных агентов значение разумное (`<минуты>`); у неактивных — большее.
- [ ] Формат: `<5s ago`, `12s ago`, `3m ago`, `1h ago`, `2d ago`. Если поля нет в данных — `—`.
- [ ] Не выкидывает в консоль ошибок при отсутствии поля.

## How to verify
1. Открой agents-страницу.
2. Сверь относительное время с реальным временем активности агента.
3. Проверь что неактивный/мёртвый агент показывает большее значение или `—`.

## Subtasks
- [ ] (план появится здесь)

## Notes
- 2026-05-02: `relTime(iso)` helper в agents.js, добавлен span с last-seen в `instanceChip`, обогащены title и inst-menu-meta. Фолбэк `started_at`, при невалидной дате — `—`. patchInstanceTokens last-seen не патчит — обновится на следующем полном renderAgents.
