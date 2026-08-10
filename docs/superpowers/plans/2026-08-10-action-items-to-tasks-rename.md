# "Action items" → "Tasks" Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user-facing "action item(s)" (en-US) / "itens de ação" (pt-BR) string reads "task(s)" / "tarefa(s)" instead. Code identifiers, file names, i18n key names, and the persisted `Doc.actionItems` schema field are untouched — this is a copy-only change.

**Architecture:** Edit the affected string *values* in `src/core/i18n.ts` (key names stay the same); update the handful of existing tests that assert the old literal English copy so the suite reflects the new wording instead of catching it as a regression.

**Tech Stack:** TypeScript, Vitest. No new dependencies, no schema/migration change.

## Global Constraints

- Text only — no renames of `src/modules/action-items.ts`, the `kanban_*` i18n keys, `Doc.actionItems`, `ModuleRef`'s `{ kind: 'actions' }`, or any CSS class.
- Code comments (not user-visible) are left as-is.
- Match spec at `docs/superpowers/specs/2026-08-10-action-items-to-tasks-rename-design.md`.

---

### Task 1: Rename the i18n string values

**Files:**
- Modify: `src/core/i18n.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — same `MsgKey` names, just different string values. Task 2 depends on these exact new values.

- [ ] **Step 1: Edit the en-US block**

In `src/core/i18n.ts`, change these 8 values (key names unchanged):

| Line | Before | After |
|---|---|---|
| 556 | `module_actions: 'Action items',` | `module_actions: 'Tasks',` |
| 657 | `empty_no_teams_hint: 'Every team holds daily notes, people, action items, milestones and risks.',` | `empty_no_teams_hint: 'Every team holds daily notes, people, tasks, milestones and risks.',` |
| 660 | `palette_placeholder: 'Search module, person, action item, milestone or risk…',` | `palette_placeholder: 'Search module, person, task, milestone or risk…',` |
| 760 | `tags_cross_apply_hint: 'Action-item tags (the 6 colors) can have different names per team. Use this to copy one team\'s names to every other team — or leave each team with its own.',` | `tags_cross_apply_hint: 'Task tags (the 6 colors) can have different names per team. Use this to copy one team\'s names to every other team — or leave each team with its own.',` |
| 849 | `'Includes only the team/member/stakeholder structure (names, roles, and hierarchy) — no content is exported (no notes, action items, milestones, or risks). The generated file is NOT encrypted. Meant for teammates on the same team to import and skip initial setup.',` | `'Includes only the team/member/stakeholder structure (names, roles, and hierarchy) — no content is exported (no notes, tasks, milestones, or risks). The generated file is NOT encrypted. Meant for teammates on the same team to import and skip initial setup.',` |
| 861 | `data_cleanup_hint: 'Removes done/cancelled action items, completed milestones, and closed risks, plus old daily notes — across every team in this file. This cannot be undone.',` | `data_cleanup_hint: 'Removes done/cancelled tasks, completed milestones, and closed risks, plus old daily notes — across every team in this file. This cannot be undone.',` |
| 865 | `data_cleanup_confirm_body: '{actions} action items, {milestones} milestones, {risks} risks, and {dailyNotes} daily notes across all teams will be permanently deleted. This cannot be undone.',` | `data_cleanup_confirm_body: '{actions} tasks, {milestones} milestones, {risks} risks, and {dailyNotes} daily notes across all teams will be permanently deleted. This cannot be undone.',` |
| 867 | `data_cleanup_nothing_body: 'No done/cancelled action items, completed milestones, closed risks, or old daily notes were found.',` | `data_cleanup_nothing_body: 'No done/cancelled tasks, completed milestones, closed risks, or old daily notes were found.',` |

- [ ] **Step 2: Edit the pt-BR block**

Change these 6 values (key names unchanged):

| Line | Before | After |
|---|---|---|
| 99 | `module_actions: 'Próximas ações',` | `module_actions: 'Tarefas',` |
| 207 | `empty_no_teams_hint: 'Cada time guarda notas diárias, pessoas, itens de ação, marcos e riscos.',` | `empty_no_teams_hint: 'Cada time guarda notas diárias, pessoas, tarefas, marcos e riscos.',` |
| 314 | `tags_cross_apply_hint: 'As tags de ação (as 6 cores) podem ter nomes diferentes em cada time. Use isto para copiar os nomes de um time para todos os outros — ou deixe cada time com os seus próprios.',` | `tags_cross_apply_hint: 'As tags de tarefa (as 6 cores) podem ter nomes diferentes em cada time. Use isto para copiar os nomes de um time para todos os outros — ou deixe cada time com os seus próprios.',` |
| 403 | `'Inclui apenas a estrutura de times, membros e stakeholders (nomes, papéis e hierarquia) — nenhum conteúdo é exportado (sem notas, itens de ação, marcos ou riscos). O arquivo gerado NÃO é criptografado. Pensado para colegas do mesmo time importarem e pularem a configuração inicial.',` | `'Inclui apenas a estrutura de times, membros e stakeholders (nomes, papéis e hierarquia) — nenhum conteúdo é exportado (sem notas, tarefas, marcos ou riscos). O arquivo gerado NÃO é criptografado. Pensado para colegas do mesmo time importarem e pularem a configuração inicial.',` |
| 415 | `data_cleanup_hint: 'Remove itens de ação concluídos/cancelados, marcos concluídos e riscos encerrados, além de notas diárias antigas — em todos os times deste arquivo. Esta ação não pode ser desfeita.',` | `data_cleanup_hint: 'Remove tarefas concluídas/canceladas, marcos concluídos e riscos encerrados, além de notas diárias antigas — em todos os times deste arquivo. Esta ação não pode ser desfeita.',` |
| 419 | `data_cleanup_confirm_body: '{actions} itens de ação, {milestones} marcos, {risks} riscos e {dailyNotes} notas diárias em todos os times serão excluídos permanentemente. Esta ação não pode ser desfeita.',` | `data_cleanup_confirm_body: '{actions} tarefas, {milestones} marcos, {risks} riscos e {dailyNotes} notas diárias em todos os times serão excluídos permanentemente. Esta ação não pode ser desfeita.',` |

Note the gender agreement fix: "tarefa" is feminine, so "itens de ação concluídos" (masculine "itens") becomes "tarefas concluídas" (feminine), not "tarefas concluídos".

- [ ] **Step 3: Check for a pt-BR counterpart of `data_cleanup_nothing_body`**

Run: `grep -n "data_cleanup_nothing_body" src/core/i18n.ts`
Confirm whether a `pt` version exists (it may be missing/falling back). If a `pt` entry exists with "itens de ação" wording, apply the same "tarefas" swap with correct gender agreement; if there is no separate `pt` entry (English fallback), leave as-is — that's a pre-existing i18n gap outside this rename's scope.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — this is a pure string-value edit, no type shape changed.

- [ ] **Step 5: Commit**

```bash
git add src/core/i18n.ts
git commit -m "feat: rename \"Action items\" to \"Tasks\" in user-facing copy"
```

---

### Task 2: Update tests that assert the old literal copy

**Files:**
- Modify: `test/panes.test.ts:750`
- Modify: `test/prefs.test.ts:872,874,996`

**Interfaces:**
- Consumes: the new string values from Task 1.
- Produces: nothing — this is the last task.

- [ ] **Step 1: Update `test/panes.test.ts`**

Line 750 currently reads:

```ts
    { label: `${KIND_ICON.actions} Action items`, ref: { kind: 'actions' } },
