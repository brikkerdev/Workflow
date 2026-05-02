---
id: 001
slug: orchestrator-pilot
track: pilot
status: active
started: 2026-05-02
title: Orchestrator pilot — мелкие kanban-полировки
---

# Iteration 001 — Orchestrator pilot

## Цель
Прокатать новый orchestrator-режим на реальной (хоть и маленькой) пачке задач: пять независимых небольших улучшений в kanban, плюс одна зависимая. Это даст возможность проверить план волн, параллельный спавн, изоляцию по файлам и финальный коммит-цикл оркестратора.

## Scope
Что входит:
- T101 — log rotation в logger.mjs
- T102 — health endpoint (handlers.mjs + server.mjs)
- T103 — frontend health-индикатор в app.js (зависит от T102)
- T104 — total-done badge на stats-странице
- T105 — last-seen relative time на agents-странице

Что НЕ входит:
- какие-либо изменения в самом orchestrator-режиме (`.claude/commands/iterate.md`).
- любые задачи которые не перечислены выше — не подсовывай в волну, даже если по дороге заметишь.

## Exit criteria
- [ ] Все 5 тасков в статусе `done`
- [ ] Сервер kanban стартует без ошибок (`node kanban/server.mjs`)
- [ ] `/api/health` отвечает 200 с корректными полями
- [ ] Frontend-индикатор реагирует на остановленный сервер (юзер проверит вручную)
- [ ] Stats и Agents страницы открываются без ошибок в консоли

## Заметки
Это пилот orchestrator-подхода. Если что-то идёт не так с самим оркестратором (плохие промпты для под-агентов, неверный план волн, конфликты файлов) — фиксируй наблюдения здесь, чтобы потом перенести улучшения в `.claude/commands/iterate.md`.
