# Action Items Kanban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat checkbox-list action-items module with a 3-column kanban board (To Do / WIP / Done+Cancelled), per `docs/superpowers/specs/2026-07-15-action-items-kanban-design.md`.

**Architecture:** `src/modules/action-items.ts` is rewritten wholesale (same exported `renderActionItems` signature, so `main.ts`'s registration is untouched). `ActionItem` gains a `status`/`color` shape via a schema v3→v4 migration. All editing happens in a modal (no more live inline inputs on the board), which removes the old file's caret-preserving-rebuild complexity entirely. i18n and CSS are additive/replacing sibling changes.

**Tech Stack:** TypeScript, esbuild, vitest/jsdom, no runtime dependencies (per `CLAUDE.md`).

## Global Constraints

- Zero runtime dependencies — do not add any package to `dependencies`.
- Every `src` module keeps a matching `test/*.test.ts` file; tests run under jsdom with Web Locks/BroadcastChannel/FS Access API absent — code must degrade gracefully.
- All user-visible strings go through `t(locale, key)`; add every new key to **both** `pt-BR` and `en-US` blocks in `src/core/i18n.ts` (the `en` object is typed `Record<MsgKey, string>` where `MsgKey = keyof typeof pt`, so the two key sets must match exactly or `tsc` fails).
- Bump `SCHEMA_VERSION` and add a `MIGRATIONS[n]` entry whenever the persisted `Doc` shape changes (`src/core/document.ts`).
- Run `npm run typecheck`, `npm test`, and `npm run lint` before considering any task done; the final task additionally runs `npm run build`.

---

## File Structure

- **Modify `src/core/types.ts`** — `ActionItem` interface: `text`→`summary`, `done: boolean`→`status: 'todo'|'wip'|'done'|'cancelled'`, add `color`.
- **Modify `src/core/document.ts`** — `SCHEMA_VERSION` 3→4, new `MIGRATIONS[3]` step.
- **Modify `test/document.test.ts`** — new `v3 → v4 migration` describe block.
- **Modify `src/core/i18n.ts`** — remove 10 `action_*` keys (both locales), add ~29 `kanban_*` keys (both locales).
- **Modify `src/core/search.ts`** — `item.text` → `item.summary` (indexing rename only).
- **Modify `test/search.test.ts`, `test/search-ui.test.ts`** — fixture field renames.
- **Modify `styles.css`** — replace the `.tt-action-*` section with `.tt-kanban-*` rules; add 6 paired light/dark card-accent custom properties; add `.tt-btn-left`/`.tt-btn-danger`.
- **Modify `src/ui/modal.ts`** — `ModalButton` gains optional `danger`/`left`; `test/modal.test.ts` gets 2 new cases.
- **Rewrite `src/modules/action-items.ts`** and **`test/action-items.test.ts`** — the kanban board itself (Tasks 4–5).

---

### Task 1: Data model & migration

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/document.ts`
- Modify: `test/document.test.ts`

**Interfaces:**
- Produces: `ActionItem { id: string; summary: string; notes: string; status: 'todo'|'wip'|'done'|'cancelled'; dueDate: string|null; assignee: string; color: 'slate'|'brass'|'sage'|'rust'|'plum'|'ledger'; order: number }`. `order` is dense `0..n-1` **within its status group**, not globally.

- [ ] **Step 1: Write the failing migration tests**

Add to `test/document.test.ts` (after the existing `v2 → v3 migration` describe block):

```ts
describe('v3 → v4 migration (action items kanban)', () => {
  function v3Doc() {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 3
    d.teams = [{
      id: 't1', name: 'T', emoji: '🙂', dailyNotes: {},
      stakeholders: [], members: [],
      actionItems: [
        { id: 'a1', text: 'Open one', done: false, dueDate: null, assignee: '', order: 5, notes: '' },
        { id: 'a2', text: 'Open two', done: false, dueDate: null, assignee: '', order: 2, notes: '' },
        { id: 'a3', text: 'Done one', done: true, dueDate: null, assignee: '', order: 9, notes: '' },
      ],
      milestones: [], risks: [],
    }]
    return d
  }
  it('bumps to the current version', () => {
    const doc = migrate(v3Doc())
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
  })
  it('renames text to summary and maps done to status', () => {
    const doc = migrate(v3Doc())
    const items = doc.teams[0]!.actionItems
    expect(items.find((i) => i.id === 'a1')).toMatchObject({ summary: 'Open one', status: 'todo' })
    expect(items.find((i) => i.id === 'a3')).toMatchObject({ summary: 'Done one', status: 'done' })
    expect((items.find((i) => i.id === 'a1') as any).text).toBeUndefined()
    expect((items.find((i) => i.id === 'a1') as any).done).toBeUndefined()
  })
  it('defaults color to ledger', () => {
    const doc = migrate(v3Doc())
    expect(doc.teams[0]!.actionItems.every((i) => i.color === 'ledger')).toBe(true)
  })
  it('renumbers order densely within each status group, not globally', () => {
    const doc = migrate(v3Doc())
    const items = doc.teams[0]!.actionItems
    const todo = items.filter((i) => i.status === 'todo').sort((a, b) => a.order - b.order)
    expect(todo.map((i) => i.id)).toEqual(['a2', 'a1']) // a2 had order 2, a1 had order 5
    expect(todo.map((i) => i.order)).toEqual([0, 1])
    const done = items.filter((i) => i.status === 'done')
    expect(done.map((i) => i.order)).toEqual([0])
  })
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run test/document.test.ts`
Expected: FAIL — schema is still 3, migration step doesn't exist, `.text`/`.done` still present.

- [ ] **Step 3: Update the `ActionItem` type**

In `src/core/types.ts`, replace:

```ts
export interface ActionItem {
  id: string; text: string; done: boolean
  dueDate: string | null; assignee: string; order: number
  notes: string
}
```

with:

```ts
export interface ActionItem {
  id: string; summary: string; notes: string
  status: 'todo' | 'wip' | 'done' | 'cancelled'
  dueDate: string | null; assignee: string
  color: 'slate' | 'brass' | 'sage' | 'rust' | 'plum' | 'ledger'
  order: number
}
```

- [ ] **Step 4: Add the migration step and bump the schema version**

In `src/core/document.ts`, change `export const SCHEMA_VERSION = 3` to `export const SCHEMA_VERSION = 4`, and add a new entry to `MIGRATIONS` (after the existing `2:` entry):

```ts
  3: (d) => {
    for (const team of (d.teams as Record<string, unknown>[]) ?? []) {
      const items = (team.actionItems as Record<string, unknown>[]) ?? []
      for (const a of items) {
        a.summary = a.text ?? ''
        delete a.text
        a.status = a.done ? 'done' : 'todo'
        delete a.done
        a.color = a.color ?? 'ledger'
      }
      const byStatus = new Map<string, Record<string, unknown>[]>()
      for (const a of items) {
        const key = a.status as string
        const arr = byStatus.get(key) ?? []
        arr.push(a)
        byStatus.set(key, arr)
      }
      for (const arr of byStatus.values()) {
        arr.sort((x, y) => (x.order as number) - (y.order as number))
        arr.forEach((a, i) => { a.order = i })
      }
    }
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/document.test.ts`
Expected: PASS, all cases including the pre-existing `v1 → v2` and `v2 → v3` describe blocks.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: New errors in `src/core/search.ts`, `src/core/i18n.ts` (none yet), and `src/modules/action-items.ts` (uses old `.text`/`.done` fields) — **expected and fixed by later tasks**. Confirm no errors in `src/core/types.ts` or `src/core/document.ts` themselves.

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/core/document.ts test/document.test.ts
git commit -m "$(cat <<'EOF'
feat: migrate ActionItem to a status enum + color for the kanban redesign

Schema v3->v4: text->summary, done->status(todo/wip/done/cancelled),
adds color, renumbers order per-status-group instead of globally.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: i18n keys

**Files:**
- Modify: `src/core/i18n.ts`

**Interfaces:**
- Produces: `MsgKey` gains ~29 `kanban_*` keys (see list below), loses 10 `action_*` keys.

- [ ] **Step 1: Remove the old `action_*` keys from the `pt` block**

In `src/core/i18n.ts`, replace:

```ts
  person_delete_btn: 'Excluir',
  action_add_btn: '+ Item',
  action_done_title: 'Concluído',
  action_text_placeholder: 'Descrição',
  action_assignee_placeholder: 'Responsável',
  action_delete_title: 'Excluir item',
  action_delete_confirm: 'Excluir "{text}"?',
  action_delete_btn: 'Excluir',
  action_done_heading: 'Itens concluídos ({count})',
  action_empty: 'Nenhum item',
  milestone_add_btn: '+ Marco',
```

with:

```ts
  person_delete_btn: 'Excluir',
  kanban_col_todo: 'A Fazer',
  kanban_col_wip: 'Em Andamento',
  kanban_col_done_cancelled: 'Concluído / Cancelado',
  kanban_done_heading: 'Concluído ({count})',
  kanban_cancelled_heading: 'Cancelado ({count})',
  kanban_add_card: '+ Cartão',
  kanban_add_title: 'Novo cartão',
  kanban_edit_title: 'Editar cartão',
  kanban_edit_hint: 'Clique duas vezes ou use ✎ para editar',
  kanban_summary_label: 'Resumo',
  kanban_summary_required: 'O resumo é obrigatório',
  kanban_notes_label: 'Notas',
  kanban_due_label: 'Prazo',
  kanban_assignee_label: 'Responsável',
  kanban_color_label: 'Cor',
  kanban_color_slate: 'Ardósia',
  kanban_color_brass: 'Latão',
  kanban_color_sage: 'Sálvia',
  kanban_color_rust: 'Ferrugem',
  kanban_color_plum: 'Ameixa',
  kanban_color_ledger: 'Cinza-ledger',
  kanban_save_btn: 'Salvar',
  kanban_delete_btn: 'Excluir',
  kanban_delete_title: 'Excluir cartão',
  kanban_delete_confirm: 'Excluir "{summary}"?',
  kanban_clear_zone_title: 'Limpar cartões',
  kanban_clear_zone_btn: 'Excluir todos',
  kanban_clear_zone_confirm: 'Excluir todos os {count} cartões desta área?',
  kanban_trash_hint: 'Soltar aqui para excluir',
  kanban_empty: 'Nenhum cartão',
  milestone_add_btn: '+ Marco',
```

- [ ] **Step 2: Remove `action_notes_toggle_title` from the `pt` block**

Replace:

```ts
  risks_closed_heading: 'Riscos concluídos ({count})',
  action_notes_toggle_title: 'Expandir/ocultar nota',
  milestone_followup_toggle_title: 'Expandir/ocultar follow-up',
```

with:

```ts
  risks_closed_heading: 'Riscos concluídos ({count})',
  milestone_followup_toggle_title: 'Expandir/ocultar follow-up',
```

- [ ] **Step 3: Replace the same 10 keys in the `en` block**

Replace:

```ts
  person_delete_btn: 'Delete',
  action_add_btn: '+ Item',
  action_done_title: 'Done',
  action_text_placeholder: 'Description',
  action_assignee_placeholder: 'Assignee',
  action_delete_title: 'Delete item',
  action_delete_confirm: 'Delete "{text}"?',
  action_delete_btn: 'Delete',
  action_done_heading: 'Completed items ({count})',
  action_empty: 'No items',
  milestone_add_btn: '+ Milestone',
```

with:

```ts
  person_delete_btn: 'Delete',
  kanban_col_todo: 'To Do',
  kanban_col_wip: 'WIP',
  kanban_col_done_cancelled: 'Done / Cancelled',
  kanban_done_heading: 'Done ({count})',
  kanban_cancelled_heading: 'Cancelled ({count})',
  kanban_add_card: '+ Card',
  kanban_add_title: 'New card',
  kanban_edit_title: 'Edit card',
  kanban_edit_hint: 'Double-click or use ✎ to edit',
  kanban_summary_label: 'Summary',
  kanban_summary_required: 'Summary is required',
  kanban_notes_label: 'Notes',
  kanban_due_label: 'Due date',
  kanban_assignee_label: 'Assignee',
  kanban_color_label: 'Color',
  kanban_color_slate: 'Slate',
  kanban_color_brass: 'Brass',
  kanban_color_sage: 'Sage',
  kanban_color_rust: 'Rust',
  kanban_color_plum: 'Plum',
  kanban_color_ledger: 'Ledger',
  kanban_save_btn: 'Save',
  kanban_delete_btn: 'Delete',
  kanban_delete_title: 'Delete card',
  kanban_delete_confirm: 'Delete "{summary}"?',
  kanban_clear_zone_title: 'Clear cards',
  kanban_clear_zone_btn: 'Delete all',
  kanban_clear_zone_confirm: 'Delete all {count} cards in this area?',
  kanban_trash_hint: 'Drop here to delete',
  kanban_empty: 'No cards',
  milestone_add_btn: '+ Milestone',
```

- [ ] **Step 4: Remove `action_notes_toggle_title` from the `en` block**

Replace:

```ts
  risks_closed_heading: 'Closed risks ({count})',
  action_notes_toggle_title: 'Expand/collapse note',
  milestone_followup_toggle_title: 'Expand/collapse follow-up',
```

with:

```ts
  risks_closed_heading: 'Closed risks ({count})',
  milestone_followup_toggle_title: 'Expand/collapse follow-up',
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: `src/core/i18n.ts` itself is clean (both `pt` and `en` have matching key sets). Remaining errors are only in `src/modules/action-items.ts`, `test/action-items.test.ts`, `src/core/search.ts`, `test/search.test.ts`, `test/search-ui.test.ts` (fixed in later tasks).

- [ ] **Step 6: Commit**

```bash
git add src/core/i18n.ts
git commit -m "$(cat <<'EOF'
feat: replace action_* i18n keys with kanban_* for the board redesign

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: CSS — kanban board, cards, trash zone, modal form

**Files:**
- Modify: `styles.css`

**Interfaces:**
- Produces (class contract the renderer in Tasks 4–5 must emit): `.tt-kanban`, `.tt-kanban-board`, `.tt-kanban-col`, `.tt-kanban-col-head`, `.tt-kanban-add-btn`, `.tt-kanban-col-body`, `.tt-kanban-empty`, `.tt-kanban-zone-label`, `.tt-kanban-zone-trash`, `.tt-kanban-divider`, `.tt-kanban-card` (+ `.color-{slate,brass,sage,rust,plum,ledger}`, `.status-cancelled`, `.tt-kanban-drop-before`, `.tt-kanban-drop-after`), `.tt-kanban-card-title`, `.tt-kanban-card-meta`, `.tt-kanban-card-due` (+ `.overdue`), `.tt-kanban-card-assignee`, `.tt-kanban-edit-btn`, `.tt-kanban-trash` (+ `.active`, `.drag-over`), `.tt-kanban-form`, `.tt-kanban-form-row`, `.tt-kanban-color-row`, `.tt-kanban-color-chip` (+ `.color-*`, `.selected`). Also `.tt-btn-left`, `.tt-btn-danger` (consumed by `src/ui/modal.ts` in Task 4).
- Produces CSS custom properties: `--card-slate`, `--card-brass`, `--card-sage`, `--card-rust`, `--card-plum`, `--card-ledger` (light + dark pairs).

- [ ] **Step 1: Add the 6 card-accent custom properties**

In `styles.css`, extend the light theme block:

```css
:root, [data-theme=light] {
  --bg:#eee7d6; --fg:#23241d; --muted:#5c5744; --accent:#3b5a6b; --accent-rgb:59,90,107;
  --panel:#f5efe1; --border:#c3b596; --brass:#9c6b2e; --danger:#a1402c; --ok:#4a6b45;
  --card-slate:#3b5a6b; --card-brass:#9c6b2e; --card-sage:#4a6b45; --card-rust:#a1402c; --card-plum:#6b4a7a; --card-ledger:#5c5744;
}
```

and the dark theme block:

```css
[data-theme=dark] {
  --bg:#1c1a14; --fg:#e8dfc8; --muted:#a89a78; --accent:#8fb6c4; --accent-rgb:143,182,196;
  --panel:#26231a; --border:#4a4530; --brass:#c99a4e; --danger:#d97b64; --ok:#8bab7e;
  --card-slate:#8fb6c4; --card-brass:#c99a4e; --card-sage:#8bab7e; --card-rust:#d97b64; --card-plum:#b98fcb; --card-ledger:#a89a78;
}
```

(Each dark value mirrors the existing accent/brass/ok/danger/muted lightening pattern already used for those pairs — `--card-plum` has no existing analog, so it gets the same "lighter, less saturated" treatment by eye.)

- [ ] **Step 2: Add `.tt-btn-left` / `.tt-btn-danger`**

Right after the existing `.tt-btn-primary:hover { color: #fff; opacity: .9; }` rule, add:

```css
.tt-btn-left { margin-right: auto; }
.tt-btn-danger { border-color: var(--danger); color: var(--danger); background: transparent; }
.tt-btn-danger:hover { opacity: .8; }
```

- [ ] **Step 3: Replace the `.tt-action-*` section with `.tt-kanban-*`**

Replace the entire block (from the `/* Action items module */` comment through the last `.tt-action-notes-row .editor` rule):

```css
/* Action items module */
.tt-actions { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: auto; padding: .5rem; gap: .5rem; }
.tt-action-toolbar { flex: none; }
.tt-action-list { display: flex; flex-direction: column; gap: .2rem; }
.tt-action-empty { color: var(--muted); padding: .5rem; }
.tt-action-row {
  display: flex; align-items: center; gap: .4rem; padding: .3rem .4rem; border-radius: 4px;
  border: 1px solid var(--border); cursor: grab;
}
.tt-action-row:hover { background: rgba(var(--accent-rgb), .08); }
.tt-action-row[draggable="false"] { cursor: default; }
.tt-action-text { flex: 1; min-width: 0; }
.tt-action-due { font-family: var(--font-data); flex: none; width: 9.5rem; }
.tt-action-assignee { flex: none; width: 9rem; }
.tt-action-expand-btn, .tt-action-delete-btn { opacity: 0; flex: none; padding: .1rem .35rem; font-size: .85rem; border: none; background: transparent; }
.tt-action-row:hover .tt-action-expand-btn, .tt-action-expand-btn:focus,
.tt-action-row:hover .tt-action-delete-btn, .tt-action-delete-btn:focus { opacity: 1; }
.tt-action-row.tt-action-drop-before { box-shadow: inset 0 2px 0 0 var(--accent); }
.tt-action-row.tt-action-drop-after { box-shadow: inset 0 -2px 0 0 var(--accent); }
.tt-action-row.overdue .tt-action-text { color: var(--danger); }
.tt-action-row.overdue .tt-action-due { font-weight: 700; color: var(--danger); }
.tt-action-row.tt-action-done-row .tt-action-text { text-decoration: line-through; color: var(--muted); }
/* Completed-items disclosure — same treatment as risks' closed-risks
   section (src/modules/risks.ts's .tt-risks-closed): a native <details>
   instead of a manual show/hide toggle button, muted and dimmed. */
.tt-actions-done { flex: none; color: var(--muted); font-size: .85rem; border-top: 1px solid var(--border); padding-top: .3rem; }
.tt-actions-done summary { cursor: pointer; padding: .2rem .4rem; }
.tt-actions-done.tt-actions-done-empty { display: none; }
.tt-actions-done .tt-action-row { opacity: .75; }
.tt-action-notes-row { padding: 0 0 .5rem .4rem; }
.tt-action-notes-row .tt-editor { height: auto; border: 1px solid var(--border); border-radius: 6px; }
.tt-action-notes-row .editor { min-height: 160px; max-height: 320px; overflow-y: auto; }
```

with:

```css
/* Action items module — kanban board (To Do / WIP / Done+Cancelled) */
.tt-kanban { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; padding: .5rem; }
.tt-kanban-board { display: grid; grid-template-columns: 1fr 1fr 1.15fr; gap: .75rem; flex: 1; min-height: 0; }
.tt-kanban-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.tt-kanban-col-head { display: flex; align-items: center; justify-content: space-between; font-weight: 700; padding: .3rem .4rem .6rem; border-bottom: 2px solid var(--border); margin-bottom: .5rem; flex: none; }
.tt-kanban-add-btn { border: 1px dashed var(--border); background: transparent; color: var(--muted); border-radius: 6px; padding: .2rem .5rem; font-size: .82rem; cursor: pointer; }
.tt-kanban-add-btn:hover { color: var(--fg); border-color: var(--accent); }
.tt-kanban-col-body { display: flex; flex-direction: column; gap: .5rem; overflow-y: auto; flex: 1; min-height: 40px; padding-bottom: .5rem; }
.tt-kanban-empty { color: var(--muted); padding: .5rem; font-size: .85rem; }
.tt-kanban-zone-label { display: flex; align-items: center; justify-content: space-between; font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 .3rem; flex: none; }
.tt-kanban-zone-trash { border: none; background: transparent; opacity: .6; cursor: pointer; font-size: .85rem; padding: .1rem .3rem; }
.tt-kanban-zone-trash:hover { opacity: 1; }
.tt-kanban-divider { border-top: 1px dashed var(--border); margin: .5rem 0 .4rem; flex: none; }

.tt-kanban-card {
  position: relative; background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
  padding: .5rem .55rem .45rem; box-shadow: 0 1px 2px rgba(0, 0, 0, .06); cursor: grab;
  border-left: 5px solid var(--card-ledger);
}
.tt-kanban-card.color-slate { border-left-color: var(--card-slate); }
.tt-kanban-card.color-brass { border-left-color: var(--card-brass); }
.tt-kanban-card.color-sage { border-left-color: var(--card-sage); }
.tt-kanban-card.color-rust { border-left-color: var(--card-rust); }
.tt-kanban-card.color-plum { border-left-color: var(--card-plum); }
.tt-kanban-card.color-ledger { border-left-color: var(--card-ledger); }
.tt-kanban-card-title { font-family: var(--font-display); font-weight: 600; font-size: 1rem; line-height: 1.25; margin-bottom: .3rem; padding-right: 1.3rem; }
.tt-kanban-card-meta { display: flex; gap: .6rem; font-size: .72rem; color: var(--muted); font-family: var(--font-data); }
.tt-kanban-card-due.overdue { color: var(--danger); font-weight: 700; }
.tt-kanban-card.status-cancelled { opacity: .65; }
.tt-kanban-card.status-cancelled .tt-kanban-card-title { text-decoration: line-through; }
.tt-kanban-edit-btn { position: absolute; top: .3rem; right: .35rem; opacity: 0; border: none; background: transparent; font-size: .78rem; padding: .05rem .25rem; cursor: pointer; }
.tt-kanban-card:hover .tt-kanban-edit-btn, .tt-kanban-edit-btn:focus { opacity: 1; }
.tt-kanban-card.tt-kanban-drop-before { box-shadow: inset 0 2px 0 0 var(--accent); }
.tt-kanban-card.tt-kanban-drop-after { box-shadow: inset 0 -2px 0 0 var(--accent); }

/* Floating trash drop zone — absolute overlay, hidden until a drag starts
   (same rationale as .tt-people-root-drop: revealing it must not reflow the
   board mid-dragstart, or Chrome cancels the drag). */
.tt-kanban-trash {
  display: none; position: absolute; bottom: .6rem; left: 50%; transform: translateX(-50%); z-index: 5;
  padding: .5rem 1rem; border: 2px dashed var(--danger); border-radius: 8px; color: var(--danger);
  background: var(--bg); font-size: .85rem; text-align: center;
}
.tt-kanban-trash.active { display: block; }
.tt-kanban-trash.drag-over { background: rgba(var(--accent-rgb), .12); }

.tt-kanban-form { display: flex; flex-direction: column; gap: .65rem; }
.tt-kanban-form .tt-editor { height: auto; border: 1px solid var(--border); border-radius: 6px; }
.tt-kanban-form .editor { min-height: 120px; max-height: 280px; overflow-y: auto; }
.tt-kanban-form-row { display: flex; gap: .6rem; }
.tt-kanban-form-row .tt-field { flex: 1; }
.tt-kanban-color-row { display: flex; gap: .4rem; margin-top: .2rem; }
.tt-kanban-color-chip { width: 26px; height: 26px; border-radius: 6px; cursor: pointer; border: 2px solid transparent; padding: 0; }
.tt-kanban-color-chip.color-slate { background: var(--card-slate); }
.tt-kanban-color-chip.color-brass { background: var(--card-brass); }
.tt-kanban-color-chip.color-sage { background: var(--card-sage); }
.tt-kanban-color-chip.color-rust { background: var(--card-rust); }
.tt-kanban-color-chip.color-plum { background: var(--card-plum); }
.tt-kanban-color-chip.color-ledger { background: var(--card-ledger); }
.tt-kanban-color-chip.selected { border-color: var(--fg); }
```

- [ ] **Step 4: Verify the build still inlines the stylesheet cleanly**

Run: `npm run build`
Expected: exits 0, `dist/app.html` and `dist/pwa/` are produced with no errors.

- [ ] **Step 5: Commit**

```bash
git add styles.css
git commit -m "$(cat <<'EOF'
feat: kanban board CSS (columns, cards, floating trash, edit-modal form)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Board rendering + full CRUD modal (no drag yet)

**Files:**
- Modify: `src/ui/modal.ts`
- Modify: `test/modal.test.ts`
- Rewrite: `src/modules/action-items.ts`
- Rewrite: `test/action-items.test.ts`

**Interfaces:**
- Consumes: `ModuleCtx { store: Store; pm: PaneManager; paneIdx: 0|1; locale: Locale }` (`src/ui/panes.ts`); `showModal(opts: ModalOptions): ModalHandle`, `ModalButton { label; primary?; danger?; left?; onClick }` (`src/ui/modal.ts`, extended this task); `createEditor(hooks, locale): Editor` / `Editor { root; getMd(); setMd(); focus(); destroy() }` (`src/ui/editor.ts`); `attachAtAutocomplete(editor, opts): AtAutocompleteHandle`, `makeRefClickHandler(store, pm, paneIdx, locale, teamId)` (`src/ui/atref.ts`); `attachTemplatePicker(editor, opts): TemplatePickerHandle` (`src/ui/template-picker.ts`); `el(tag, attrs, ...children)` (`src/ui/dom.ts`).
- Produces: `itemsByStatus(items: ActionItem[], status: ActionItem['status']): ActionItem[]`; `isOverdue(item: Pick<ActionItem,'dueDate'|'status'>, today: string): boolean` — both consumed by Task 5's tests and by the renderer itself. `renderActionItems: ModuleRenderer` (unchanged export name/signature, registered in `main.ts` already).

- [ ] **Step 1: Extend `ModalButton` with `danger`/`left`**

In `src/ui/modal.ts`, replace:

```ts
export interface ModalButton {
  label: string
  primary?: boolean
  onClick: () => void
}
```

with:

```ts
export interface ModalButton {
  label: string
  primary?: boolean
  /** Renders with the outlined, --danger-colored style — e.g. a Delete action alongside Cancel/Save. */
  danger?: boolean
  /** Pushes this button to the start of the row (`margin-right: auto`) so it visually separates from the rest — e.g. keeping a Delete action apart from Cancel/Save. */
  left?: boolean
  onClick: () => void
}
```

and replace the `buttonEls` construction:

```ts
  const buttonEls: HTMLButtonElement[] = opts.buttons.map((b) => {
    const btn = el(
      'button',
      {
        class: b.primary ? 'tt-btn tt-btn-primary' : 'tt-btn',
        type: 'button',
        onclick: () => b.onClick(),
      },
      b.label
    )
    return btn
  })
```

with:

```ts
  const buttonEls: HTMLButtonElement[] = opts.buttons.map((b) => {
    const classes = ['tt-btn']
    if (b.primary) classes.push('tt-btn-primary')
    if (b.danger) classes.push('tt-btn-danger')
    if (b.left) classes.push('tt-btn-left')
    const btn = el(
      'button',
      {
        class: classes.join(' '),
        type: 'button',
        onclick: () => b.onClick(),
      },
      b.label
    )
    return btn
  })
```

- [ ] **Step 2: Add modal.ts tests for the new button styles**

Append to `test/modal.test.ts`:

```ts
test('a danger button gets the tt-btn-danger class', () => {
  showModal({ title: 'T', body: el('div', {}), buttons: [{ label: 'Delete', danger: true, onClick: () => {} }] })
  const btn = document.querySelector('.tt-modal-buttons button') as HTMLButtonElement
  expect(btn.classList.contains('tt-btn-danger')).toBe(true)
})

test('a left button gets the tt-btn-left class', () => {
  showModal({ title: 'T', body: el('div', {}), buttons: [{ label: 'Delete', left: true, onClick: () => {} }] })
  const btn = document.querySelector('.tt-modal-buttons button') as HTMLButtonElement
  expect(btn.classList.contains('tt-btn-left')).toBe(true)
})
```

- [ ] **Step 3: Run modal tests to verify they pass**

Run: `npx vitest run test/modal.test.ts`
Expected: PASS (7 tests total — 5 pre-existing + 2 new).

- [ ] **Step 4: Delete the old test file's contents and write the new pure-helper + board tests**

Replace the entire contents of `test/action-items.test.ts` with:

```ts
import { renderActionItems, itemsByStatus, isOverdue } from '../src/modules/action-items'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { PaneManager, ModuleCtx } from '../src/ui/panes'
import type { ActionItem, Loc, Team } from '../src/core/types'

function fakePM(): PaneManager {
  return {
    openInPane: () => {},
    openInFocused: () => {},
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
  }
}

function item(overrides: Partial<ActionItem>): ActionItem {
  return { id: 'i1', summary: 'Do thing', status: 'todo', dueDate: null, assignee: '', order: 0, notes: '', color: 'ledger', ...overrides }
}

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 'stk-1', name: 'Carla', role: 'Sponsor', parentId: null, order: 0, notes: '' }],
    members: [{ id: 'mem-1', name: 'Bruno', role: 'Dev', parentId: null, order: 0, notes: '' }],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}

function setup(team: Team): { container: HTMLElement; store: Store; pm: PaneManager; loc: Loc } {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  const store = createStore(doc)
  const pm = fakePM()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const loc: Loc = { teamId: team.id, ref: { kind: 'actions' } }
  return { container, store, pm, loc }
}

function render(container: HTMLElement, loc: Loc, store: Store, pm: PaneManager, paneIdx: 0 | 1 = 0): void {
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US' }
  renderActionItems(container, loc, ctx)
}

function clickByTitleOrText(root: ParentNode, text: string): void {
  const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text || b.title === text)
  if (!btn) throw new Error(`button "${text}" not found`)
  btn.click()
}

function cards(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tt-kanban-card'))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('pure helpers', () => {
  test('itemsByStatus filters and sorts by order', () => {
    const items = [item({ id: 'b', order: 1 }), item({ id: 'a', order: 0 }), item({ id: 'c', order: 2, status: 'done' })]
    expect(itemsByStatus(items, 'todo').map((i) => i.id)).toEqual(['a', 'b'])
    expect(itemsByStatus(items, 'done').map((i) => i.id)).toEqual(['c'])
  })

  describe('isOverdue', () => {
    test('true when dueDate is in the past and the item is todo/wip', () => {
      expect(isOverdue({ dueDate: '2000-01-01', status: 'todo' }, '2026-07-15')).toBe(true)
      expect(isOverdue({ dueDate: '2000-01-01', status: 'wip' }, '2026-07-15')).toBe(true)
    })
    test('false when done or cancelled, even if the due date is in the past', () => {
      expect(isOverdue({ dueDate: '2000-01-01', status: 'done' }, '2026-07-15')).toBe(false)
      expect(isOverdue({ dueDate: '2000-01-01', status: 'cancelled' }, '2026-07-15')).toBe(false)
    })
    test('false when there is no due date', () => {
      expect(isOverdue({ dueDate: null, status: 'todo' }, '2026-07-15')).toBe(false)
    })
    test('false when the due date is today or in the future', () => {
      expect(isOverdue({ dueDate: '2026-07-15', status: 'todo' }, '2026-07-15')).toBe(false)
      expect(isOverdue({ dueDate: '2999-01-01', status: 'todo' }, '2026-07-15')).toBe(false)
    })
  })
})

