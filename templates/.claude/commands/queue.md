---
description: "Разгрести .workflow/queue/ — запустить background-агента с pre-fetched контекстом для каждого триггера."
allowed-tools: Read, Glob, Grep, Agent
---

Разгреби `.workflow/queue/`.

1. `Glob(".workflow/queue/*.json")`. Пусто — "очередь пуста" и стоп.

2. Для каждого триггера (по порядку) выполни шаги a–d:

**a. Прочитай триггер и задачу**
- JSON: `task_id`, `assignee`, `task_path`, `attempts`, `reason`.
- Прочитай `task_path`. Из frontmatter: `estimate` (S/M/L). Из тела: `## Goal`, `## Context`, `## Acceptance criteria`, `## How to verify`.
- Проверь `.claude/agents/<assignee>.md`. Нет — error в лог, переходи к следующему.

**b. Выбери модель**
- `architect`, `game-designer` → всегда `claude-opus-4-7`
- остальные агенты:
  - estimate `S` → `claude-haiku-4-5-20251001`
  - estimate `M` → `claude-sonnet-4-6`
  - estimate `L` или не указан → `claude-opus-4-7`

**c. Собери Prepared Context**
Цель: передать агенту нужный код/текст заранее, чтобы он не изучал проект с нуля.

- Из секции `## Context` извлеки упоминания файлов (строки содержащие `.cs`, `.md`, `.json`, `.unity`, `.prefab`, `Assets/`, `docs/`, `technical-docs/`).
- Для каждого найденного пути: прочитай файл (первые 100 строк). Если файл большой — `Grep` по ключевому символу из Acceptance criteria.
- Если в корне проекта есть `CLAUDE.md` — прочитай его, включи целиком (он краткий по определению).
- Лимит блока: ~1500 символов суммарно. Превышение — первые файлы в приоритете, остальные обрезай.
- Контекста нет совсем (пустой Context, файлы не найдены) — блок `## Prepared Context` не добавляй.

**d. Запусти агента**

Если Prepared Context есть — собери prompt:
```
Workflow task <task_id>. attempts=<N>.

## Goal
<goal>

## Acceptance criteria
<criteria>

## Prepared Context
<фрагменты кода/текста с путями и номерами строк>

---
Call workflow_claim_task("<task_id>") first.
Trust the Prepared Context above — do NOT read other files or explore the project.
Edit only the files listed above.
```

Если Prepared Context нет — стандартный prompt:
```
Workflow task <task_id>. attempts=<N>. Call workflow_claim_task("<task_id>") first; the response contains the protocol and task brief.
```

Запусти `Agent`:
- `subagent_type`: значение `assignee`
- `model`: выбранная в шаге b
- `description`: `<task_id>` + 3–5 слов из title
- `prompt`: собранный выше
- `run_in_background`: true

3. Итог: лог `dispatched/errored: <ids>`. Триггеры удаляет сервер при claim.

Все агенты — фоновые. Foreground заблокирует сессию.
