---
id: T102
title: Server — endpoint GET /api/health
iteration: 001
track: pilot
status: todo
attempts: 0
deps: []
estimate: S
expected_files:
  - kanban/lib/handlers.mjs
  - kanban/server.mjs
---

## Goal
Добавить простой health-endpoint, по которому frontend сможет понимать, жив ли сервер.

## Context
- `kanban/server.mjs` — главный роутер. GET-секция начинается со строки `if (req.method === 'GET') {` и идёт списком явных проверок пути.
- `kanban/lib/handlers.mjs` экспортирует все handle*-функции; роутер их импортирует.
- Используй `sendJson(res, 200, { ... })` (уже есть в `kanban/lib/http.mjs`, импортируется в handlers.mjs).
- Время старта зафиксируй модульной константой в handlers.mjs (`const STARTED_AT = new Date()`), чтобы uptime считался от загрузки модуля.

## Acceptance criteria
- [ ] `GET /api/health` отвечает 200 JSON `{ ok: true, uptime_sec: <number>, started: <ISO>, project: <string> }`.
  `curl -s http://127.0.0.1:7777/api/health | jq` — все четыре поля присутствуют, `uptime_sec` растёт между двумя вызовами.
- [ ] `project` берётся из той же логики, что в `handleProject` (или зови `handleProject`-helper).
- [ ] Никаких внешних зависимостей не добавляется.

## How to verify
1. Запусти сервер: `node kanban/server.mjs` (или текущим способом).
2. `curl -s http://127.0.0.1:7777/api/health` — проверь поля и тип.
3. Подожди 2 секунды, повтори — `uptime_sec` увеличился.

## Subtasks
- [ ] (план появится здесь)

## Notes