describe('renderActionItems — board', () => {
  test('renders cards into their status column, sorted by order', () => {
    const team = makeTeam({
      actionItems: [
        item({ id: 'b', summary: 'B', order: 1, status: 'todo' }),
        item({ id: 'a', summary: 'A', order: 0, status: 'todo' }),
        item({ id: 'w', summary: 'W', order: 0, status: 'wip' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const todoCol = container.querySelectorAll('.tt-kanban-col')[0]!
    const titles = Array.from(todoCol.querySelectorAll('.tt-kanban-card-title')).map((n) => n.textContent)
    expect(titles).toEqual(['A', 'B'])
    expect(container.querySelectorAll('.tt-kanban-col')[1]!.querySelector('.tt-kanban-card-title')!.textContent).toBe('W')
  })

  test('shows an empty placeholder per column with no cards', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(container.querySelectorAll('.tt-kanban-empty')).toHaveLength(4) // todo, wip, done, cancelled
  })

  test('done/cancelled zone headers show a count', () => {
    const team = makeTeam({
      actionItems: [item({ id: 'd1', status: 'done' }), item({ id: 'd2', status: 'done' }), item({ id: 'c1', status: 'cancelled' })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const labels = container.querySelectorAll('.tt-kanban-zone-label')
    expect(labels[0]!.textContent).toContain('Done (2)')
    expect(labels[1]!.textContent).toContain('Cancelled (1)')
  })

  test('cancelled cards render with the cancelled status class', () => {
    const team = makeTeam({ actionItems: [item({ id: 'c1', status: 'cancelled' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(cards(container)[0]!.classList.contains('status-cancelled')).toBe(true)
  })

  test('an overdue todo card gets the overdue class on its due badge', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', dueDate: '2000-01-01', status: 'todo' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(container.querySelector('.tt-kanban-card-due')!.classList.contains('overdue')).toBe(true)
  })

  test('a done card with a past due date is not overdue', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', dueDate: '2000-01-01', status: 'done' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(container.querySelector('.tt-kanban-card-due')!.classList.contains('overdue')).toBe(false)
  })

  test('card carries data-item-id for search/@ref navigation', () => {
    const team = makeTeam({ actionItems: [item({ id: 'zz' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(cards(container)[0]!.getAttribute('data-item-id')).toBe('zz')
  })

  test('a defensive no-op when loc.ref.kind is not "actions"', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm } = setup(team)
    const wrongLoc: Loc = { teamId: 'T1', ref: { kind: 'members' } }
    render(container, wrongLoc, store, pm)
    expect(container.children).toHaveLength(0)
  })

  test('double render into the same container disposes the previous store subscription', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    container.innerHTML = ''
    render(container, loc, store, pm)
    expect(() => store.update((d) => { d.teams[0]!.actionItems[0]!.summary = 'A2' })).not.toThrow()
    expect(cards(container)).toHaveLength(1)
  })

  test("the assignee input's datalist lists stakeholders and members by name", () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card') // To Do column's add button (first in DOM order)
    const assigneeInput = document.querySelector('.tt-kanban-form-row input[type="text"]') as HTMLInputElement
    const datalist = document.getElementById(assigneeInput.getAttribute('list')!)!
    const options = Array.from(datalist.querySelectorAll('option')).map((o) => o.getAttribute('value'))
    expect(options).toEqual(expect.arrayContaining(['Carla', 'Bruno']))
  })
})

describe('renderActionItems — edit modal', () => {
  test('"+ Card" in To Do creates a card in the todo column with the entered fields', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card')
    const summaryInput = document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement
    summaryInput.value = 'New task'
    const dueInput = document.querySelector('.tt-kanban-form input[type="date"]') as HTMLInputElement
    dueInput.value = '2026-08-01'
    ;(document.querySelectorAll('.tt-kanban-color-chip')[2] as HTMLButtonElement).click() // 3rd = sage

    clickByTitleOrText(document.body, 'Save')

    const created = store.doc.teams[0]!.actionItems[0]!
    expect(created.summary).toBe('New task')
    expect(created.status).toBe('todo')
    expect(created.dueDate).toBe('2026-08-01')
    expect(created.color).toBe('sage')
  })

  test('"+ Card" in WIP creates a card in the wip column', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const wipAddBtn = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === '+ Card')[1]!
    wipAddBtn.click()
    const summaryInput = document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement
    summaryInput.value = 'WIP task'
    clickByTitleOrText(document.body, 'Save')

    expect(store.doc.teams[0]!.actionItems[0]!.status).toBe('wip')
  })

  test('leaving summary blank shows a validation error and does not save', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, '+ Card')
    clickByTitleOrText(document.body, 'Save')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
    expect(document.querySelector('.tt-field-error')!.textContent).toBe('Summary is required')
  })

  test('editing an existing card via dblclick pre-fills fields and Save persists changes', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: 'Old', dueDate: '2026-01-01', assignee: 'Bruno', color: 'rust' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    const summaryInput = document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement
    expect(summaryInput.value).toBe('Old')
    summaryInput.value = 'New'
    clickByTitleOrText(document.body, 'Save')

    expect(store.doc.teams[0]!.actionItems[0]!.summary).toBe('New')
  })

  test('the pencil icon opens the same edit modal as dblclick', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: 'Old' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, 'Double-click or use ✎ to edit')
    expect(document.querySelector('.tt-kanban-form')).not.toBeNull()
  })

  test('the edit modal\'s Delete button closes it and opens the confirm-delete flow', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: 'Important' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(document.querySelector('.tt-kanban-form')).not.toBeNull()

    clickByTitleOrText(document.body, 'Delete')
    expect(document.querySelector('.tt-kanban-form')).toBeNull()
    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Delete "Important"?')

    clickByTitleOrText(document.body, 'Delete')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
  })

  test('canceling the delete confirmation keeps the card', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: 'Important' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    clickByTitleOrText(document.body, 'Delete')
    clickByTitleOrText(document.body, 'Cancel')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(1)
  })

  test('deleting a card whose summary is blank removes it immediately with no confirmation', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: '' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    clickByTitleOrText(document.body, 'Delete')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })
})

