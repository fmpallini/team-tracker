# Code Cleanup (Reuse/Simplification/Efficiency/Altitude) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the 13 actionable findings from the 2026-07-24 whole-codebase `/simplify` review (reuse, simplification, efficiency, altitude) without changing any user-visible behavior.

**Architecture:** Pure refactor. Every task either (a) extracts a helper that several call sites already implement identically, or (b) fixes a genuine perf/design smell in-place. No new features, no schema changes, no new runtime dependencies.

**Tech Stack:** TypeScript, esbuild, vitest + jsdom (see CLAUDE.md).

## Global Constraints

- Zero runtime dependencies — every change here is dev-only tooling/test code plus `src/**/*.ts`. Do not add packages.
- `npm run typecheck` and `npm test` must pass after every task.
- No behavior change: every extraction must produce byte-identical DOM/markdown output and identical store mutations to what it replaces. Where a task's fix *is* a behavior change (there are none in this plan — Tasks 8/9 change performance characteristics only, not output), that would be called out explicitly; none are.
- i18n: no new user-visible strings are introduced by this plan, so no new `t()` keys are needed.
- Comments: only where the existing code already carried one explaining non-obvious behavior — carry those comments forward to the new location rather than dropping them.
- Two findings from the original review turned out to be false positives on verification and are **not** in this plan:
  - "`AppController.dispose` (main.ts) is dead code" — it is not. `dispose()` is assigned to `app.dispose` (main.ts:308) and is invoked by `closeFile()` (main.ts:450), which is wired to the real "close file" header button/hotkey (`shell.onCloseFile`, Ctrl+Alt+L). Task 10 below only fixes the stale doc comment that claimed otherwise.
  - The `unsplitStash`/`spaceHideSplit` "flags" in `panes.ts` were reviewed and are legitimate, documented, load-bearing mechanisms, not bandaids — Task 13 makes one of them slightly more explicit as a minor robustness polish, not a bug fix.

---

## File Structure

New files:
- `src/ui/rich-editor.ts` — `createRichEditorBundle()`, the editor+@ref+template-picker bundle five call sites currently hand-assemble (Task 4).
- `src/ui/expandable-followup.ts` — `ExpandableRowsController`, the expand/collapse + bundle-lifecycle bookkeeping `milestones.ts` and `risks.ts` currently duplicate (Task 5).
- `test/rich-editor.test.ts`, `test/expandable-followup.test.ts`, `test/dom.test.ts` — new coverage for the above plus `blurOnEnter`.

Modified files (by task): `src/core/document.ts`, `src/ui/modal.ts`, `src/ui/dom.ts`, `src/ui/card-context-menu.ts`, `src/ui/sidebar.ts`, `src/modules/{action-items,milestones,risks,person-notes,daily-notes,people-tree}.ts`, `src/ui/prefs.ts`, `src/ui/panes.ts`, `src/main.ts`, `src/core/idb.ts`, `src/core/store.ts`.

---

## Task 1: `findTeam(doc, teamId)` helper in `core/document.ts`

Six modules each define an identical local closure `findTeam(): Team | undefined { return ctx.store.doc.teams.find((tm) => tm.id === teamId) }` (or the `daily-notes.ts` module-scoped variant taking `ctx`/`teamId` as params). Add one shared implementation and have every local `findTeam` delegate to it — this dedupes the lookup logic without touching any call site that already calls the local `findTeam()`/`findTeam(ctx, teamId)`.

**Files:**
- Modify: `src/core/document.ts`
- Test: `test/document.test.ts`
- Modify: `src/modules/action-items.ts:90-92`, `src/modules/milestones.ts:161-163`, `src/modules/risks.ts:123-125`, `src/modules/person-notes.ts:31-33`, `src/modules/daily-notes.ts:33-35`, `src/modules/people-tree.ts:139-141`

**Interfaces:**
- Produces: `findTeam(doc: Doc, teamId: string): Team | undefined`, exported from `src/core/document.ts`.

- [ ] **Step 1: Write the failing test**

Add to `test/document.test.ts`:

```ts
import { createEmptyDocument, createEmptyTeam, findTeam } from '../src/core/document'

test('findTeam finds a team by id, undefined when missing', () => {
  const d = createEmptyDocument('en-US')
  d.teams.push(createEmptyTeam('t1', 'Alpha', '🙂', 'en-US'))
  expect(findTeam(d, 't1')?.name).toBe('Alpha')
  expect(findTeam(d, 'nope')).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/document.test.ts`
Expected: FAIL — `findTeam` is not exported from `../src/core/document`.

- [ ] **Step 3: Implement**

In `src/core/document.ts`, add right after `createEmptyTeam`:

```ts
export function findTeam(doc: Doc, teamId: string): Team | undefined {
  return doc.teams.find((tm) => tm.id === teamId)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/document.test.ts`
Expected: PASS

- [ ] **Step 5: Delegate the six local closures**

