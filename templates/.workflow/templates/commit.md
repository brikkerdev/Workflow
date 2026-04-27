# Шаблон commit-сообщения для агента

Агент после dispatch обязан закоммитить свой результат. Формат сообщения:

```
T### · <task title>

<1-3 строки: что сделано — взять из своего отчёта в Notes>

Files:
- <relative/path/to/file1>
- <relative/path/to/file2>

Agent: <agent-name>
Iteration: <iter-id>
```

## Правила

- **Author** через `--author="<agent-name> <<agent-name>@hashkill.local>"` (пример: `--author="developer <developer@hashkill.local>"`). Это ставит агента в `git log --format=%an`.
- **Без упоминаний** Claude, Anthropic, AI, Co-Authored-By. Только имя агента.
- **Один таск = один коммит**. Если работа разбилась на несколько шагов — всё равно один итоговый коммит в конце.
- **Stage только релевантное**:
  - изменённые/новые файлы в `Assets/`, `Packages/`, `ProjectSettings/`, `docs/`, `technical-docs/`, `tools/`, `.claude/`
  - сам файл таска `.workflow/{iterations,tracks}/.../tasks/T###-*.md` (с обновлёнными Notes и status)
  - НЕ коммитить: `Library/`, `Logs/`, `UserSettings/`, `Temp/`, `*.sln`, `.workflow/queue/*` (всё это в `.gitignore`, но всё равно проверь).
- **После коммита делай push**: `git push origin main`. Если push падает (no network / auth / conflict) — допиши в Notes таска короткую пометку «push failed: <reason>», работу не откатывай.
- **Если коммитить нечего** (агент только читал/исследовал, файлы не менялись) — пропустить коммит и push, в Notes явно написать "no changes to commit".

## Пример вызова

```bash
git add -A
git commit -m "T012 · Add tooltip controller

Implemented TooltipController with DOTween fade in/out.
Wired into UIRoot. Localization keys added.

Files:
- Assets/Scripts/UI/TooltipController.cs
- Assets/Prefabs/UI/Tooltip.prefab
- .workflow/iterations/001-tooltips/tasks/T012-add-tooltip-controller.md

Agent: developer
Iteration: 001" --author="developer <developer@hashkill.local>"
git push origin main
```