describe('renderActionItems — zone clear-all', () => {
  test('zone trash clears all cards in that zone after confirmation', () => {
    const team = makeTeam({
      actionItems: [item({ id: 'd1', status: 'done' }), item({ id: 'd2', status: 'done' }), item({ id: 'c1', status: 'cancelled' })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Clear cards') // first zone-trash button = Done zone
    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Delete all 2 cards in this area?')
    clickByTitleOrText(document.body, 'Delete all')

    expect(store.doc.teams[0]!.actionItems.filter((i) => i.status === 'done')).toHaveLength(0)
    expect(store.doc.teams[0]!.actionItems.filter((i) => i.status === 'cancelled')).toHaveLength(1)
  })

  test('zone trash is a no-op on an empty zone (no modal opens)', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, 'Clear cards')
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('canceling clear-zone keeps the cards', () => {
    const team = makeTeam({ actionItems: [item({ id: 'd1', status: 'done' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, 'Clear cards')
    clickByTitleOrText(document.body, 'Cancel')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(1)
  })
})
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run test/action-items.test.ts`
Expected: FAIL to even load — `src/modules/action-items.ts` doesn't export `itemsByStatus`/`isOverdue` with this shape yet and still uses the old `ActionItem` fields.

- [ ] **Step 6: Rewrite `src/modules/action-items.ts`**

Replace the entire file:

```ts
// src/modules/action-items.ts — kanban board (To Do / WIP / Done+Cancelled)
// for a team's action items. Cards are edited exclusively through a modal
// (openEditModal below); the board itself has no live inputs, so a full
// rebuild on every store change (like src/modules/people-tree.ts's
// renderAll) is simplest and correct — unlike the old flat-list version,
// there's no in-progress inline edit whose caret needs preserving across a
// foreign store update.
import type { ActionItem, Loc, Team } from '../core/types'
import { t, todayIso, formatDate } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, type AtPerson, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
import { el } from '../ui/dom'

/** Per-container disposers — see the extensive comment on the same pattern in src/modules/daily-notes.ts. */
const disposers = new WeakMap<HTMLElement, () => void>()

const COLORS: ActionItem['color'][] = ['slate', 'brass', 'sage', 'rust', 'plum', 'ledger']
const COLOR_KEYS: Record<ActionItem['color'], 'kanban_color_slate' | 'kanban_color_brass' | 'kanban_color_sage' | 'kanban_color_rust' | 'kanban_color_plum' | 'kanban_color_ledger'> = {
  slate: 'kanban_color_slate', brass: 'kanban_color_brass', sage: 'kanban_color_sage',
  rust: 'kanban_color_rust', plum: 'kanban_color_plum', ledger: 'kanban_color_ledger',
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}
function nowHHMM(): string {
  const now = new Date()
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
}

// --- pure, unit-testable helpers -------------------------------------------

/** Items in `status`, sorted by `order`. */
export function itemsByStatus(items: ActionItem[], status: ActionItem['status']): ActionItem[] {
  return items.filter((i) => i.status === status).sort((a, b) => a.order - b.order)
}

/** True when the item has a due date strictly before `today` and is still active (not done/cancelled). */
export function isOverdue(item: Pick<ActionItem, 'dueDate' | 'status'>, today: string): boolean {
  return item.dueDate !== null && item.dueDate < today && item.status !== 'done' && item.status !== 'cancelled'
}

// --- renderer ---------------------------------------------------------------

export function renderActionItems(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void {
  disposers.get(container)?.()
  disposers.delete(container)

  if (loc.ref.kind !== 'actions') return // registered only for 'actions'; defensive
  const teamId = loc.teamId
  const lc = ctx.locale
  const datalistId = `tt-kanban-people-${Math.random().toString(36).slice(2)}`

  function findTeam(): Team | undefined {
    return ctx.store.doc.teams.find((tm) => tm.id === teamId)
  }
  function items(): ActionItem[] {
    return findTeam()?.actionItems ?? []
  }

  function getPeople(): AtPerson[] {
    const tm = findTeam()
    if (!tm) return []
    return [
      ...tm.stakeholders.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'stakeholders' })),
      ...tm.members.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'members' })),
    ]
  }

  function removeItem(id: string): void {
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      tm.actionItems = tm.actionItems.filter((i) => i.id !== id)
    })
  }

  function openDeleteConfirm(item: ActionItem): void {
    const body = el('p', { class: 'tt-modal-message' }, t(lc, 'kanban_delete_confirm', { summary: item.summary }))
    const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
    const confirmBtn: ModalButton = {
      label: t(lc, 'kanban_delete_btn'),
      danger: true,
      onClick: () => {
        removeItem(item.id)
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({ title: t(lc, 'kanban_delete_title'), body, buttons: [cancelBtn, confirmBtn] })
  }

  function requestDelete(item: ActionItem): void {
    if (item.summary.trim() === '') {
      removeItem(item.id) // empty cards carry no meaningful content to lose — delete silently
      return
    }
    openDeleteConfirm(item)
  }

  function clearZone(status: ActionItem['status']): void {
    const count = itemsByStatus(items(), status).length
    if (count === 0) return
    const body = el('p', { class: 'tt-modal-message' }, t(lc, 'kanban_clear_zone_confirm', { count: String(count) }))
    const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
    const confirmBtn: ModalButton = {
      label: t(lc, 'kanban_clear_zone_btn'),
      danger: true,
      onClick: () => {
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          if (!tm) return
          tm.actionItems = tm.actionItems.filter((i) => i.status !== status)
        })
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({ title: t(lc, 'kanban_clear_zone_title'), body, buttons: [cancelBtn, confirmBtn] })
  }

  interface ModalBundle { editor: Editor; atHandle: AtAutocompleteHandle; tplHandle: TemplatePickerHandle }
  let openBundle: ModalBundle | null = null

  /** Full CRUD modal: `existing === null` creates a new card in `defaultStatus`; otherwise edits/deletes `existing`. Mirrors src/modules/people-tree.ts's openPersonModal shape, plus a rich-text notes editor (created on open, destroyed on close) wired exactly like the old inline renderNotesRow (@ref autocomplete + '/' template picker). */
  function openEditModal(existing: ActionItem | null, defaultStatus: 'todo' | 'wip' = 'todo'): void {
    const summaryInput = el('input', { type: 'text', class: 'tt-input', value: existing?.summary ?? '' }) as HTMLInputElement
    const dueInput = el('input', { type: 'date', class: 'tt-input', value: existing?.dueDate ?? '' }) as HTMLInputElement
    const assigneeInput = el('input', { type: 'text', class: 'tt-input', list: datalistId, value: existing?.assignee ?? '' }) as HTMLInputElement
    let selectedColor: ActionItem['color'] = existing?.color ?? 'ledger'
    const errorEl = el('div', { class: 'tt-field-error' })

    const editor: Editor = createEditor(
      { onChange() {}, onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId), onAtTrigger() {}, onSlashTrigger() {} },
      lc
    )
    editor.setMd(existing?.notes ?? '')
    const atHandle = attachAtAutocomplete(editor, { getPeople, locale: lc, onPick: () => {} })
    const tplHandle = attachTemplatePicker(editor, {
      getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
      getCtx: () => ({ dateIso: todayIso(), time: nowHHMM(), teamName: findTeam()?.name, locale: lc }),
      locale: lc,
    })
    openBundle = { editor, atHandle, tplHandle }

    const colorRow = el('div', { class: 'tt-kanban-color-row' })
    function paintSelectedColor(): void {
      colorRow.querySelectorAll('.tt-kanban-color-chip').forEach((chip) => {
        chip.classList.toggle('selected', chip.getAttribute('data-color') === selectedColor)
      })
    }
    for (const c of COLORS) {
      colorRow.appendChild(
        el('button', {
          type: 'button', class: `tt-kanban-color-chip color-${c}`, 'data-color': c, title: t(lc, COLOR_KEYS[c]),
          onclick: () => { selectedColor = c; paintSelectedColor() },
        })
      )
    }
    paintSelectedColor()

    const body = el(
      'div',
      { class: 'tt-kanban-form' },
      el('label', { class: 'tt-field' }, t(lc, 'kanban_summary_label'), summaryInput),
      el('div', { class: 'tt-field' }, t(lc, 'kanban_notes_label'), editor.root),
      el(
        'div',
        { class: 'tt-kanban-form-row' },
        el('label', { class: 'tt-field' }, t(lc, 'kanban_due_label'), dueInput),
        el('label', { class: 'tt-field' }, t(lc, 'kanban_assignee_label'), assigneeInput)
      ),
      el('div', { class: 'tt-field' }, t(lc, 'kanban_color_label'), colorRow),
      errorEl
    )

    function closeModal(): void {
      handle.close()
    }

    function save(): void {
      const summary = summaryInput.value.trim()
      if (summary === '') {
        errorEl.textContent = t(lc, 'kanban_summary_required')
        return
      }
      const dueDate = dueInput.value === '' ? null : dueInput.value
      const assignee = assigneeInput.value
      const notes = editor.getMd()
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm) return
        if (existing === null) {
          const group = itemsByStatus(tm.actionItems, defaultStatus)
          tm.actionItems.push({
            id: crypto.randomUUID(), summary, notes, status: defaultStatus,
            dueDate, assignee, color: selectedColor, order: group.length,
          })
        } else {
          const found = tm.actionItems.find((i) => i.id === existing.id)
          if (!found) return
          found.summary = summary
          found.notes = notes
          found.dueDate = dueDate
          found.assignee = assignee
          found.color = selectedColor
        }
      })
      closeModal()
    }

    const buttons: ModalButton[] = []
    if (existing !== null) {
      buttons.push({ label: t(lc, 'kanban_delete_btn'), danger: true, left: true, onClick: () => { closeModal(); requestDelete(existing) } })
    }
    buttons.push({ label: t(lc, 'cancel'), onClick: () => closeModal() })
    buttons.push({ label: t(lc, 'kanban_save_btn'), primary: true, onClick: () => save() })

    const handle: ModalHandle = showModal({
      title: t(lc, existing === null ? 'kanban_add_title' : 'kanban_edit_title'),
      body,
      buttons,
      onClose: () => {
        openBundle?.atHandle.dispose()
        openBundle?.tplHandle.dispose()
        openBundle?.editor.destroy()
        openBundle = null
      },
    })
    summaryInput.focus()
  }

  function emptyEl(): HTMLElement {
    return el('div', { class: 'tt-kanban-empty' }, t(lc, 'kanban_empty'))
  }

  function renderCard(item: ActionItem): HTMLElement {
    const editBtn = el(
      'button',
      { class: 'tt-btn tt-kanban-edit-btn', type: 'button', tabindex: '-1', title: t(lc, 'kanban_edit_hint'), onclick: (e: Event) => { e.stopPropagation(); openEditModal(item) } },
      '✎'
    )
    const titleEl = el('div', { class: 'tt-kanban-card-title' }, item.summary)
    const metaChildren: (Node | string)[] = []
    if (item.dueDate) {
      metaChildren.push(el('span', { class: 'tt-kanban-card-due' + (isOverdue(item, todayIso()) ? ' overdue' : '') }, formatDate(item.dueDate, lc)))
    }
    if (item.assignee) metaChildren.push(el('span', { class: 'tt-kanban-card-assignee' }, item.assignee))
    const metaEl = el('div', { class: 'tt-kanban-card-meta' }, ...metaChildren)

    const card = el(
      'div',
      { class: `tt-kanban-card color-${item.color} status-${item.status}`, 'data-item-id': item.id },
      editBtn, titleEl, metaEl
    )
    card.addEventListener('dblclick', () => openEditModal(item))
    return card
  }

  const todoBodyEl = el('div', { class: 'tt-kanban-col-body' })
  const wipBodyEl = el('div', { class: 'tt-kanban-col-body' })
  const doneBodyEl = el('div', { class: 'tt-kanban-col-body' })
  const cancelledBodyEl = el('div', { class: 'tt-kanban-col-body' })
  const doneCountEl = el('span', {})
  const cancelledCountEl = el('span', {})

  const todoColEl = el(
    'div', { class: 'tt-kanban-col' },
    el('div', { class: 'tt-kanban-col-head' },
      el('span', {}, t(lc, 'kanban_col_todo')),
      el('button', { class: 'tt-btn tt-kanban-add-btn', type: 'button', onclick: () => openEditModal(null, 'todo') }, t(lc, 'kanban_add_card'))
    ),
    todoBodyEl
  )
  const wipColEl = el(
    'div', { class: 'tt-kanban-col' },
    el('div', { class: 'tt-kanban-col-head' },
      el('span', {}, t(lc, 'kanban_col_wip')),
      el('button', { class: 'tt-btn tt-kanban-add-btn', type: 'button', onclick: () => openEditModal(null, 'wip') }, t(lc, 'kanban_add_card'))
    ),
    wipBodyEl
  )
  const doneCancelColEl = el(
    'div', { class: 'tt-kanban-col' },
    el('div', { class: 'tt-kanban-col-head' }, el('span', {}, t(lc, 'kanban_col_done_cancelled'))),
    el('div', { class: 'tt-kanban-zone-label' }, doneCountEl,
      el('button', { class: 'tt-btn tt-kanban-zone-trash', type: 'button', title: t(lc, 'kanban_clear_zone_title'), onclick: () => clearZone('done') }, '🗑')),
    doneBodyEl,
    el('div', { class: 'tt-kanban-divider' }),
    el('div', { class: 'tt-kanban-zone-label' }, cancelledCountEl,
      el('button', { class: 'tt-btn tt-kanban-zone-trash', type: 'button', title: t(lc, 'kanban_clear_zone_title'), onclick: () => clearZone('cancelled') }, '🗑')),
    cancelledBodyEl
  )

  const boardEl = el('div', { class: 'tt-kanban-board' }, todoColEl, wipColEl, doneCancelColEl)
  const datalistEl = el('datalist', { id: datalistId })

  function updateDatalist(): void {
    datalistEl.innerHTML = ''
    const tm = findTeam()
    const names = tm ? [...tm.stakeholders, ...tm.members].map((p) => p.name) : []
    for (const name of Array.from(new Set(names))) {
      datalistEl.appendChild(el('option', { value: name }))
    }
  }

  function renderAll(): void {
    updateDatalist()
    const todo = itemsByStatus(items(), 'todo')
    const wip = itemsByStatus(items(), 'wip')
    const done = itemsByStatus(items(), 'done')
    const cancelled = itemsByStatus(items(), 'cancelled')

    todoBodyEl.innerHTML = ''
    if (todo.length === 0) todoBodyEl.appendChild(emptyEl())
    else todo.forEach((it) => todoBodyEl.appendChild(renderCard(it)))

    wipBodyEl.innerHTML = ''
    if (wip.length === 0) wipBodyEl.appendChild(emptyEl())
    else wip.forEach((it) => wipBodyEl.appendChild(renderCard(it)))

    doneBodyEl.innerHTML = ''
    if (done.length === 0) doneBodyEl.appendChild(emptyEl())
    else done.forEach((it) => doneBodyEl.appendChild(renderCard(it)))

    cancelledBodyEl.innerHTML = ''
    if (cancelled.length === 0) cancelledBodyEl.appendChild(emptyEl())
    else cancelled.forEach((it) => cancelledBodyEl.appendChild(renderCard(it)))

    doneCountEl.textContent = t(lc, 'kanban_done_heading', { count: String(done.length) })
    cancelledCountEl.textContent = t(lc, 'kanban_cancelled_heading', { count: String(cancelled.length) })
  }
  renderAll()

  const unsubscribe = ctx.store.subscribe(() => {
    renderAll()
  })

  container.appendChild(el('div', { class: 'tt-kanban' }, boardEl, datalistEl))

  disposers.set(container, () => {
    unsubscribe()
    openBundle?.atHandle.dispose()
    openBundle?.tplHandle.dispose()
    openBundle?.editor.destroy()
    openBundle = null
  })
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/action-items.test.ts test/modal.test.ts`
Expected: PASS, all cases.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: Remaining errors only in `src/core/search.ts`, `test/search.test.ts`, `test/search-ui.test.ts` (fixed in Task 6).

- [ ] **Step 9: Commit**

```bash
git add src/ui/modal.ts test/modal.test.ts src/modules/action-items.ts test/action-items.test.ts
git commit -m "$(cat <<'EOF'
feat: kanban board rendering + full-CRUD edit modal for action items

