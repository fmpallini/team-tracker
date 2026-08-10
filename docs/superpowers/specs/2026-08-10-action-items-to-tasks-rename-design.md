# "Action items" → "Tasks" rename — design

## Scope

User-facing text only. Every i18n *value* mentioning "action item(s)" (en-US) or
"itens/ação" phrasing (pt-BR) becomes "task(s)"/"tarefa(s)" wording. No code
identifiers, file names, i18n *key* names, CSS classes, or the persisted
`Doc.actionItems` schema field change — those are invisible to the user and
renaming them (especially the schema field) would need a migration, which is out
of scope.

The module's own internal wording already says "card"/"kanban" (`kanban_*` keys in
`src/core/i18n.ts`, e.g. `kanban_add_card`, `kanban_delete_confirm`) — those don't
mention "action item" and are untouched. Confirmed by search: the only strings
containing "action item"/"itens de ação" live in `src/core/i18n.ts`; every other
hit across `src/` is a code comment (not user-visible, left as-is per scope).

## Exact changes — `src/core/i18n.ts`

**en-US**
| Key | Before | After |
|---|---|---|
| `module_actions` (line 556) | `Action items` | `Tasks` |
| `empty_no_teams_hint` (657) | `...daily notes, people, action items, milestones and risks.` | `...daily notes, people, tasks, milestones and risks.` |
| `palette_placeholder` (660) | `Search module, person, action item, milestone or risk…` | `Search module, person, task, milestone or risk…` |
| `tags_cross_apply_hint` (760) | `Action-item tags (the 6 colors) can have different names...` | `Task tags (the 6 colors) can have different names...` |
| team-export hint (849) | `...no notes, action items, milestones, or risks). ...` | `...no notes, tasks, milestones, or risks). ...` |
| `data_cleanup_hint` (861) | `Removes done/cancelled action items, completed milestones...` | `Removes done/cancelled tasks, completed milestones...` |
| `data_cleanup_confirm_body` (865) | `{actions} action items, {milestones} milestones...` | `{actions} tasks, {milestones} milestones...` |
| `data_cleanup_nothing_body` (867) | `No done/cancelled action items, completed milestones...` | `No done/cancelled tasks, completed milestones...` |

**pt-BR**
| Key | Before | After |
|---|---|---|
| `module_actions` (99) | `Próximas ações` | `Tarefas` |
| `empty_no_teams_hint` (207) | `...notas diárias, pessoas, itens de ação, marcos e riscos.` | `...notas diárias, pessoas, tarefas, marcos e riscos.` |
| team-export hint (403) | `...sem notas, itens de ação, marcos ou riscos). ...` | `...sem notas, tarefas, marcos ou riscos). ...` |
| `data_cleanup_hint` (415) | `Remove itens de ação concluídos/cancelados, marcos...` | `Remove tarefas concluídas/canceladas, marcos...` |
| `data_cleanup_confirm_body` (419) | `{actions} itens de ação, {milestones} marcos...` | `{actions} tarefas, {milestones} marcos...` |
| `tags_cross_apply_hint` (314) | `As tags de ação (as 6 cores) podem ter nomes diferentes...` | `As tags de tarefa (as 6 cores) podem ter nomes diferentes...` |

(`data_cleanup_nothing_body`'s pt-BR counterpart and any other pt-BR key using
"ação"/"ações" for this concept gets the same treatment — the table above is the
confirmed set from the current grep; the implementer should re-grep
`action.item|itens? de a[çc][ãa]o` over `src/core/i18n.ts` right before editing in
case anything shifted, and fix agreement — "tarefas concluídas" not "tarefas
concluídos", since "tarefa" is feminine where "ação"/item pairs may have used
different gender.)

## Not changed

- `Doc.actionItems` field name, `src/modules/action-items.ts` file name,
  `kanban_*` i18n keys, `ModuleRef`'s `{ kind: 'actions' }`, CSS classes
  (`tt-kanban-*`, `tt-actions-*` if any) — all internal, invisible to the user.
- Code comments referencing "action item(s)" — not user-visible text.

## Testing

No new test coverage needed — this is a content-only i18n change. Existing tests
that assert on specific English/Portuguese copy (if any snapshot the sidebar
label or these hint strings) get updated to match. Run `npm run test` to confirm
nothing was asserting the old wording as an implicit regression check.