In each file below, replace the local lookup body so it calls the shared helper (keep the local function's own name/signature — every existing call site in that file keeps working unchanged).

`src/modules/action-items.ts` — add `findTeam as docFindTeam` to the existing `import { SUGGESTED_TAG_NAME_KEYS } from '../core/document'` line (becomes `import { SUGGESTED_TAG_NAME_KEYS, findTeam as docFindTeam } from '../core/document'`), then change lines 90-92:

```ts
  function findTeam(): Team | undefined {
    return docFindTeam(ctx.store.doc, teamId)
  }
```

`src/modules/milestones.ts` — add `import { findTeam as docFindTeam } from '../core/document'`, change lines 161-163 the same way.

`src/modules/risks.ts` — same: add the import, change lines 123-125.

`src/modules/person-notes.ts` — same: add the import, change lines 31-33.

`src/modules/people-tree.ts` — same: add the import, change lines 139-141.

`src/modules/daily-notes.ts` — this one is module-scoped (not a per-render closure), taking `ctx`/`teamId` as params. Add `import { findTeam as docFindTeam } from '../core/document'`, change lines 33-35:

```ts
function findTeam(ctx: ModuleCtx, teamId: string): Team | undefined {
  return docFindTeam(ctx.store.doc, teamId)
}
```

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS (no behavior change — every call site's return value is identical).

- [ ] **Step 7: Commit**

```bash
git add src/core/document.ts test/document.test.ts src/modules/action-items.ts src/modules/milestones.ts src/modules/risks.ts src/modules/person-notes.ts src/modules/people-tree.ts src/modules/daily-notes.ts
git commit -m "refactor: dedupe per-module team lookup into core/document.ts findTeam"
```

---

## Task 2: `confirmDelete()` helper in `ui/modal.ts`

Six call sites build the same delete-confirmation modal shape (message `<p>`, Cancel + confirm button, `showModal`), and three of them additionally guard it behind an "empty content deletes silently, non-empty prompts" check (`requestDelete`). Note one real behavioral difference to preserve: `action-items.ts` renders its confirm button `danger: true`; the other five render it `primary: true`. The new helper takes a `variant` to keep that intact.

**Files:**
- Modify: `src/ui/modal.ts`
- Test: `test/modal.test.ts`
- Modify: `src/modules/action-items.ts:151-171`, `src/modules/milestones.ts:246-266`, `src/modules/risks.ts:170-198`, `src/modules/people-tree.ts:219-237`, `src/ui/sidebar.ts:504-517`, `src/ui/prefs.ts:288-300`

**Interfaces:**
- Produces: `confirmDelete(locale: Locale, opts: { title: string; message: string; confirmLabel: string; variant?: 'danger' | 'primary'; onConfirm: () => void }): void`, exported from `src/ui/modal.ts`.

- [ ] **Step 1: Write the failing test**

Add to `test/modal.test.ts` (check the file's existing imports/setup first and match its DOM-query style):

```ts
import { confirmDelete } from '../src/ui/modal'

test('confirmDelete shows a title/message/confirm button and calls onConfirm', () => {
  const onConfirm = vi.fn()
  confirmDelete('en-US', {
    title: 'Delete X',
    message: 'Are you sure?',
    confirmLabel: 'Delete',
    variant: 'danger',
    onConfirm,
  })
  const dialog = document.querySelector('.tt-modal-dialog')!
  expect(dialog.querySelector('.tt-modal-title')?.textContent).toBe('Delete X')
  expect(dialog.querySelector('.tt-modal-message')?.textContent).toBe('Are you sure?')
  const confirmBtn = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Delete')!
  expect(confirmBtn.className).toContain('tt-btn-danger')
  confirmBtn.click()
  expect(onConfirm).toHaveBeenCalledOnce()
  expect(document.querySelector('.tt-modal-overlay')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/modal.test.ts`
Expected: FAIL — `confirmDelete` is not exported.

- [ ] **Step 3: Implement**

Add to `src/ui/modal.ts`, after `showErrorModal`:

```ts
/**
 * Shared shape for every "confirm before deleting" dialog in the app: a
 * message, Cancel, and a confirm button that closes the dialog either way.
 * `variant` defaults to 'primary' (most callers) — action-items.ts's kanban
 * card delete is the one caller that wants the stronger 'danger' styling.
 */
export function confirmDelete(locale: Locale, opts: {
  title: string
  message: string
  confirmLabel: string
  variant?: 'danger' | 'primary'
  onConfirm: () => void
}): void {
  const body = el('p', { class: 'tt-modal-message' }, opts.message)
  const cancelBtn: ModalButton = { label: t(locale, 'cancel'), onClick: () => handle.close() }
  const confirmBtn: ModalButton = {
    label: opts.confirmLabel,
    danger: opts.variant === 'danger',
    primary: opts.variant !== 'danger',
    onClick: () => {
      opts.onConfirm()
      handle.close()
    },
  }
  const handle: ModalHandle = showModal({ title: opts.title, body, buttons: [cancelBtn, confirmBtn] })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/modal.test.ts`
Expected: PASS

- [ ] **Step 5: Replace the six call sites**

`src/modules/action-items.ts` — delete `openDeleteConfirm` (lines 151-163) entirely, and change `requestDelete` (lines 165-171) to:

```ts
  function requestDelete(item: ActionItem): void {
    if (item.summary.trim() === '') {
      removeItem(item.id) // empty cards carry no meaningful content to lose — delete silently
      return
    }
    confirmDelete(lc, {
      title: t(lc, 'kanban_delete_title'),
      message: t(lc, 'kanban_delete_confirm', { summary: item.summary }),
      confirmLabel: t(lc, 'kanban_delete_btn'),
      variant: 'danger',
      onConfirm: () => removeItem(item.id),
    })
  }
```

Update the import: `import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'` → `import { showModal, confirmDelete, type ModalButton, type ModalHandle } from '../ui/modal'`. (`ModalButton`/`ModalHandle` stay — `clearZone` and `openEditModal` still use `showModal` directly.)

`src/modules/milestones.ts` — delete `openDeleteConfirm` (lines 246-258), change `requestDelete` (lines 260-266):

```ts
  function requestDelete(m: Milestone): void {
    if (m.title.trim() === '') {
      removeMilestone(m.id) // empty titles carry no meaningful content to lose — delete silently
      return
    }
    confirmDelete(lc, {
      title: t(lc, 'milestone_delete_title'),
      message: t(lc, 'milestone_delete_confirm', { title: m.title }),
      confirmLabel: t(lc, 'milestone_delete_btn'),
      onConfirm: () => removeMilestone(m.id),
    })
  }
```

Update its `import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'` to add `confirmDelete`.

`src/modules/risks.ts` — delete `openDeleteConfirm` (lines 170-182), change `requestDelete` (lines 192-198):

```ts
  function requestDelete(r: Risk): void {
    if (r.title.trim() === '') {
      removeRisk(r.id) // empty titles carry no meaningful content to lose — delete silently
      return
    }
    confirmDelete(lc, {
      title: t(lc, 'risk_delete_title'),
      message: t(lc, 'risk_delete_confirm', { title: r.title }),
      confirmLabel: t(lc, 'risk_delete_btn'),
      onConfirm: () => removeRisk(r.id),
    })
  }
```

Update its modal import to add `confirmDelete`.

`src/modules/people-tree.ts` — this one has no empty-content guard (delete is only reachable via an explicit 🗑 button, no auto-silent path). Delete `openDeleteConfirm` (lines 219-237) and replace its one call site (the `deleteBtn` in `renderBox`, line 260: `onclick: (e: Event) => { e.stopPropagation(); openDeleteConfirm(person) }`) with:

```ts
        onclick: (e: Event) => {
          e.stopPropagation()
          confirmDelete(lc, {
            title: t(lc, 'person_delete_title'),
            message: t(lc, 'person_delete_confirm', { name: person.name }),
            confirmLabel: t(lc, 'person_delete_btn'),
            onConfirm: () => {
              ctx.store.update((d) => {
                const tm = d.teams.find((t2) => t2.id === teamId)
                if (!tm) return
                unlinkRefsInTeam(tm, 'person', [person.id])
                tm[group] = deletePerson(tm[group], person.id)
              })
            },
          })
        },
```

Update its `import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'` to add `confirmDelete`.

`src/ui/sidebar.ts` — delete `openDeleteConfirm` (lines 504-517), replace its one call site (`openEditModal`'s `deleteBtn.onClick`, line 476: `openDeleteConfirm(team)`) with a direct `confirmDelete` call:

```ts
    const deleteBtn: ModalButton = {
      label: t(locale(), 'team_delete_btn'),
      onClick: () => {
        picker.dispose()
        handle.close()
        confirmDelete(locale(), {
          title: t(locale(), 'team_delete_title'),
          message: t(locale(), 'team_delete_confirm', { name: team.name }),
          confirmLabel: t(locale(), 'team_delete_btn'),
          onConfirm: () => deleteTeam(team.id),
        })
      },
    }
```

Update the import: `import { showModal, type ModalButton, type ModalHandle } from './modal'` → add `confirmDelete`.

`src/ui/prefs.ts` — delete the local `openDeleteConfirm` inside `renderTemplates` (lines 288-300), replace its one call site (`delBtn.onclick`, line 422: `onclick: () => openDeleteConfirm(tpl)`) with:

```ts
        onclick: () => confirmDelete(locale, {
          title: t(locale, 'prefs_templates_delete_title'),
          message: t(locale, 'prefs_templates_delete_confirm', { name: tpl.name }),
          confirmLabel: t(locale, 'prefs_templates_delete_btn'),
          onConfirm: () => removeTemplate(tpl.id),
        }),
```

Update the import: `import { showModal, showErrorModal, toast, type ModalButton, type ModalHandle } from './modal'` → add `confirmDelete`.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/ui/modal.ts test/modal.test.ts src/modules/action-items.ts src/modules/milestones.ts src/modules/risks.ts src/modules/people-tree.ts src/ui/sidebar.ts src/ui/prefs.ts
git commit -m "refactor: extract confirmDelete modal helper, dedupe 6 call sites"
```

---

## Task 3: `blurOnEnter` moved to `ui/dom.ts`

Identical 3-line function duplicated verbatim in two files.

**Files:**
- Modify: `src/ui/dom.ts`
- Test: `test/dom.test.ts` (new)
- Modify: `src/modules/milestones.ts:32-34,404`, `src/modules/risks.ts:30-32,279`

**Interfaces:**
- Produces: `blurOnEnter(e: Event): void`, exported from `src/ui/dom.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/dom.test.ts`:

```ts
import { blurOnEnter } from '../src/ui/dom'

test('blurOnEnter blurs the target on Enter, ignores other keys', () => {
  const input = document.createElement('input')
  document.body.appendChild(input)
  input.focus()
  expect(document.activeElement).toBe(input)

  blurOnEnter(new KeyboardEvent('keydown', { key: 'a' }))
  expect(document.activeElement).toBe(input) // untouched

  const enterEvent = new KeyboardEvent('keydown', { key: 'Enter' })
  Object.defineProperty(enterEvent, 'target', { value: input })
  blurOnEnter(enterEvent)
  expect(document.activeElement).not.toBe(input)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dom.test.ts`
Expected: FAIL — `blurOnEnter` is not exported from `../src/ui/dom`.

- [ ] **Step 3: Implement**

Add to `src/ui/dom.ts`, after `el()`:

```ts
/** Enter confirms a row's text/date field the same way Tab/click-away already does: blur it, which commits via the field's own `onchange` handler. */
export function blurOnEnter(e: Event): void {
  if ((e as KeyboardEvent).key === 'Enter') (e.target as HTMLElement).blur()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/dom.test.ts`
Expected: PASS

- [ ] **Step 5: Remove the duplicates**

`src/modules/milestones.ts` — delete lines 32-34 (`function blurOnEnter...`), change `import { el } from '../ui/dom'` → `import { el, blurOnEnter } from '../ui/dom'`.

`src/modules/risks.ts` — delete lines 30-32, same import change.

Both files' existing `onkeydown: blurOnEnter` usages (milestones.ts:404, risks.ts:279) are untouched — they now resolve to the imported function.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/ui/dom.ts test/dom.test.ts src/modules/milestones.ts src/modules/risks.ts
git commit -m "refactor: move blurOnEnter into ui/dom.ts, dedupe milestones/risks"
```

---

## Task 4: `createRichEditorBundle()` in new `src/ui/rich-editor.ts`

Five call sites build the identical `createEditor` → `attachAtAutocomplete` → `attachTemplatePicker` sequence (differing only in the `onChange` write target, template scope filter, and template context). Extract one factory; each call site supplies only what's actually different.

**Files:**
- Create: `src/ui/rich-editor.ts`
- Test: `test/rich-editor.test.ts` (new)
- Modify: `src/modules/daily-notes.ts:111-142,160-165`, `src/modules/person-notes.ts:52-84,107-111`, `src/modules/action-items.ts:195-233,199-206`, `src/modules/milestones.ts:174-234`, `src/modules/risks.ts:138-256`

**Interfaces:**
- Produces: `createRichEditorBundle(opts): RichEditorBundle` where `RichEditorBundle = { editor: Editor; dispose(): void }`, exported from `src/ui/rich-editor.ts`.
- Consumes: `Editor`/`createEditor` (`./editor`), `attachAtAutocomplete`/`makeRefClickHandler`/`makeRefLabelResolver` (`./atref`), `attachTemplatePicker` (`./template-picker`), `teamRefCandidates` (`../core/search`), `Store` (`../core/store`), `PaneManager` (`./panes`), `Team`/`Template` (`../core/types`), `TemplateCtx` (`../core/templates`).

- [ ] **Step 1: Write the failing test**

Create `test/rich-editor.test.ts` (check `test/editor.test.ts` and `test/atref.test.ts` first for how `Store`/`PaneManager` test doubles are usually built in this codebase, and match that pattern):

```ts
import { createRichEditorBundle } from '../src/ui/rich-editor'
import { createStore } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'

function fakePm() {
  return { openInPane: vi.fn(), openInFocused: vi.fn(), renderAll: vi.fn() } as any
}

test('createRichEditorBundle wires initial content and forwards onChange', () => {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  doc.teams.push(team)
  const store = createStore(doc)
  const onChange = vi.fn()

  const bundle = createRichEditorBundle({
    store, pm: fakePm(), paneIdx: 0, locale: 'en-US', teamId: 't1',
    initialMd: 'Hello',
    onChange,
    getTeam: () => store.doc.teams[0],
    getTemplates: () => [],
    getTemplateCtx: () => ({ dateIso: '2026-07-24', time: '10:00', locale: 'en-US' }),
  })

  expect(bundle.editor.getMd()).toBe('Hello')
  bundle.dispose()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rich-editor.test.ts`
Expected: FAIL — `src/ui/rich-editor.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/ui/rich-editor.ts`:

```ts
// src/ui/rich-editor.ts — the editor + @ref autocomplete + '/' template picker
// bundle every module that hosts free-text notes wires up identically
// (daily notes, person notes, action-item notes, milestone/risk follow-ups).
// Each caller differs only in where onChange persists and which templates/
// context apply — everything else (ref-click nav, ref-label resolution,
// dropdown wiring, teardown order) is exactly the same across all five.
import type { Locale } from '../core/i18n'
import type { Store } from '../core/store'
import type { PaneManager } from './panes'
import type { Team, Template } from '../core/types'
import type { TemplateCtx } from '../core/templates'
import { teamRefCandidates } from '../core/search'
import { createEditor, type Editor } from './editor'
import { attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver } from './atref'
import { attachTemplatePicker } from './template-picker'

export interface RichEditorBundle {
  editor: Editor
  /** Tears down the @ref dropdown, template-picker dropdown, and the editor itself, in that order. Idempotent-safe to call once per bundle. */
  dispose(): void
}

export function createRichEditorBundle(opts: {
  store: Store
  pm: PaneManager
  paneIdx: 0 | 1
  locale: Locale
  teamId: string
  initialMd: string
  /** No-op for callers (action-items.ts's card modal) that persist via a separate Save button reading editor.getMd() instead of live-writing on every change. */
  onChange(md: string): void
  getTeam(): Team | undefined
  getTemplates(): Template[]
  getTemplateCtx(): TemplateCtx
}): RichEditorBundle {
  const editor: Editor = createEditor(
    {
      onChange() {
        opts.onChange(editor.getMd())
      },
      onRefClick: makeRefClickHandler(opts.store, opts.pm, opts.paneIdx, opts.locale, opts.teamId),
      onAtTrigger() {},
      onSlashTrigger() {},
      resolveRefLabel: makeRefLabelResolver(opts.store, opts.teamId),
    },
    opts.locale
  )
  editor.setMd(opts.initialMd)

  const atHandle = attachAtAutocomplete(editor, {
    getRefCandidates: () => teamRefCandidates(opts.getTeam()),
    locale: opts.locale,
    onPick: () => {},
  })
  const tplHandle = attachTemplatePicker(editor, {
    getTemplates: opts.getTemplates,
    getCtx: opts.getTemplateCtx,
    locale: opts.locale,
  })

  return {
    editor,
    dispose(): void {
      atHandle.dispose()
      tplHandle.dispose()
      editor.destroy()
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/rich-editor.test.ts`
Expected: PASS

- [ ] **Step 5: Adopt in `daily-notes.ts`**

Replace lines 111-142 (the `createEditor`/`attachAtAutocomplete`/`attachTemplatePicker` block) with:

```ts
  const bundle = createRichEditorBundle({
    store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
    initialMd: findTeam(ctx, teamId)?.dailyNotes[date] ?? '',
    onChange: (md) => {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm) return
        if (md.trim() === '') delete tm.dailyNotes[date]
        else tm.dailyNotes[date] = md
      })
    },
    getTeam: () => findTeam(ctx, teamId),
    getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'daily' || tpl.scope === 'any'),
    getTemplateCtx: () => ({ dateIso: date, time: nowHHMM(lc), teamName: findTeam(ctx, teamId)?.name, locale: lc }),
  })
  const editor = bundle.editor
```

Update the rest of the file: `layout` (line ~156) still references `editor.root` — unchanged. Replace `disposers.set` (lines 160-165):

```ts
  disposers.set(container, () => {
    unsubscribe()
    bundle.dispose()
  })
```

Replace the imports at the top: remove `createEditor`/`Editor`/`attachAtAutocomplete`/`makeRefClickHandler`/`makeRefLabelResolver`/`attachTemplatePicker`/`teamRefCandidates` (all now internal to `rich-editor.ts`), add `import { createRichEditorBundle } from '../ui/rich-editor'`.

- [ ] **Step 6: Adopt in `person-notes.ts`**

Replace lines 52-84 with:

```ts
  const bundle = createRichEditorBundle({
    store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
    initialMd: person.notes,
    onChange: (md) => {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        const p = tm?.[group].find((pp) => pp.id === personId)
        if (!p) return
        p.notes = md.trim() === '' ? '' : md
      })
    },
    getTeam: () => findTeam(),
    getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'personal' || tpl.scope === 'any'),
    getTemplateCtx: () => ({ dateIso: todayIso(), time: nowHHMM(lc), personName: person.name, teamName: findTeam()?.name, locale: lc }),
  })
  const editor = bundle.editor
```

The "person deleted out from under this pane" `unsubscribe` block (lines 93-103) references `atHandle`/`tplHandle`/`editor` — update its teardown to `bundle.dispose()` instead of the three individual calls. `disposers.set` (lines 107-112) becomes:

```ts
  disposers.set(container, () => {
    unsubscribe()
    bundle.dispose()
  })
```

Update imports the same way as `daily-notes.ts` (remove the now-unused editor/atref/template-picker imports, add `createRichEditorBundle` from `'../ui/rich-editor'`).

- [ ] **Step 7: Adopt in `action-items.ts`**

This call site keeps its own `datePicker` alongside the bundle. Change the `ModalBundle` interface (line 195) from `{ editor: Editor; atHandle: AtAutocompleteHandle; tplHandle: TemplatePickerHandle; datePicker: DatePickerHandle }` to `{ richBundle: RichEditorBundle; datePicker: DatePickerHandle }`.

Replace `disposeOpenBundle` (lines 199-206):

```ts
  function disposeOpenBundle(): void {
    if (!openBundle) return
    openBundle.richBundle.dispose()
    openBundle.datePicker.destroy()
    openBundle = null
  }
```

Replace the editor construction in `openEditModal` (lines 216-233):

```ts
    const richBundle = createRichEditorBundle({
      store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
      initialMd: existing?.notes ?? '',
      onChange: () => {}, // this modal reads editor.getMd() on Save instead of live-persisting
      getTeam: () => findTeam(),
      getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
      getTemplateCtx: () => ({ dateIso: todayIso(), time: nowHHMM(lc), teamName: findTeam()?.name, locale: lc }),
    })
    const editor = richBundle.editor
    openBundle = { richBundle, datePicker }
```

(`editor` is still referenced further down for `editor.root`, `editor.getMd()` in `save()` — those stay unchanged since `editor` is still bound to that name.)

Update imports: remove `createEditor, type Editor` and `attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver, type AtAutocompleteHandle` and `attachTemplatePicker, type TemplatePickerHandle` and `teamRefCandidates` (from `'../core/search'` — check if `teamRefCandidates` is still used elsewhere in the file; it is not once this is the only call site), add `import { createRichEditorBundle, type RichEditorBundle } from '../ui/rich-editor'`.

- [ ] **Step 8: Adopt in `milestones.ts` and `risks.ts` — deferred to Task 5**

Both files' `renderFollowupRow` also participate in the `ExpandedBundle`/expand-tracking duplication (Task 5). To avoid touching the same lines twice, Task 5's Step 3 does the `createRichEditorBundle` adoption for these two files as part of extracting `ExpandableRowsController`. Do not edit `milestones.ts`/`risks.ts` in this task.

- [ ] **Step 9: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/ui/rich-editor.ts test/rich-editor.test.ts src/modules/daily-notes.ts src/modules/person-notes.ts src/modules/action-items.ts
git commit -m "refactor: extract createRichEditorBundle, dedupe editor+atref+template wiring"
```

---

## Task 5: `ExpandableRowsController` in new `src/ui/expandable-followup.ts`

Depends on Task 4 (`createRichEditorBundle`). `milestones.ts` and `risks.ts` each duplicate: an `ExpandedBundle` interface, an `expandedBundles` map, `disposeExpandedBundle`/`disposeAllExpandedBundles`, `toggleExpand`/`setAllExpanded`/`isAllExpanded`. Extract the bookkeeping; each module keeps its own `renderFollowupRow` (the bundle's `getTeam`/`onChange`/template-scope differ) but builds it via `createRichEditorBundle` and registers it with the shared controller.

**Files:**
- Create: `src/ui/expandable-followup.ts`
- Test: `test/expandable-followup.test.ts` (new)
- Modify: `src/modules/milestones.ts:174-234,470,476-482,485,499-501,505-512,525-531,537-548,554-556`, `src/modules/risks.ts:130-256,463-489,507-524,555-570`

**Interfaces:**
- Produces: `class ExpandableRowsController` with methods `isExpanded(id): boolean`, `register(id, bundle: RichEditorBundle): void`, `toggle(id): void`, `setAll(ids: string[], expand: boolean): void`, `isAllExpanded(ids: string[]): boolean`, `collapse(id): void` (drops from the expanded set without disposing — for rows about to be deleted), `disposeOne(id): void`, `disposeAll(): void`. Exported from `src/ui/expandable-followup.ts`.
- Consumes: `RichEditorBundle` from `../ui/rich-editor` (Task 4).

- [ ] **Step 1: Write the failing test**

Create `test/expandable-followup.test.ts`:

```ts
import { ExpandableRowsController } from '../src/ui/expandable-followup'

function fakeBundle() {
  return { editor: {} as any, dispose: vi.fn() }
}

test('tracks expand state and disposes registered bundles', () => {
  const c = new ExpandableRowsController()
  expect(c.isExpanded('a')).toBe(false)

  c.toggle('a')
  expect(c.isExpanded('a')).toBe(true)
  c.toggle('a')
  expect(c.isExpanded('a')).toBe(false)

  c.setAll(['a', 'b'], true)
  expect(c.isAllExpanded(['a', 'b'])).toBe(true)
  expect(c.isAllExpanded(['a', 'b', 'c'])).toBe(false)

  const bundleA = fakeBundle()
  c.register('a', bundleA)
  c.disposeAll()
  expect(bundleA.dispose).toHaveBeenCalledOnce()

  c.setAll(['a', 'b'], false)
  expect(c.isExpanded('a')).toBe(false)
})

test('collapse drops the id without requiring a registered bundle', () => {
  const c = new ExpandableRowsController()
  c.toggle('x')
  c.collapse('x')
  expect(c.isExpanded('x')).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/expandable-followup.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/ui/expandable-followup.ts`:

```ts
// src/ui/expandable-followup.ts — shared expand/collapse + editor-bundle
// lifecycle bookkeeping for a list of rows where any number can have a rich
// follow-up editor expanded at once (src/modules/milestones.ts and
// src/modules/risks.ts). Rendering the row itself and building its
// RichEditorBundle stays with the caller — this only tracks which ids are
// expanded and disposes their bundles together.
import type { RichEditorBundle } from './rich-editor'

export class ExpandableRowsController {
  private expandedIds = new Set<string>()
  private bundles = new Map<string, RichEditorBundle>()

  isExpanded(id: string): boolean {
    return this.expandedIds.has(id)
  }

  /** Registers `id`'s freshly-built editor bundle so a later dispose call tears it down. Call once per expanded row, right after building its bundle. */
  register(id: string, bundle: RichEditorBundle): void {
    this.bundles.set(id, bundle)
  }

  toggle(id: string): void {
    if (this.expandedIds.has(id)) this.expandedIds.delete(id)
    else this.expandedIds.add(id)
  }

  setAll(ids: string[], expand: boolean): void {
    this.expandedIds = expand ? new Set(ids) : new Set()
  }

  isAllExpanded(ids: string[]): boolean {
    return ids.length > 0 && ids.every((id) => this.expandedIds.has(id))
  }

  /** Drops `id` from the expanded set without disposing its bundle — for a row about to be deleted via store.update anyway, where the next render() rebuilds nothing for it. */
  collapse(id: string): void {
    this.expandedIds.delete(id)
  }

  disposeOne(id: string): void {
    this.bundles.get(id)?.dispose()
    this.bundles.delete(id)
  }

  disposeAll(): void {
    for (const id of [...this.bundles.keys()]) this.disposeOne(id)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/expandable-followup.test.ts`
Expected: PASS

- [ ] **Step 5: Adopt in `milestones.ts`**

Delete the `ExpandedBundle` interface, `expandedBundles` map, and `disposeExpandedBundle`/`disposeAllExpandedBundles` functions (lines 174-188). Replace the `expandedIds` declaration (line 172, `let expandedIds = new Set<string>()`) with:

```ts
  const expandable = new ExpandableRowsController()
```

Replace `toggleExpand` (lines 190-194):

```ts
  function toggleExpand(id: string): void {
    expandable.toggle(id)
    renderAll()
  }
```

Replace `setAllExpanded` (lines 197-200):

```ts
  function setAllExpanded(expand: boolean): void {
    expandable.setAll(milestones().map((m) => m.id), expand)
    renderAll()
  }
```

Replace `renderFollowupRow` (lines 203-234) to build via `createRichEditorBundle` and register with `expandable`:

```ts
  function renderFollowupRow(m: Milestone): HTMLElement {
    const bundle = createRichEditorBundle({
      store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
      initialMd: m.followup,
      onChange: (md) => {
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          const found = tm?.milestones.find((mm) => mm.id === m.id)
          if (!found) return
          found.followup = md.trim() === '' ? '' : md
        })
      },
      getTeam: () => findTeam(),
      getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
      getTemplateCtx: () => ({ dateIso: todayIso(), time: nowHHMM(lc), teamName: findTeam()?.name, locale: lc }),
    })
    expandable.register(m.id, bundle)
    return el('div', { class: 'tt-milestone-followup-row', 'data-milestone-followup-id': m.id }, bundle.editor.root)
  }
```

Update `removeMilestone` (line 237): `expandedIds.delete(id)` → `expandable.collapse(id)`.

Update `renderList`'s `expandedIds.has(m.id)` (line 468) → `expandable.isExpanded(m.id)`.

Update `renderAll` (line 479): `disposeAllExpandedBundles()` → `expandable.disposeAll()`.

Update `isAllExpanded`/`updateExpandAllBtn` (lines 505-511): delete the local `isAllExpanded` function; `updateExpandAllBtn`'s call and the `expandAllBtn.onclick` (line 501, `setAllExpanded(!isAllExpanded(milestones()))`) become `setAllExpanded(!expandable.isAllExpanded(milestones().map((m) => m.id)))`, and `updateExpandAllBtn`'s body uses `expandable.isAllExpanded(sorted.map((m) => m.id))`.

Update `disposers.set` (lines 554-556): `disposeAllExpandedBundles()` → `expandable.disposeAll()`.

Update imports: remove `createEditor, type Editor`, `attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver, type AtAutocompleteHandle`, `attachTemplatePicker, type TemplatePickerHandle`, `teamRefCandidates` (check nothing else in the file needs them — it doesn't); add `import { createRichEditorBundle } from '../ui/rich-editor'` and `import { ExpandableRowsController } from '../ui/expandable-followup'`.

- [ ] **Step 6: Adopt in `risks.ts`**

Same transformation, mirroring `milestones.ts`:

Delete `ExpandedBundle`/`expandedBundles`/`disposeExpandedBundle`/`disposeAllExpandedBundles` (lines 138-152). Replace `expandedIds` (line 135) with `const expandable = new ExpandableRowsController()`.

Replace `toggleExpand` (lines 200-204) and `setAllExpanded` (lines 207-210) the same way as milestones, except `setAllExpanded` filters non-closed risks:

```ts
  function toggleExpand(id: string): void {
    expandable.toggle(id)
    renderAll()
  }

  function setAllExpanded(expand: boolean): void {
    expandable.setAll(risks().filter((r) => !r.closed).map((r) => r.id), expand)
    renderAll()
  }
```

Replace `renderFollowupRow` (lines 225-256):

```ts
  function renderFollowupRow(r: Risk): HTMLElement {
    const bundle = createRichEditorBundle({
      store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
      initialMd: r.followup,
      onChange: (md) => {
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          const found = tm?.risks.find((rr) => rr.id === r.id)
          if (!found) return
          found.followup = md.trim() === '' ? '' : md
        })
      },
      getTeam: () => findTeam(),
      getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
      getTemplateCtx: () => ({ dateIso: todayIso(), time: nowHHMM(lc), teamName: findTeam()?.name, locale: lc }),
    })
    expandable.register(r.id, bundle)
    return el('div', { class: 'tt-risk-followup-row', 'data-risk-followup-id': r.id }, bundle.editor.root)
  }
```

Update `removeRisk` (line 161) and `setClosed` (line 185): `expandedIds.delete(id)` → `expandable.collapse(id)`.

Update `renderRow`'s `const expanded = expandedIds.has(r.id)` (line 330) → `expandable.isExpanded(r.id)`.

Update `renderAll` (line 464): `disposeAllExpandedBundles()` → `expandable.disposeAll()`. Update its `expandedIds.has(r.id)` check (line 474) → `expandable.isExpanded(r.id)`.

Delete the local `isAllExpanded` (lines 517-519); update `expandAllBtn.onclick` (line 512) and `updateExpandAllBtn` (lines 522-523) to call `expandable.isAllExpanded(...)` with the appropriate id list, mirroring milestones.ts.

Update `disposers.set` (lines 567-570): `disposeAllExpandedBundles()` → `expandable.disposeAll()`.

Update imports the same way as `milestones.ts`.

- [ ] **Step 7: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/ui/expandable-followup.ts test/expandable-followup.test.ts src/modules/milestones.ts src/modules/risks.ts
git commit -m "refactor: extract ExpandableRowsController, dedupe milestones/risks followup rows"
```

---

## Task 6: `openItemContextMenu()` generic dispatcher in `ui/card-context-menu.ts`

Three near-identical wrappers around `showCardContextMenu` differ only in which per-kind `duplicate*`/`transfer*` function from `core/card-transfer.ts` they call.

**Files:**
- Modify: `src/ui/card-context-menu.ts`
- Test: `test/card-context-menu.test.ts`
- Modify: `src/modules/action-items.ts:369-383`, `src/modules/milestones.ts:372-386`, `src/modules/risks.ts:258-272`

**Interfaces:**
- Consumes: `ModuleCtx` (`../ui/panes`), `duplicateActionItem`/`transferActionItem`/`duplicateMilestone`/`transferMilestone`/`duplicateRisk`/`transferRisk` (`../core/card-transfer`).
- Produces: `type CardKind = 'action' | 'milestone' | 'risk'` and `openItemContextMenu(ctx: ModuleCtx, kind: CardKind, teamId: string, itemId: string, x: number, y: number): void`, exported from `src/ui/card-context-menu.ts`.

- [ ] **Step 1: Write the failing test**

Check `test/card-context-menu.test.ts`'s existing style first (how it builds a fake `ModuleCtx`/`Store`), then add:

```ts
import { openItemContextMenu } from '../src/ui/card-context-menu'
import { createStore } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'

test('openItemContextMenu dispatches duplicate to the right kind', () => {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  team.actionItems.push({ id: 'a1', summary: 'X', notes: '', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 })
  doc.teams.push(team)
  const store = createStore(doc)
  const ctx = { store, locale: 'en-US' } as any // extend with pm/paneIdx if ModuleCtx requires them for this path

  openItemContextMenu(ctx, 'action', 't1', 'a1', 10, 10)
  const menuItem = Array.from(document.querySelectorAll('.tt-context-menu-item')).find((n) => n.textContent === document.querySelector('.tt-context-menu-item')?.textContent)
  menuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(store.doc.teams[0]!.actionItems.length).toBe(2)
})
```

(Adjust the DOM selector/click simulation to match however `test/context-menu.test.ts` already drives `showContextMenu` — reuse that pattern rather than guessing new selector names.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/card-context-menu.test.ts`
Expected: FAIL — `openItemContextMenu` is not exported.

- [ ] **Step 3: Implement**

Add to `src/ui/card-context-menu.ts`:

```ts
import type { ModuleCtx } from './panes'
import {
  duplicateActionItem, transferActionItem,
  duplicateMilestone, transferMilestone,
  duplicateRisk, transferRisk,
} from '../core/card-transfer'

export type CardKind = 'action' | 'milestone' | 'risk'

const DUPLICATE_FNS: Record<CardKind, (team: Team, itemId: string) => void> = {
  action: duplicateActionItem,
  milestone: duplicateMilestone,
  risk: duplicateRisk,
}

const TRANSFER_FNS: Record<CardKind, (teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move') => void> = {
  action: transferActionItem,
  milestone: transferMilestone,
  risk: transferRisk,
}

/** Wires showCardContextMenu's duplicate/transfer callbacks to the right per-kind core/card-transfer.ts function, so action-items.ts/milestones.ts/risks.ts don't each hand-roll the same store.update wrapper. */
export function openItemContextMenu(ctx: ModuleCtx, kind: CardKind, teamId: string, itemId: string, x: number, y: number): void {
  showCardContextMenu(ctx.locale, teamId, ctx.store.doc.teams, itemId, x, y, {
    duplicate: (id) => {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (tm) DUPLICATE_FNS[kind](tm, id)
      })
    },
    transfer: (id, targetTeamId, mode) => {
      ctx.store.update((d) => {
        TRANSFER_FNS[kind](d.teams, id, teamId, targetTeamId, mode)
      })
    },
  })
}
```

(`Team` is already imported in this file; confirm `ModuleCtx`'s actual shape in `src/ui/panes.ts` before wiring — it must expose `.store` and `.locale`, matching what the three call sites currently use.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/card-context-menu.test.ts`
Expected: PASS

- [ ] **Step 5: Adopt in the three modules**

`src/modules/action-items.ts` — replace `openCardContextMenu` (lines 369-383):

```ts
  function openCardContextMenu(itemId: string, x: number, y: number): void {
    openItemContextMenu(ctx, 'action', teamId, itemId, x, y)
  }
```

Update import: `import { showCardContextMenu } from '../ui/card-context-menu'` → `import { openItemContextMenu } from '../ui/card-context-menu'`. Remove the now-unused `duplicateActionItem, transferActionItem` import from `'../core/card-transfer'` if nothing else in the file uses them (it doesn't).

`src/modules/milestones.ts` — replace `openRowContextMenu` (lines 372-386):

```ts
  function openRowContextMenu(itemId: string, x: number, y: number): void {
    openItemContextMenu(ctx, 'milestone', teamId, itemId, x, y)
  }
```

Same import updates (remove `duplicateMilestone, transferMilestone` from `../core/card-transfer` if unused elsewhere).

`src/modules/risks.ts` — replace `openRowContextMenu` (lines 258-272), same pattern with `'risk'`, remove now-unused `duplicateRisk, transferRisk` import.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/ui/card-context-menu.ts test/card-context-menu.test.ts src/modules/action-items.ts src/modules/milestones.ts src/modules/risks.ts
git commit -m "refactor: generic openItemContextMenu dispatcher, dedupe 3 wrappers"
```

---

## Task 7: `buildTeamForm()` helper in `ui/sidebar.ts`

`openAddModal` and `openEditModal` build the same name/emoji input pair + error element + emoji-picker attach, and each button handler repeats `picker.dispose()`. `ModalOptions.onClose` (already in `ui/modal.ts`) fires exactly once regardless of how the dialog closes — use it to centralize the dispose instead of repeating it per button.

**Files:**
- Modify: `src/ui/sidebar.ts:410-502`
- Test: `test/sidebar.test.ts`

**Interfaces:**
- Consumes: `attachEmojiPicker`/`EmojiPickerHandle` (`./emoji-picker`), `el` (`./dom`).
- Produces (module-private, not exported): `buildTeamForm(initial?: { name: string; emoji: string }): { nameInput: HTMLInputElement; emojiInput: HTMLInputElement; errorEl: HTMLElement; body: HTMLElement; picker: EmojiPickerHandle }`.

- [ ] **Step 1: Write the failing test**

This is a private refactor inside an existing exported function (`mountSidebar`); there's no new public surface to unit-test directly. Instead, extend `test/sidebar.test.ts`'s existing "add team" and "edit team" modal tests (find them first) to also assert the emoji picker is disposed after Cancel — e.g.:

```ts
test('canceling the add-team modal disposes the emoji picker (no leaked listener)', () => {
  // ...use the existing harness in this file to open the add-team modal...
  const emojiInput = document.querySelector<HTMLInputElement>('input[name="tt-team-emoji"]')!
  document.querySelector<HTMLButtonElement>('.tt-modal-buttons button')!.click() // Cancel is the first button
  // Typing into the (now-unmounted) input must not throw or reopen a picker dropdown:
  emojiInput.value = '😀'
  emojiInput.dispatchEvent(new Event('input'))
  expect(document.querySelector('.tt-emoji-picker-dropdown')).toBeNull()
})
```

(Match this to whatever selector `test/emoji-picker.test.ts` already uses for the picker's dropdown element — reuse that constant/selector instead of guessing.)

- [ ] **Step 2: Run test to verify it fails or passes accidentally**

Run: `npx vitest run test/sidebar.test.ts`
This test should already PASS against current code (Cancel already calls `picker.dispose()`) — it's a regression guard, not a red/green driver for this refactor. Confirm it passes now, then proceed; re-run after Step 3 to confirm it still passes.

- [ ] **Step 3: Implement**

Add to `src/ui/sidebar.ts`, before `openAddModal`:

```ts
  function buildTeamForm(initial?: { name: string; emoji: string }): {
    nameInput: HTMLInputElement
    emojiInput: HTMLInputElement
    errorEl: HTMLElement
    body: HTMLElement
    picker: ReturnType<typeof attachEmojiPicker>
  } {
    const nameInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-team-name', value: initial?.name ?? '' }) as HTMLInputElement
    // No maxlength: it counts UTF-16 code units, which both lets two simple
    // emojis through and blocks single ZWJ emojis — attachEmojiPicker
    // enforces "exactly one grapheme" on input instead.
    const emojiInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-team-emoji', value: initial?.emoji ?? '' }) as HTMLInputElement
    const errorEl = el('div', { class: 'tt-field-error' })
    const body = el(
      'div',
      { class: 'tt-team-form' },
      el('label', { class: 'tt-field' }, t(locale(), 'team_name_label'), nameInput),
      el('label', { class: 'tt-field' }, t(locale(), 'team_emoji_label'), emojiInput),
      errorEl
    )
    const picker = attachEmojiPicker(emojiInput, locale())
    return { nameInput, emojiInput, errorEl, body, picker }
  }
```

Replace `openAddModal` (lines 410-452):

```ts
  function openAddModal(): void {
    const { nameInput, emojiInput, errorEl, body, picker } = buildTeamForm()

    const cancelBtn: ModalButton = { label: t(locale(), 'cancel'), onClick: () => handle.close() }
    const okBtn: ModalButton = {
      label: t(locale(), 'ok'),
      primary: true,
      onClick: () => {
        const name = nameInput.value.trim()
        if (!name) {
          errorEl.textContent = t(locale(), 'team_name_required')
          return
        }
        const emoji = emojiInput.value.trim()
        if (!emoji) {
          errorEl.textContent = t(locale(), 'team_emoji_required')
          return
        }
        const newTeamId = crypto.randomUUID()
        store.update((d) => {
          d.teams.push(createEmptyTeam(newTeamId, name, emoji, locale()))
        })
        handle.close()
        actions.selectTeam(newTeamId)
      },
    }
    const handle: ModalHandle = showModal({
      title: t(locale(), 'team_add_title'), body, buttons: [cancelBtn, okBtn],
      onClose: () => picker.dispose(),
    })
    nameInput.focus()
  }
```

Replace `openEditModal` (lines 454-502):

```ts
  function openEditModal(team: Team): void {
    const { nameInput, emojiInput, errorEl, body, picker } = buildTeamForm({ name: team.name, emoji: team.emoji })

    const cancelBtn: ModalButton = { label: t(locale(), 'cancel'), onClick: () => handle.close() }
    const deleteBtn: ModalButton = {
      label: t(locale(), 'team_delete_btn'),
      onClick: () => {
        handle.close()
        confirmDelete(locale(), {
          title: t(locale(), 'team_delete_title'),
          message: t(locale(), 'team_delete_confirm', { name: team.name }),
          confirmLabel: t(locale(), 'team_delete_btn'),
          onConfirm: () => deleteTeam(team.id),
        })
      },
    }
    const saveBtn: ModalButton = {
      label: t(locale(), 'ok'),
      primary: true,
      onClick: () => {
        const name = nameInput.value.trim()
        if (!name) {
          errorEl.textContent = t(locale(), 'team_name_required')
          return
        }
        const emoji = emojiInput.value.trim() || team.emoji
        store.update((d) => {
          const target = d.teams.find((tm) => tm.id === team.id)
          if (target) {
            target.name = name
            target.emoji = emoji
          }
        })
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({
      title: t(locale(), 'team_edit_title'), body, buttons: [cancelBtn, deleteBtn, saveBtn],
      onClose: () => picker.dispose(),
    })
    nameInput.focus()
  }
```

(Note: `openEditModal` now calls `confirmDelete` directly instead of its own removed `openDeleteConfirm` — this folds in Task 2's Step 5 sidebar.ts edit. If Task 2 already ran, skip re-adding `openDeleteConfirm`'s removal here and just verify the `confirmDelete` import from `./modal` is present.)

- [ ] **Step 4: Run the test again**

Run: `npx vitest run test/sidebar.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ui/sidebar.ts test/sidebar.test.ts
git commit -m "refactor: extract buildTeamForm helper, centralize emoji-picker dispose via onClose"
```

---

## Task 8: Calendar marks — single-pass instead of per-day-cell filtering

`daily-notes.ts`'s `buildMarks()` returns three functions that each `.filter()` the team's full `milestones`/`actionItems` arrays (plus a `findTeam` lookup) — and `calendar.ts`'s `render()` calls all three once per visible day cell (up to ~31 times/month). This is O(days × items); precomputing per-date maps once makes it O(items + days).

**Files:**
- Modify: `src/modules/daily-notes.ts:48-61`
- Test: `test/daily-notes.test.ts`, `test/calendar.test.ts` (existing — no new tests needed, this is a pure internal perf change with an unchanged external contract)

**Interfaces:**
- No change to `CalendarMarks` (`../ui/calendar`) — `hasNote`/`milestones`/`actionItems` keep the exact same signatures and return values, just computed differently.

- [ ] **Step 1: Confirm existing coverage locks in current behavior**

Run: `npx vitest run test/daily-notes.test.ts test/calendar.test.ts`
Expected: PASS (baseline — these already assert calendar day cells show the 🚩/✅ marks and the has-note tint; re-run after Step 2 to confirm no regression).

- [ ] **Step 2: Implement**

Replace `buildMarks` in `src/modules/daily-notes.ts` (lines 48-61):

```ts
  function buildMarks(): CalendarMarks {
    const team = findTeam(ctx, teamId)
    const milestonesByDate = new Map<string, string[]>()
    for (const m of team?.milestones ?? []) {
      const list = milestonesByDate.get(m.date)
      if (list) list.push(m.title)
      else milestonesByDate.set(m.date, [m.title])
    }
    const actionItemsByDate = new Map<string, string[]>()
    for (const a of team?.actionItems ?? []) {
      if (a.dueDate === null) continue
      const list = actionItemsByDate.get(a.dueDate)
      if (list) list.push(a.summary)
      else actionItemsByDate.set(a.dueDate, [a.summary])
    }
    const dailyNotes = team?.dailyNotes ?? {}
    return {
      hasNote(d: string): boolean {
        const note = dailyNotes[d]
        return typeof note === 'string' && note.trim() !== ''
      },
      milestones(d: string): string[] {
        return milestonesByDate.get(d) ?? []
      },
      actionItems(d: string): string[] {
        return actionItemsByDate.get(d) ?? []
      },
    }
  }
```

- [ ] **Step 3: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS — identical output, just computed once per `buildMarks()` call instead of per day cell.

- [ ] **Step 4: Commit**

```bash
git add src/modules/daily-notes.ts
git commit -m "perf: precompute calendar marks in one pass instead of per-day-cell filtering"
```

---

## Task 9: `idb.ts` — reuse the IndexedDB connection instead of open/close per call

`withStore()` calls `openDb()` (a fresh `indexedDB.open` handshake) and `db.close()` on every single `idbGet`/`idbSet`/`idbDel` call. Cache the open connection for the page's lifetime instead.

**Files:**
- Modify: `src/core/idb.ts`

**Interfaces:** unchanged — `idbGet`/`idbSet`/`idbDel` keep identical signatures and behavior.

- [ ] **Step 1: Note on testing**

`idb.ts` has no existing test file and jsdom (this project's test environment) does not implement `indexedDB` natively; there's no `fake-indexeddb` dev dependency in this repo to add one without a separate decision (it would be a new dev dependency — allowed under "zero *runtime* deps," but out of scope for this cleanup unless requested). This task proceeds as a direct code change verified by `npm run typecheck` plus the existing full suite (which exercises `idb.ts`'s callers indirectly through `fs.test.ts`'s mocked handle-persistence paths — confirm those still pass) and a manual smoke check in a real browser (open the app, reload, confirm the file-handle "recent file" behavior that depends on `idbGet`/`idbSet` still works).

- [ ] **Step 2: Implement**

Replace `src/core/idb.ts`:

```ts
// Minimal IndexedDB helper — no libs. Single object store 'kv' used as a key/value map.

const DB_NAME = 'team-tracker'
const DB_VERSION = 1
const STORE_NAME = 'kv'

// Cached across calls — opening a fresh connection (and closing it) on every
// get/set/del was a full IndexedDB handshake per call for no benefit; a
// single connection lives for the page's lifetime instead.
let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbPromise = null // a failed open must not poison future calls with a rejected cache entry
      reject(req.error ?? new Error('IndexedDB open request failed'))
    }
  })
  return dbPromise
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode)
    const store = tx.objectStore(STORE_NAME)
    const req = fn(store)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  await withStore('readwrite', (store) => store.put(value, key))
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const result = await withStore<T | undefined>('readonly', (store) => store.get(key))
  return result
}

export async function idbDel(key: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(key))
}
```

- [ ] **Step 3: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/idb.ts
git commit -m "perf: reuse cached IndexedDB connection instead of open/close per call"
```

---

## Task 10: `main.ts` — register missing disposers, fix stale dead-code comment

Two registrations (`store.subscribe` for autosave re-arm, `store.onMutate` for search-highlight clearing) aren't added to the `disposers` array unlike their siblings — harmless today (single-document lifetime) but inconsistent, and would leak if `closeFile()`'s `dispose()` (see below) is ever exercised twice in one tab session. Separately, `AppController.dispose`'s doc comment claims "Nothing calls this today" — verified false: `app.dispose` (main.ts:308) is invoked by `closeFile()` (main.ts:450), wired to the real "close file" feature (`shell.onCloseFile`, Ctrl+Alt+L). Fix the comment; do not remove the function.

**Files:**
- Modify: `src/main.ts:43-61,213-215,326-332,430`

- [ ] **Step 1: Fix the stale comment**

Replace the `dispose(): void` doc comment in the `AppController` interface (lines 50-59):

```ts
  /**
   * Task 25 re-review item #4c: tears down the document/window listeners
   * `onDocumentOpened` registers (Ctrl+S keydown, visibilitychange,
   * beforeunload) plus the save controller's own interval/mutation-guard
   * teardown. Invoked by `closeFile()` below (the 🔒 header button /
   * Ctrl+Alt+L) before returning to the start screen — every listener this
   * function tears down must actually be pushed onto `disposers` (see the two
   * registrations fixed alongside this comment) or it leaks across a
   * close-file → open-another-file cycle in the same tab.
   */
  dispose(): void
```

- [ ] **Step 2: Register the autosave-re-arm subscription**

Change lines 326-332 from:

```ts
  let lastAutoSaveMin = store.doc.prefs.autoSaveMin
  store.subscribe(() => {
    if (store.doc.prefs.autoSaveMin !== lastAutoSaveMin) {
      lastAutoSaveMin = store.doc.prefs.autoSaveMin
      saveCtl.scheduleFrom(store.doc.prefs)
    }
  })
```

to:

```ts
  let lastAutoSaveMin = store.doc.prefs.autoSaveMin
  disposers.push(
    store.subscribe(() => {
      if (store.doc.prefs.autoSaveMin !== lastAutoSaveMin) {
        lastAutoSaveMin = store.doc.prefs.autoSaveMin
        saveCtl.scheduleFrom(store.doc.prefs)
      }
    })
  )
```

- [ ] **Step 3: Register the search-highlight-clear mutation listener**

Change line 430 from:

```ts
  store.onMutate(() => clearSearchHighlight())
```

to:

```ts
  disposers.push(store.onMutate(() => clearSearchHighlight()))
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "fix: register missing store listeners in disposers, correct stale dispose() comment"
```

---

## Task 11: Sidebar — replace hand-rolled `NAV_CHANGED_EVENT` with `store.onMutate()`

`sidebar.ts` dispatches a custom DOM event (`notifyNavChanged()`) from 14 call sites across `main.ts`, `prefs.ts`, `panes.ts`, and `sidebar.ts` itself, every single one immediately after a `store.updateNav()`/`store.update()` call — this is exactly what `store.onMutate()` was already built to generalize (see `save-controller.ts`'s own doc comment on why it replaced this same "call-site convention" pattern for the dirty-guard). Verified: the exported `onNavChanged()` subscribe function has **zero** external callers — `sidebar.ts`'s own `document.addEventListener(NAV_CHANGED_EVENT, render)` is the only consumer of the whole mechanism. `LOCALE_CHANGED_EVENT` is intentionally left untouched — unlike nav, it needs a narrower signal than "any mutation" (a `pm.renderAll()` on every keystroke would be a real perf regression), so it stays.

**Files:**
- Modify: `src/ui/sidebar.ts:41-63,113,324,520-525`, `src/main.ts:9,279,476`, `src/ui/prefs.ts:14,178,679`, `src/ui/panes.ts:10,168,208,307,366,390,407,466`

**Interfaces:** removes `notifyNavChanged`/`onNavChanged`/`NAV_CHANGED_EVENT` from `ui/sidebar.ts`'s public surface. `ADD_TEAM_REQUEST_EVENT` is untouched (it's a request, not a state-change notification — different shape, stays as-is).

- [ ] **Step 1: Confirm the invariant before deleting anything**

Run: `npx vitest run test/sidebar.test.ts test/panes.test.ts test/prefs.test.ts`
Expected: PASS (baseline). For each of the 14 `notifyNavChanged()` call sites listed above, confirm by inspection that it is immediately preceded (same function, no intervening early return) by a `store.updateNav(...)` or `store.update(...)` call — this is the precondition that makes replacing the whole mechanism with `store.onMutate()` behavior-preserving. (Already spot-checked for `panes.ts:168` and `panes.ts:208` while writing this plan — both hold.)

- [ ] **Step 2: Collapse sidebar's own dual registration into one `onMutate` subscription**

In `src/ui/sidebar.ts`, replace lines 520-525:

```ts
  render()
  store.subscribe(() => {
    dueCache = null // content changed — due data may have too
    render()
  })
  document.addEventListener(NAV_CHANGED_EVENT, render)
  document.addEventListener(ADD_TEAM_REQUEST_EVENT, () => openAddModal())
```

with:

```ts
  render()
  store.subscribe(() => {
    dueCache = null // content changed — due data may have too
    render()
  })
  // Nav-only changes (store.updateNav — team switch, Alt+1..9, pane history)
  // don't fire subscribe() above, but do need the active-team highlight to
  // update. onMutate() fires on both update() and updateNav(); re-running
  // render() an extra time on a content change (already covered by
  // subscribe() above) is a harmless idempotent DOM rebuild — cheaper than
  // hand-rolling a second nav-only event channel, and it's exactly the
  // "generalize the mechanism" fix core/save-controller.ts already made for
  // its own dirty-guard (see that file's comment on onMutate()). Content
  // changes must NOT reset dueCache here too, or every pane navigation would
  // force a full due-items rescan for no reason — that stays only in the
  // subscribe() callback above.
  store.onMutate(() => render())
  document.addEventListener(ADD_TEAM_REQUEST_EVENT, () => openAddModal())
```

- [ ] **Step 3: Delete the `NAV_CHANGED_EVENT` mechanism**

In `src/ui/sidebar.ts`, delete lines 31-63 (the `NAV_CHANGED_EVENT` constant, `notifyNavChanged()`, and `onNavChanged()` — everything from the `/** Store.updateNav()...` comment through the end of the `onNavChanged` function). Delete the two remaining internal calls: `toggleCollapsed()`'s `notifyNavChanged()` (line 113) and `deleteTeam()`'s `notifyNavChanged()` (line 324) — both already run inside/after a `store.update`/`store.updateNav` call that `onMutate` now covers, so just remove the line (keep `deleteTeam`'s explanatory comment above it if it still reads sensibly standalone — reword to drop the "reuse the nav-changed event's existing save hook" framing since that hook is now `onMutate` directly, not a named event).

- [ ] **Step 4: Remove the now-dead import/call sites in the four other files**

`src/main.ts` — line 9: `import { mountSidebar, notifyNavChanged } from './ui/sidebar'` → `import { mountSidebar } from './ui/sidebar'`. Delete the `notifyNavChanged()` calls at lines 279 and 476 (each sits right after a `store.updateNav`/`store.update` call — deleting just that one line is correct; leave everything else in those functions untouched).

`src/ui/prefs.ts` — line 14: `import { notifyNavChanged } from './sidebar'` → delete this import entirely (prefs.ts has no other use of it). Delete the `notifyNavChanged()` calls at lines 178 and 679. Line 820's `onClose: () => notifyNavChanged()` on the prefs modal itself: since `onClose` fires once when the whole prefs dialog closes and nothing in that specific spot is paired with a preceding store mutation (it's the dialog's own teardown hook, not a post-mutation call), replace it with a direct call to `saveCtl`'s trigger... — on inspection, this one exists purely to fire the "did anything change, maybe save" signal main.ts's (now-removed) `onNavChanged` listener used to catch. Since that listener no longer exists once Step 5 runs, delete `onClose: () => notifyNavChanged(),` from this `showModal` call entirely (the `,` before it stays if there are other options after — check the exact object literal) — any actual mutations made while the prefs modal was open already went through `store.update`, which already triggers the normal save path independent of this hook.

`src/ui/panes.ts` — line 10: `import { notifyNavChanged, ADD_TEAM_REQUEST_EVENT } from './sidebar'` → `import { ADD_TEAM_REQUEST_EVENT } from './sidebar'`. Delete the `notifyNavChanged()` calls at lines 168, 208, 307, 366, 390, 407, 466 (same rule: each sits right after a store mutation in its own function; delete just that line).

- [ ] **Step 5: Update `save-controller.ts`'s comment cross-reference**

`src/core/save-controller.ts`'s comment (around line 73) says `notifyNavChanged() → a nav listener that calls saveNow()` as an example of the old fragile pattern it replaced. That listener (`main.ts`'s old `onNavChanged` subscription) no longer exists after this task — leave the comment's historical framing (it's explaining *why* `onMutate()` exists, which is still true and still the right explanation) but you may append a short note that the pattern it describes has since been fully removed (Task 11), not just worked around, if you want the comment to stay accurate going forward. This is optional polish, not required for correctness.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS. Then manually smoke-test in a real browser (build with `npm run build`, open `dist/app.html`): sidebar active-team highlight updates on Alt+1..9 team switch, on team-picker click, and after deleting a team; locale switch still re-renders pane headers (unaffected — `LOCALE_CHANGED_EVENT` untouched).

- [ ] **Step 7: Commit**

```bash
git add src/ui/sidebar.ts src/main.ts src/ui/prefs.ts src/ui/panes.ts src/core/save-controller.ts
git commit -m "refactor: replace hand-rolled NAV_CHANGED_EVENT with store.onMutate()"
```

---

## Task 12 (optional, low priority): Collapse `store.ts`'s three read-only flags into one state

`readOnly`/`blockedWarned`/`silentReadOnly` in `src/core/store.ts` are three separate closure variables coordinating one "read-only session" concept. The illegal combination (`silentReadOnly && !readOnly`) is currently prevented only by discipline in `setReadOnly` (line 132-136), not by the type. This is polish, not a bug — ship it only if the earlier tasks land cleanly and there's appetite for touching a concurrency-sensitive file.

**Files:**
- Modify: `src/core/store.ts:56-141`
- Test: `test/store.test.ts`

**Interfaces:** `Store`'s public shape (`readOnly` getter, `setReadOnly(readOnly, opts?)`, `onBlockedUpdate`) is unchanged — this only refactors the private implementation.

- [ ] **Step 1: Read existing `test/store.test.ts` read-only coverage first**

Run: `npx vitest run test/store.test.ts` to confirm current passing baseline, and read the file's existing `setReadOnly`/`onBlockedUpdate` tests so the refactor doesn't need new tests — the existing ones (asserting `update()` is blocked while read-only, `onBlockedUpdate` fires once per session, `silent` suppresses it) already pin the exact behavior this task must preserve byte-for-byte.

- [ ] **Step 2: Implement**

Replace the three variables (lines 59-61) and the four places that touch them (`warnBlocked`, `update`, `setReadOnly`, and the `readOnly` getter) with one internal state:

```ts
type ReadOnlyState =
  | { kind: 'writable' }
  | { kind: 'blocked'; warned: boolean }
  | { kind: 'blocked-silent' }
```

```ts
export function createStore(initialDoc: Doc): Store {
  let doc = initialDoc
  let dirty = false
  let roState: ReadOnlyState = { kind: 'writable' }
  const subscribers = new Set<() => void>()
  const mutationListeners = new Set<() => void>()
  const dirtyCallbacks = new Set<(dirty: boolean) => void>()
  const blockedCallbacks = new Set<() => void>()

  const setDirty = (newDirty: boolean) => {
    if (newDirty !== dirty) {
      dirty = newDirty
      for (const fn of Array.from(dirtyCallbacks)) { try { fn(newDirty) } catch (e) { console.error(e) } }
    }
  }

  const notifyMutate = () => {
    for (const fn of Array.from(mutationListeners)) { try { fn() } catch (e) { console.error(e) } }
  }

  const warnBlocked = () => {
    if (roState.kind !== 'blocked' || roState.warned) return
    roState = { kind: 'blocked', warned: true }
    for (const fn of Array.from(blockedCallbacks)) { try { fn() } catch (e) { console.error(e) } }
  }

  return {
    get doc() {
      return doc
    },
    get dirty() {
      return dirty
    },
    get readOnly() {
      return roState.kind !== 'writable'
    },
    update(fn: (d: Doc) => void): void {
      if (roState.kind !== 'writable') {
        warnBlocked()
        return
      }
      fn(doc)
      setDirty(true)
      for (const fn of Array.from(subscribers)) { try { fn() } catch (e) { console.error(e) } }
      notifyMutate()
    },
    updateNav(fn: (d: Doc) => void): void {
      fn(doc)
      setDirty(true)
      notifyMutate()
    },
    subscribe(fn: () => void): () => void {
      subscribers.add(fn)
      return () => { subscribers.delete(fn) }
    },
    onMutate(fn: () => void): () => void {
      mutationListeners.add(fn)
      return () => { mutationListeners.delete(fn) }
    },
    onDirty(fn: (dirty: boolean) => void): void {
      dirtyCallbacks.add(fn)
    },
    markSaved(): void {
      setDirty(false)
    },
    replaceDoc(newDoc: Doc): void {
      doc = newDoc
      setDirty(false)
      for (const fn of Array.from(subscribers)) { try { fn() } catch (e) { console.error(e) } }
    },
    setReadOnly(ro: boolean, opts?: { silent?: boolean }): void {
      if (!ro) {
        roState = { kind: 'writable' }
      } else if (opts?.silent) {
        roState = { kind: 'blocked-silent' }
      } else {
        roState = { kind: 'blocked', warned: false }
      }
    },
    onBlockedUpdate(fn: () => void): void {
      blockedCallbacks.add(fn)
    },
  }
}
```

- [ ] **Step 3: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS — every observable behavior (getter values, when `onBlockedUpdate` fires, silent suppression) is identical to the three-flag version; only the internal representation changed.

- [ ] **Step 4: Commit**

```bash
git add src/core/store.ts
git commit -m "refactor: collapse store.ts's three read-only flags into one tagged state"
```

---

## Task 13 (optional, low priority): Make `panes.ts`'s `unsplitStash` validity explicit

`unsplitStash`'s "is this still valid" check currently relies on `d.nav.panes[0] === d.nav.panes[1]` object-reference equality (see the extensive comment at `panes.ts:415-426`) — correct today because `store.updateNav` mutates in place, but implicit. This was reviewed and judged a legitimate, documented mechanism, not a bandaid — this task only makes the validity check explicit instead of relying on incidental identity, as cheap insurance against a future `store.updateNav` implementation change silently breaking it.

**Files:**
- Modify: `src/ui/panes.ts:415-426,436-464`
- Test: `test/panes.test.ts`

- [ ] **Step 1: Confirm existing coverage**

Run: `npx vitest run test/panes.test.ts`
Find and note the existing split/unsplit/re-split test(s) that exercise `toggleSplit` twice in a row (unsplit then re-split) — that's the behavior this task must not change.

- [ ] **Step 2: Implement**

Add an explicit validity flag alongside the stash, replacing the identity check. Change line 426 from:

```ts
  let unsplitStash: PaneState | null = null
```

to:

```ts
  let unsplitStash: PaneState | null = null
  // Explicit instead of relying on `d.nav.panes[0] === d.nav.panes[1]`
  // object-identity (which happens to hold because store.updateNav mutates
  // in place) — any real navigation while unsplit invalidates the stash.
  let unsplitStashValid = false
```

Change `toggleSplit`'s body (lines 449-460) from:

```ts
      if (!d.nav.split) {
        if (d.nav.focusedPane === 1) {
          unsplitStash = d.nav.panes[0]
          d.nav.panes[0] = d.nav.panes[1]
        } else {
          unsplitStash = null
        }
        d.nav.focusedPane = 0
      } else if (unsplitStash && d.nav.panes[0] === d.nav.panes[1]) {
        d.nav.panes[0] = unsplitStash
        unsplitStash = null
      }
```

to:

```ts
      if (!d.nav.split) {
        if (d.nav.focusedPane === 1) {
          unsplitStash = d.nav.panes[0]
          unsplitStashValid = true
          d.nav.panes[0] = d.nav.panes[1]
        } else {
          unsplitStash = null
          unsplitStashValid = false
        }
        d.nav.focusedPane = 0
      } else if (unsplitStashValid && unsplitStash) {
        d.nav.panes[0] = unsplitStash
        unsplitStash = null
        unsplitStashValid = false
      }
```

- [ ] **Step 3: Invalidate the stash on real navigation while unsplit**

Every function that replaces `d.nav.panes[0]` while unsplit (a real navigation, as opposed to the re-split restore above) must clear `unsplitStashValid` — otherwise a stale stash could be restored after the user has already navigated away from it. Search `src/ui/panes.ts` for every other assignment to `d.nav.panes[0]` (`openInPane`, `stepPaneHistory`'s call site, team-switch restore, etc.) and add `unsplitStashValid = false` alongside each one that isn't the re-split branch just changed above. Cross-check each one against the existing comment block at (former) lines 415-426 for the exact set of "real navigation always replaces pane 0" call sites it already enumerates — that list is the authoritative set to update.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS — unsplit → re-split still restores the stash; unsplit → navigate → re-split no longer restores stale content (same as before, now enforced explicitly instead of incidentally).

- [ ] **Step 5: Commit**

```bash
git add src/ui/panes.ts
git commit -m "refactor: make unsplitStash validity explicit instead of relying on object identity"
```

---

## Self-Review Notes

- **Coverage:** all 13 actionable findings from the review map 1:1 onto Tasks 1-13 (Task 2 covers both the delete-confirm duplication and the "fold requestDelete's empty-guard in" finding; Task 11 covers the altitude pub/sub finding for nav, explicitly leaving locale alone with a stated reason).
- **Two findings dropped as false positives**, documented in Global Constraints rather than silently omitted: the "dead" `AppController.dispose` (it's live — Task 10 fixes the comment instead) and the "clever/fragile" `unsplitStash` (judged legitimate on review — Task 13 is optional polish, not a fix for a bug).
- **Ordering:** Tasks 1-3 are pure mechanical dedup (lowest risk, do first). Task 4 must precede Task 5 (explicit dependency noted). Tasks 6-10 are independent of each other and of 1-5. Task 11 is the highest-risk task (touches nav across 4 files) — sequenced after everything else so it's reviewed on a codebase that's already passing cleanly. Tasks 12-13 are explicitly optional/last.
- **No placeholders:** every task's code is the actual code to write, not a description of it; every "apply the same pattern to files X/Y/Z" spells out each file's exact before/after.