Cards render into To Do/WIP/Done/Cancelled columns; create/edit/delete
all go through one modal (summary, rich-text notes, due date, assignee,
6-color accent). Drag-and-drop lands in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Drag-and-drop (reorder, cross-column move, drag-to-trash)

**Files:**
- Modify: `src/modules/action-items.ts`
- Modify: `test/action-items.test.ts`

**Interfaces:**
- Consumes: everything Task 4 produced in the same file (`items()`, `requestDelete`, `openEditModal`, the column body elements, `ctx.store.update`).
- Produces: `computeDropPosition(offsetY: number, height: number): 'before' | 'after'`; `moveCard(items: ActionItem[], draggedId: string, status: ActionItem['status'], targetId: string | null, position: 'before' | 'after'): void` (mutates in place, `targetId === null` appends at the end of `status`'s group).

- [ ] **Step 1: Write the failing pure-helper and DOM tests**

Append to `test/action-items.test.ts`, importing the two new functions at the top (change the first import line to `import { renderActionItems, itemsByStatus, isOverdue, computeDropPosition, moveCard } from '../src/modules/action-items'`):

```ts
describe('pure helpers — drag and drop', () => {
  describe('computeDropPosition', () => {
    test('top half is before, bottom half is after', () => {
      expect(computeDropPosition(0, 100)).toBe('before')
      expect(computeDropPosition(49, 100)).toBe('before')
      expect(computeDropPosition(50, 100)).toBe('after')
      expect(computeDropPosition(100, 100)).toBe('after')
    })
    test('degenerates to after for a zero/negative height card', () => {
      expect(computeDropPosition(0, 0)).toBe('after')
      expect(computeDropPosition(5, -1)).toBe('after')
    })
  })

  describe('moveCard', () => {
    test('reorders within the same status group, renumbering densely', () => {
      const items = [item({ id: 'a', order: 0 }), item({ id: 'b', order: 1 }), item({ id: 'c', order: 2 })]
      moveCard(items, 'c', 'todo', 'a', 'before')
      expect(itemsByStatus(items, 'todo').map((i) => i.id)).toEqual(['c', 'a', 'b'])
      expect(itemsByStatus(items, 'todo').map((i) => i.order)).toEqual([0, 1, 2])
    })

    test("moves to a different status, appending at the target group's end when targetId is null", () => {
      const items = [item({ id: 'a', status: 'todo', order: 0 }), item({ id: 'w', status: 'wip', order: 0 })]
      moveCard(items, 'a', 'wip', null, 'after')
      expect(items.find((i) => i.id === 'a')!.status).toBe('wip')
      expect(itemsByStatus(items, 'wip').map((i) => i.id)).toEqual(['w', 'a'])
      expect(itemsByStatus(items, 'todo')).toHaveLength(0)
    })

    test('moving to a different status closes the order gap in the old group', () => {
      const items = [item({ id: 'a', status: 'todo', order: 0 }), item({ id: 'b', status: 'todo', order: 1 }), item({ id: 'c', status: 'todo', order: 2 })]
      moveCard(items, 'b', 'done', null, 'after')
      expect(itemsByStatus(items, 'todo').map((i) => i.order)).toEqual([0, 1])
    })

    test('no-op when dropped onto itself in the same status', () => {
      const items = [item({ id: 'a', order: 0 }), item({ id: 'b', order: 1 })]
      moveCard(items, 'a', 'todo', 'a', 'before')
      expect(items.map((i) => i.order)).toEqual([0, 1])
    })

    test('no-op when the dragged id does not exist', () => {
      const items = [item({ id: 'a', order: 0 })]
      moveCard(items, 'ghost', 'todo', 'a', 'before')
      expect(items[0]!.order).toBe(0)
    })

    test('appends at the end when the target id is not found in the destination group', () => {
      const items = [item({ id: 'a', status: 'todo', order: 0 }), item({ id: 'w', status: 'wip', order: 0 })]
      moveCard(items, 'a', 'wip', 'ghost', 'before')
      expect(itemsByStatus(items, 'wip').map((i) => i.id)).toEqual(['w', 'a'])
    })
  })
})

describe('renderActionItems — drag and drop', () => {
  test('dragstart on a card shows the floating trash zone; dragend hides it', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const card = cards(container)[0]!
    const trash = container.querySelector('.tt-kanban-trash')!
    expect(trash.classList.contains('active')).toBe(false)
    card.dispatchEvent(new Event('dragstart', { bubbles: true }))
    expect(trash.classList.contains('active')).toBe(true)
    card.dispatchEvent(new Event('dragend', { bubbles: true }))
    expect(trash.classList.contains('active')).toBe(false)
  })

  test('dropping a card on the WIP column body moves it to wip, appended at the end', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', status: 'todo' }), item({ id: 'w', status: 'wip', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const cardA = cards(container)[0]!
    const wipBody = container.querySelectorAll('.tt-kanban-col')[1]!.querySelector('.tt-kanban-col-body')!
    cardA.dispatchEvent(new Event('dragstart', { bubbles: true }))
    wipBody.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))

    const updated = store.doc.teams[0]!.actionItems.find((i) => i.id === 'a')!
    expect(updated.status).toBe('wip')
    expect(itemsByStatus(store.doc.teams[0]!.actionItems, 'wip').map((i) => i.id)).toEqual(['w', 'a'])
  })

  test('dropping a card directly onto another card moves it into that card\'s zone (jsdom has no real layout, so it always lands "after")', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', status: 'todo' }), item({ id: 'd', status: 'done', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const cardA = cards(container).find((c) => c.getAttribute('data-item-id') === 'a')!
    const cardD = cards(container).find((c) => c.getAttribute('data-item-id') === 'd')!
    cardA.dispatchEvent(new Event('dragstart', { bubbles: true }))
    cardD.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))

    expect(store.doc.teams[0]!.actionItems.find((i) => i.id === 'a')!.status).toBe('done')
  })

  test('dropping a card on the floating trash zone opens the delete-confirm modal', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: 'Important' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const card = cards(container)[0]!
    const trash = container.querySelector('.tt-kanban-trash')!
    card.dispatchEvent(new Event('dragstart', { bubbles: true }))
    trash.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))

    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Delete "Important"?')
    clickByTitleOrText(document.body, 'Delete')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/action-items.test.ts`
Expected: FAIL — `computeDropPosition`/`moveCard` aren't exported yet; cards aren't `draggable` and have no drag listeners; `.tt-kanban-trash` doesn't exist.

- [ ] **Step 3: Add the pure helpers**

In `src/modules/action-items.ts`, replace:

```ts
/** True when the item has a due date strictly before `today` and is still active (not done/cancelled). */
export function isOverdue(item: Pick<ActionItem, 'dueDate' | 'status'>, today: string): boolean {
  return item.dueDate !== null && item.dueDate < today && item.status !== 'done' && item.status !== 'cancelled'
}

// --- renderer ---------------------------------------------------------------
```

with:

```ts
/** True when the item has a due date strictly before `today` and is still active (not done/cancelled). */
export function isOverdue(item: Pick<ActionItem, 'dueDate' | 'status'>, today: string): boolean {
  return item.dueDate !== null && item.dueDate < today && item.status !== 'done' && item.status !== 'cancelled'
}

/** Maps a drop's vertical offset within the target card to before/after. Degenerates to 'after' for a non-positive `height` (cards not yet laid out, e.g. in a test without real layout) rather than dividing by zero. */
export function computeDropPosition(offsetY: number, height: number): 'before' | 'after' {
  if (height <= 0) return 'after'
  return offsetY < height / 2 ? 'before' : 'after'
}

/**
 * Moves `draggedId` to `status`, positioned before/after `targetId` within
 * that status group (or appended at the end when `targetId` is null or not
 * found in the group — e.g. dropped on empty column space). Renumbers
 * `order` densely within both the destination group and, if the status
 * changed, the now-shrunk source group. Mutates `items` in place so it can
 * run directly inside a `store.update` callback. No-op when `draggedId`
 * doesn't exist, or when it's dropped onto itself without a status change.
 */
export function moveCard(items: ActionItem[], draggedId: string, status: ActionItem['status'], targetId: string | null, position: 'before' | 'after'): void {
  const dragged = items.find((i) => i.id === draggedId)
  if (!dragged) return
  if (dragged.status === status && draggedId === targetId) return
  const oldStatus = dragged.status
  dragged.status = status
  const destGroup = items.filter((i) => i.status === status && i.id !== draggedId).sort((a, b) => a.order - b.order)
  const targetIdx = targetId === null ? -1 : destGroup.findIndex((i) => i.id === targetId)
  const insertAt = targetIdx === -1 ? destGroup.length : (position === 'before' ? targetIdx : targetIdx + 1)
  destGroup.splice(insertAt, 0, dragged)
  destGroup.forEach((i, idx) => { i.order = idx })
  if (oldStatus !== status) {
    const oldGroup = items.filter((i) => i.status === oldStatus).sort((a, b) => a.order - b.order)
    oldGroup.forEach((i, idx) => { i.order = idx })
  }
}

// --- renderer ---------------------------------------------------------------
```

- [ ] **Step 4: Add drag state and the drop-class helper**

Replace:

```ts
  function findTeam(): Team | undefined {
    return ctx.store.doc.teams.find((tm) => tm.id === teamId)
  }
  function items(): ActionItem[] {
    return findTeam()?.actionItems ?? []
  }

  function getPeople(): AtPerson[] {
```

with:

```ts
  function findTeam(): Team | undefined {
    return ctx.store.doc.teams.find((tm) => tm.id === teamId)
  }
  function items(): ActionItem[] {
    return findTeam()?.actionItems ?? []
  }

  let draggedId: string | null = null

  function clearDropClasses(): void {
    boardEl.querySelectorAll('.tt-kanban-card').forEach((n) => {
      n.classList.remove('tt-kanban-drop-before', 'tt-kanban-drop-after')
    })
  }

  function getPeople(): AtPerson[] {
```

- [ ] **Step 5: Wire drag events onto each card**

Replace:

```ts
    const card = el(
      'div',
      { class: `tt-kanban-card color-${item.color} status-${item.status}`, 'data-item-id': item.id },
      editBtn, titleEl, metaEl
    )
    card.addEventListener('dblclick', () => openEditModal(item))
    return card
  }
```

with:

```ts
    const card = el(
      'div',
      { class: `tt-kanban-card color-${item.color} status-${item.status}`, draggable: 'true', 'data-item-id': item.id },
      editBtn, titleEl, metaEl
    )
    card.addEventListener('dblclick', () => openEditModal(item))

    card.addEventListener('dragstart', (e) => {
      draggedId = item.id
      trashEl.classList.add('active')
      const dt = (e as DragEvent).dataTransfer
      if (dt) { dt.setData('text/plain', item.id); dt.effectAllowed = 'move' }
    })
    card.addEventListener('dragover', (e) => {
      if (draggedId === null || draggedId === item.id) return
      e.preventDefault()
      const rect = card.getBoundingClientRect()
      const pos = computeDropPosition((e as MouseEvent).clientY - rect.top, rect.height)
      clearDropClasses()
      card.classList.add(`tt-kanban-drop-${pos}`)
    })
    card.addEventListener('dragleave', () => {
      card.classList.remove('tt-kanban-drop-before', 'tt-kanban-drop-after')
    })
    card.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      clearDropClasses()
      const srcId = draggedId
      draggedId = null
      if (srcId === null) return
      const rect = card.getBoundingClientRect()
      const pos = computeDropPosition((e as MouseEvent).clientY - rect.top, rect.height)
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm) return
        moveCard(tm.actionItems, srcId, item.status, item.id, pos)
      })
    })
    card.addEventListener('dragend', () => {
      draggedId = null
      clearDropClasses()
      trashEl.classList.remove('active', 'drag-over')
    })

    return card
  }
```

- [ ] **Step 6: Add the floating trash zone and per-column empty-space drop targets**

Replace:

```ts
  const boardEl = el('div', { class: 'tt-kanban-board' }, todoColEl, wipColEl, doneCancelColEl)
  const datalistEl = el('datalist', { id: datalistId })
```

with:

```ts
  const boardEl = el('div', { class: 'tt-kanban-board' }, todoColEl, wipColEl, doneCancelColEl)
  const datalistEl = el('datalist', { id: datalistId })

  // Drop target for deleting a card by dragging it off the board — shown
  // only while dragging (see dragstart above), same rationale as
  // src/modules/people-tree.ts's rootDropEl: revealing it must not reflow
  // the board mid-dragstart, or Chrome cancels the drag.
  const trashEl = el('div', { class: 'tt-kanban-trash' }, '🗑 ', t(lc, 'kanban_trash_hint'))
  trashEl.addEventListener('dragover', (e) => {
    if (draggedId === null) return
    e.preventDefault()
    trashEl.classList.add('drag-over')
  })
  trashEl.addEventListener('dragleave', () => {
    trashEl.classList.remove('drag-over')
  })
  trashEl.addEventListener('drop', (e) => {
    e.preventDefault()
    trashEl.classList.remove('active', 'drag-over')
    const srcId = draggedId
    draggedId = null
    if (srcId === null) return
    const found = items().find((i) => i.id === srcId)
    if (found) requestDelete(found)
  })

  /** Catches a drop onto empty column space (below the last card, or an empty column) — the case moveCard's `targetId === null` append handles. Card-level drop handlers already stopPropagation() so this never double-fires for a drop that landed on a specific card. */
  function wireColumnDrop(bodyEl: HTMLElement, status: ActionItem['status']): void {
    bodyEl.addEventListener('dragover', (e) => {
      if (draggedId === null) return
      e.preventDefault()
    })
    bodyEl.addEventListener('drop', (e) => {
      e.preventDefault()
      const srcId = draggedId
      draggedId = null
      if (srcId === null) return
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm) return
        moveCard(tm.actionItems, srcId, status, null, 'after')
      })
    })
  }
  wireColumnDrop(todoBodyEl, 'todo')
  wireColumnDrop(wipBodyEl, 'wip')
  wireColumnDrop(doneBodyEl, 'done')
  wireColumnDrop(cancelledBodyEl, 'cancelled')
```

- [ ] **Step 7: Append `trashEl` to the container**

Replace:

```ts
  container.appendChild(el('div', { class: 'tt-kanban' }, boardEl, datalistEl))
```

with:

```ts
  container.appendChild(el('div', { class: 'tt-kanban' }, boardEl, trashEl, datalistEl))
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/action-items.test.ts`
Expected: PASS, all cases (pure helpers, board, edit modal, zone clear-all, drag-and-drop).

- [ ] **Step 9: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: Both clean except `src/core/search.ts`/`test/search.test.ts`/`test/search-ui.test.ts` typecheck errors (fixed in Task 6).

- [ ] **Step 10: Commit**

```bash
git add src/modules/action-items.ts test/action-items.test.ts
git commit -m "$(cat <<'EOF'
feat: drag-and-drop for the kanban board (reorder, cross-column move, trash)

Cards are draggable within and across columns/zones; a floating trash
zone appears mid-drag for delete-by-drop (mirrors people-tree.ts's
root-drop-zone pattern).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Search index rename + final verification

**Files:**
- Modify: `src/core/search.ts`
- Modify: `test/search.test.ts`
- Modify: `test/search-ui.test.ts`

**Interfaces:**
- Consumes: `ActionItem.summary` (Task 1).

- [ ] **Step 1: Update the search fixtures (failing first)**

In `test/search.test.ts`, replace:

```ts
  t1.actionItems.push({ id: 'a1', text: 'Fechar contrato', done: false, dueDate: null, assignee: 'Ana', order: 0, notes: 'contrato assinado' })
```

with:

```ts
  t1.actionItems.push({ id: 'a1', summary: 'Fechar contrato', status: 'todo', color: 'ledger', dueDate: null, assignee: 'Ana', order: 0, notes: 'contrato assinado' })
```

In `test/search-ui.test.ts`, replace:

```ts
    actionItems: [{ id: 'a1', text: 'widget task', done: false, dueDate: null, assignee: '', order: 0, notes: '' }],
```

with:

```ts
    actionItems: [{ id: 'a1', summary: 'widget task', status: 'todo', color: 'ledger', dueDate: null, assignee: '', order: 0, notes: '' }],
```

- [ ] **Step 2: Run the tests to verify they still fail**

Run: `npx vitest run test/search.test.ts test/search-ui.test.ts`
Expected: FAIL — `src/core/search.ts` still reads `item.text`, which is now always `undefined` on the new fixtures (title becomes `undefined` instead of the expected summary text, snippet/search-term matches on `'contrato'`/`'widget'` break).

- [ ] **Step 3: Fix the indexer**

In `src/core/search.ts`, replace:

```ts
  for (const item of team.actionItems) {
    out.push({ raw: `${item.text}\n${item.assignee}\n${item.notes}`, title: item.text, ref: { kind: 'actions', itemId: item.id } })
  }
```

with:

```ts
  for (const item of team.actionItems) {
    out.push({ raw: `${item.summary}\n${item.assignee}\n${item.notes}`, title: item.summary, ref: { kind: 'actions', itemId: item.id } })
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/search.test.ts test/search-ui.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run, in order:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: all four exit 0. `npm test` should report all test files passing (the full suite, not just the ones touched by this plan — this catches any fixture elsewhere in `test/` that still references the old `ActionItem` shape).

- [ ] **Step 6: Commit**

```bash
git add src/core/search.ts test/search.test.ts test/search-ui.test.ts
git commit -m "$(cat <<'EOF'
fix: search index action items by summary instead of the removed text field

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** 3-column board ✓ (Task 4), create in To Do/WIP only ✓ (Task 4, no add-button on Done/Cancelled), drag-to-trash with confirm ✓ (Task 5), draggable + ordered within column ✓ (Task 5), title-major/due+assignee-minor font ✓ (Task 3 CSS + Task 4 markup), double-click and pencil-icon edit entry points ✓ (Task 4), summary/notes/due/assignee/color-accent (6 options) edit form ✓ (Task 4), Done/Cancelled two drop zones with strikethrough+grouping and per-zone trash/clear-all ✓ (Tasks 3–5), schema migration ✓ (Task 1), i18n both locales ✓ (Task 2).
- **Type consistency checked:** `itemsByStatus`/`isOverdue`/`computeDropPosition`/`moveCard` signatures match between their Task 4/5 definitions, the test imports, and all call sites. `ModalButton.danger`/`.left` used consistently in `action-items.ts` and asserted in `modal.test.ts`.
- **No placeholders:** every step has complete, non-elided code.
