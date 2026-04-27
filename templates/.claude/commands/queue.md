---
description: "Разгрести .workflow/queue/ — для каждого триггера запустить background-агента и удалить триггер. Бесшовный аналог нескольких /dispatch подряд."
allowed-tools: Read, Glob, Bash, Edit, Agent
---

Разгреби очередь dispatch-триггеров из `.workflow/queue/`.

Шаги:
1. Через Glob найди все `.workflow/queue/*.json`. Если пусто — скажи "Очередь пуста" и закончи.
2. Для каждого триггер-файла (по порядку):
   - Прочитай JSON. Достань `task_id`, `iteration`, `assignee`, `task_path`.
   - Прочитай файл таска по `task_path`. Проверь:
     - `status` всё ещё `todo` (не успел ли кто-то поменять). Если нет — пропусти, удали триггер, в логе пометь skip.
     - `deps` всё ещё закрыты. Если нет — пропусти, удали триггер, в логе skip.
     - `.claude/agents/<assignee>.md` существует. Если нет — пропусти, оставь триггер, в логе error.
   - Поменяй `status` таска с `todo` на `in-progress` через Edit.
   - Запусти **background Agent** (`run_in_background: true`):
     - `subagent_type`: `assignee`
     - `description`: первые 3-5 слов title таска
     - `prompt`: содержимое таска + инструкция:
       ```
       Это таск из workflow-системы. Полный путь: <абсолютный путь>.

       Прочитай содержимое таска ниже, выполни Acceptance criteria, затем:
       1. Через Edit допиши в секцию `Notes` отчёт: что сделано, какие файлы тронуты, ключевые решения, что должен проверить пользователь.
       2. Через Edit поменяй frontmatter `status` с `in-progress` на `review`.
       3. Закоммить и запушить результат в git по шаблону `.workflow/templates/commit.md`:
          - `git add -A` (gitignore сам отфильтрует Library/Logs/Temp).
          - `git commit -m "<сообщение по шаблону>" --author="<твой assignee> <<assignee>@hashkill.local>"`.
          - `git push origin main`. Если push падает — допиши в Notes "push failed: <reason>", работу не откатывай.
          - Если файлы не менялись (только исследование) — пропусти коммит и push, в Notes напиши "no changes to commit".

       === TASK FILE ===
       <содержимое таска>
       ```
   - Удали триггер-файл через Bash (`rm <path>`).
3. В конце выведи компактный лог: сколько dispatched / skipped / errored, какие task-id.
4. Если хоть один dispatched — напомни пользователю: уведомления о завершении придут асинхронно, после них имеет смысл `/verify <id>`.

Не запускай foreground-Agent. Все агенты — фоновые. Иначе сессия заблокируется на первом.
