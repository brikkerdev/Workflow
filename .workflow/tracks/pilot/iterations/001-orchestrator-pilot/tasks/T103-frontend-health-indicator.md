---
id: T103
title: Frontend — индикатор здоровья сервера
iteration: 001
track: pilot
status: done
attempts: 0
deps: [T102]
estimate: S
expected_files:
  - kanban/static/app.js
  - kanban/static/styles.css
---

## Goal
В шапке kanban-страницы показать маленькую цветовую точку: зелёная — сервер отвечает на `/api/health`, красная — не отвечает.

## Context
- `kanban/static/app.js` — точка входа фронта, монтирует header.
- `kanban/static/styles.css` — место для стилей точки.
- `/api/health` появляется в T102 (зависимость).
- Не плодить второй EventSource — обычный `fetch` раз в 10 секунд достаточно.

## Acceptance criteria
- [ ] В правом углу шапки появляется точка размером ~10px с tooltip-ом «server: ok» / «server: down».
  Открой kanban в браузере — точка зелёная.
- [ ] Раз в 10 секунд фронт делает `fetch('/api/health', { cache: 'no-store' })`. При 2xx — зелёная; при network error / non-2xx / timeout > 3s — красная.
  Останови сервер, подожди 10-15 секунд — точка покраснеет. Подними — снова позеленеет.
- [ ] Никаких console-ошибок от обычного fetch-fail (поглоти error в catch).

## How to verify
1. После T102: открой kanban, проверь зелёную точку.
2. `Ctrl+C` сервер. Через 10-15 сек точка должна стать красной.
3. Запусти сервер заново — точка зелёная в течение 10 сек.

## Subtasks
- [ ] (план появится здесь)

## Notes
- 2026-05-02: `<span id="health-dot">` в topbar-right, стили в styles.css (зелёный/красный 10px, fallback hex), pollHealth() с AbortController(3s) + setInterval(10s), запуск в DOMContentLoaded. Ошибки fetch проглатываются. Браузерный тест user-side по exit criteria итерации.