```

Change to:

```ts
    { label: `${KIND_ICON.actions} Tasks`, ref: { kind: 'actions' } },
```

- [ ] **Step 2: Update `test/prefs.test.ts`**

Line 872 currently reads:

```ts
      'Includes only the team/member/stakeholder structure (names, roles, and hierarchy) — no content is exported (no notes, action items, milestones, or risks). The generated file is NOT encrypted. Meant for teammates on the same team to import and skip initial setup.',
```

Change to:

```ts
      'Includes only the team/member/stakeholder structure (names, roles, and hierarchy) — no content is exported (no notes, tasks, milestones, or risks). The generated file is NOT encrypted. Meant for teammates on the same team to import and skip initial setup.',
```

Line 874 currently reads:

```ts
      'Removes done/cancelled action items, completed milestones, and closed risks, plus old daily notes — across every team in this file. This cannot be undone.',
```

Change to:

```ts
      'Removes done/cancelled tasks, completed milestones, and closed risks, plus old daily notes — across every team in this file. This cannot be undone.',
```

Line 996 currently reads:

```ts
        '2 action items, 1 milestones, 1 risks, and 1 daily notes across all teams will be permanently deleted. This cannot be undone.'
```

Change to:

```ts
        '2 tasks, 1 milestones, 1 risks, and 1 daily notes across all teams will be permanently deleted. This cannot be undone.'
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, no failures. This also confirms no other test in the suite (e.g. `test/cleanup.test.ts`, `test/due.test.ts`, `test/atref.test.ts`, `test/search.test.ts`, `test/team-export.test.ts`, `test/document.test.ts`, `test/render-counts.test.ts`, `test/scope-freshness.test.ts`, `test/search-expand-highlight.test.ts`, `test/action-items.test.ts` — all of which reference "action item" only in test *descriptions*/comments, not in asserted UI copy) breaks.

- [ ] **Step 4: Commit**

```bash
git add test/panes.test.ts test/prefs.test.ts
git commit -m "test: update assertions for the Action items -> Tasks copy rename"
```
