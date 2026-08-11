# Pane Module Menu Icons + Keyboard Nav, and Fast Switch Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flatten the pane bar's module ▾ menu into a plain 7-row icon-prefixed list with keyboard navigation, and rename the Ctrl+K picker to "Fast Switch" in every user-facing string.

**Architecture:** `src/ui/panes.ts`'s `buildMenu` currently renders a two-level tree (Daily/General/"Person ▸" toggle+subitems/five fixed modules) with no icons and mouse-only interaction. Task 1 replaces the tree with a flat array of the same 7 whole-board rows (drops Person entirely — individual people are reached via Ctrl+K instead) and prefixes each with the existing `KIND_ICON` constant. Task 2 layers keyboard navigation on top using the app's existing shared list mechanics (`select-list.ts`'s `paintSelection`/`clampMove`/`selectableRowProps`), mirroring `src/ui/sidebar.ts`'s team-switcher dropdown — the closest existing precedent for a button-triggered (not text-input-triggered) list. Task 3 is unrelated to the menu and renames the Ctrl+K picker's displayed name to "Fast Switch" across two i18n keys, the search placeholder, and README.

**Tech Stack:** TypeScript, vitest/jsdom, no new dependencies.

## Global Constraints

- Zero runtime dependencies — no new packages.
- Internal identifiers stay named "palette": `palette.ts`, `Palette`, `createPalette`, `PaletteRow`, every `.tt-palette-*` CSS class, and the unrelated `prefs_palette_*` i18n keys (color theme) are never touched. Only the two i18n keys that render the feature's *name* to the user change, plus the search placeholder and two README lines.
- All user-visible strings go through `t(locale, key)`; add/change values for both `en-US` and `pt-BR` together, never one locale alone.
- `.tt-pane-modules-btn` class name stays on the trigger button (existing e2e hooks depend on it) — out of scope for this plan, not touched.
- Already-published `CHANGELOG.md` entries and past `docs/superpowers/specs|plans/*.md` files are historical record — never rewritten.
- Don't re-run the full suite mid-task beyond what each step says; each task's own steps specify exactly which tests to run.

---

### Task 1: Flatten the pane module menu — drop Person subtree, add icons

**Files:**
- Modify: `src/ui/panes.ts:90-110` (add `paneMenuItems` after `buildModuleItems`), `:287-288` (remove `personSubOpen`), `:417-429` (`onDocumentClick`, remove `personSubOpen` resets), `:590-594` (`toggleMenu`, remove `personSubOpen` reset), `:596-660` (`buildMenu`, rewrite as flat list)
- Modify: `styles.css:497-510` (`.tt-pane-menu` family — delete subitem/subheader/group rules, unused after this task)
- Test: `test/panes.test.ts:395-428` (existing menu tests — update for icons + flat structure)

**Interfaces:**
- Produces: `paneMenuItems(): { kind: 'daily' | 'general' | 'stakeholders' | 'members' | 'actions' | 'milestones' | 'risks'; ref: ModuleRef; labelKey: MsgKey }[]` — a module-scope function in `panes.ts` (not exported), the fixed 7-row list every later task (Task 2's keyboard handler) reads from. `KIND_ICON[row.kind]` gives each row's icon.

- [ ] **Step 1: Update the two existing menu tests to expect the flattened, icon-prefixed structure**

Replace the test at [test/panes.test.ts:417-428](../../../test/panes.test.ts#L417-L428) (`'pane module dropdown lists General notes right after Daily notes'`) with:

```ts
test('pane module dropdown is a flat, icon-prefixed list of the 7 whole-board modules, no Person entry', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.renderAll()

  paneBtn(0, 'tt-pane-modules-btn').click()
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-pane-idx="0"] .tt-pane-menu-item'))

  expect(items.map((b) => b.textContent)).toEqual([
    `${KIND_ICON.daily} ${t('en-US', 'module_daily')}`,
    `${KIND_ICON.general} ${t('en-US', 'module_general_notes')}`,
    `${KIND_ICON.stakeholders} ${t('en-US', 'module_stakeholders')}`,
    `${KIND_ICON.members} ${t('en-US', 'module_members')}`,
    `${KIND_ICON.actions} ${t('en-US', 'module_actions')}`,
    `${KIND_ICON.milestones} ${t('en-US', 'module_milestones')}`,
    `${KIND_ICON.risks} ${t('en-US', 'module_risks')}`,
  ])
})
```

Update the Milestones-picking test at [test/panes.test.ts:395-415](../../../test/panes.test.ts#L395-L415): change the line

```ts
  const milestonesItem = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-pane-idx="0"] .tt-pane-menu-item'))
    .find((b) => b.textContent === t('en-US', 'module_milestones'))
```

to

```ts
  const milestonesItem = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-pane-idx="0"] .tt-pane-menu-item'))
    .find((b) => b.textContent === `${KIND_ICON.milestones} ${t('en-US', 'module_milestones')}`)
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run test/panes.test.ts`
Expected: the two updated tests FAIL — actual DOM still has the old tree (Person row present, no icons, wrong text).

- [ ] **Step 3: Add `paneMenuItems()` in `src/ui/panes.ts`**

Insert immediately after `buildModuleItems` (after the closing `}` at [panes.ts:110](../../../src/ui/panes.ts#L110), before `titleFor`):

```ts
type PaneMenuRow = {
  kind: 'daily' | 'general' | 'stakeholders' | 'members' | 'actions' | 'milestones' | 'risks'
  ref: ModuleRef
  labelKey: MsgKey
}

/** The pane bar's module menu: whole-board entries only, no people, no per-item cards — see buildModuleItems for the fuller Ctrl+K equivalent. */
function paneMenuItems(): PaneMenuRow[] {
  return [
    { kind: 'daily', ref: { kind: 'daily', date: todayIso() }, labelKey: 'module_daily' },
    { kind: 'general', ref: { kind: 'general' }, labelKey: 'module_general_notes' },
    ...FIXED_MODULE_KEYS.map(({ kind, key }): PaneMenuRow => ({ kind, ref: { kind }, labelKey: key })),
  ]
}
```

- [ ] **Step 4: Delete `personSubOpen` state**

Remove [panes.ts:288](../../../src/ui/panes.ts#L288):

```ts
  const personSubOpen: [boolean, boolean] = [false, false]
```

- [ ] **Step 5: Remove `personSubOpen` resets in `onDocumentClick`**

In `onDocumentClick` ([panes.ts:417-429](../../../src/ui/panes.ts#L417-L429)), delete these two lines:

```ts
    personSubOpen[0] = false
    personSubOpen[1] = false
```

- [ ] **Step 6: Simplify `toggleMenu`**

Replace [panes.ts:590-594](../../../src/ui/panes.ts#L590-L594):

```ts
  function toggleMenu(idx: 0 | 1): void {
    menuOpen[idx] = !menuOpen[idx]
    if (!menuOpen[idx]) personSubOpen[idx] = false
    renderBar(idx)
  }
```

with:

```ts
  function toggleMenu(idx: 0 | 1): void {
    menuOpen[idx] = !menuOpen[idx]
    renderBar(idx)
  }
```

- [ ] **Step 7: Rewrite `buildMenu` as a flat, icon-prefixed list**

Replace the entire function body at [panes.ts:596-661](../../../src/ui/panes.ts#L596-L661) (from `function buildMenu` through its closing `}`) with:

```ts
  function buildMenu(idx: 0 | 1, teamId: string): HTMLElement {
    const lc = localeNow()

    function pick(ref: ModuleRef): void {
      menuOpen[idx] = false
      openInPane(idx, { teamId, ref })
    }

    const itemBtns = paneMenuItems().map((row) =>
      el(
        'button',
        { class: 'tt-pane-menu-item', type: 'button', onclick: () => pick(row.ref) },
        `${KIND_ICON[row.kind]} ${t(lc, row.labelKey)}`
      )
    )

    return el('div', { class: 'tt-pane-menu' }, ...itemBtns)
  }
```

This drops the `team` lookup, `personToggle`, `subItems`, and `personGroup` construction entirely — `team` is no longer read anywhere in `buildMenu`.

- [ ] **Step 8: Run the tests, verify they pass**

Run: `npx vitest run test/panes.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 9: Remove now-unused CSS**

In `styles.css`, replace [styles.css:503-510](../../../styles.css#L503-L510):

```css
.tt-pane-menu-item {
  background: transparent; color: var(--fg); border: none; text-align: left;
  padding: .4rem .6rem; border-radius: 4px; cursor: pointer; font-size: .95rem;
}
.tt-pane-menu-item:hover { background: rgba(var(--accent-rgb), .1); }
.tt-pane-menu-subitem { padding-left: 1.4rem; }
.tt-pane-menu-subheader { color: var(--muted); font-size: .75rem; padding: .3rem .6rem 0; }
.tt-pane-menu-group { display: flex; flex-direction: column; }
```

with:

```css
.tt-pane-menu-item {
  background: transparent; color: var(--fg); border: none; text-align: left;
  padding: .4rem .6rem; border-radius: 4px; cursor: pointer; font-size: .95rem;
}
.tt-pane-menu-item:hover { background: rgba(var(--accent-rgb), .1); }
```

(`.tt-pane-menu-subitem`/`-subheader`/`-group` are unused now that `buildMenu` no longer emits them — confirm with `grep -rn "tt-pane-menu-subitem\|tt-pane-menu-subheader\|tt-pane-menu-group" src test` before deleting, expect no hits outside this CSS file.)

- [ ] **Step 10: Full verification**

Run: `npx vitest run` — expect all files green.
Run: `npm run typecheck` — expect no errors.
Run: `npm run lint` — expect no errors.

- [ ] **Step 11: Commit**

```bash
git add src/ui/panes.ts styles.css test/panes.test.ts
git commit -m "feat: flatten pane module menu, add icons, drop Person subtree

Individual people are reached via Ctrl+K instead - the pane menu is
now a plain 7-row list of whole-board modules, icon-prefixed to match
Ctrl+K's own rows."
```

---

### Task 2: Keyboard navigation for the pane module menu

**Files:**
- Modify: `src/ui/panes.ts` (imports, new state, `toggleMenu`→`openMenu`/`closeMenu` split, keydown handlers, `buildMenu` migrated to `select-list.ts` helpers, `onDocumentClick`, `dispose()`)
- Test: `test/panes.test.ts` (new tests for arrow/enter/escape, dispose-while-open)

**Interfaces:**
- Consumes: `paneMenuItems()` from Task 1 (fixed 7-row list); `paintSelection`, `clampMove`, `selectableRowProps` from `src/ui/select-list.ts` (existing, unchanged signatures — see [select-list.ts](../../../src/ui/select-list.ts)).
- Produces: nothing new consumed by later tasks — this is the last change to `panes.ts` in this plan.

- [ ] **Step 1: Write the failing tests**

Add to `test/panes.test.ts`, near the other menu tests (after the test added in Task 1):

```ts
test('ArrowDown/ArrowUp move the highlighted pane-menu row, clamped at both ends', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.renderAll()

  paneBtn(0, 'tt-pane-modules-btn').click()
  const selectedLabel = () => document.querySelector('[data-pane-idx="0"] .tt-pane-menu-item.selected')?.textContent

  expect(selectedLabel()).toBe(`${KIND_ICON.daily} ${t('en-US', 'module_daily')}`)

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(selectedLabel()).toBe(`${KIND_ICON.general} ${t('en-US', 'module_general_notes')}`)

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  expect(selectedLabel()).toBe(`${KIND_ICON.daily} ${t('en-US', 'module_daily')}`)

  // Clamped at the top: one more ArrowUp does nothing.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  expect(selectedLabel()).toBe(`${KIND_ICON.daily} ${t('en-US', 'module_daily')}`)

  // Walk to the bottom (6 more ArrowDowns reaches Risks, the 7th row) and confirm clamping there too.
  for (let i = 0; i < 6; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(selectedLabel()).toBe(`${KIND_ICON.risks} ${t('en-US', 'module_risks')}`)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(selectedLabel()).toBe(`${KIND_ICON.risks} ${t('en-US', 'module_risks')}`)
})

test('opening the menu highlights the row matching the pane\'s current module', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'risks' } })

  paneBtn(0, 'tt-pane-modules-btn').click()
  const selected = document.querySelector('[data-pane-idx="0"] .tt-pane-menu-item.selected')
  expect(selected?.textContent).toBe(`${KIND_ICON.risks} ${t('en-US', 'module_risks')}`)
})

test('Enter commits the highlighted pane-menu row and closes the menu', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.renderAll()

  paneBtn(0, 'tt-pane-modules-btn').click()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) // -> General notes
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

  expect(document.querySelector('.tt-pane-menu')).toBeNull()
  expect(currentLoc(store.doc.nav.panes[0])?.ref.kind).toBe('general')
})

test('Escape closes the pane menu without picking anything', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'actions' } })

  paneBtn(0, 'tt-pane-modules-btn').click()
  expect(document.querySelector('.tt-pane-menu')).not.toBeNull()

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

  expect(document.querySelector('.tt-pane-menu')).toBeNull()
  expect(currentLoc(store.doc.nav.panes[0])?.ref.kind).toBe('actions')
})

test('dispose() while a pane menu is open closes it and drops its document keydown listener', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.renderAll()

  paneBtn(0, 'tt-pane-modules-btn').click()
  expect(document.querySelector('.tt-pane-menu')).not.toBeNull()

  pm.dispose()

  expect(document.querySelector('.tt-pane-menu')).toBeNull()
  // The keydown listener is capture-phase on document; if it survived, this
  // would throw trying to paintSelection into the now-detached menu list.
  expect(() => document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
  )).not.toThrow()
})
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run test/panes.test.ts`
Expected: the 5 new tests FAIL (no `.selected` class exists yet, no keydown handling, `Enter`/`Escape` do nothing).

- [ ] **Step 3: Import the shared list helpers**

In `src/ui/panes.ts`, add to the imports (near the `el` import at [panes.ts:9](../../../src/ui/panes.ts#L9)):

```ts
import { paintSelection, clampMove, selectableRowProps } from './select-list'
```

- [ ] **Step 4: Add keyboard-nav state**

Replace [panes.ts:287](../../../src/ui/panes.ts#L287) (`const menuOpen: [boolean, boolean] = [false, false]`) with:

```ts
  const menuOpen: [boolean, boolean] = [false, false]
  const menuSelected: [number, number] = [0, 0]
  const menuListEls: [HTMLElement | null, HTMLElement | null] = [null, null]
```

- [ ] **Step 5: Replace `toggleMenu` with `openMenu`/`closeMenu`/`toggleMenu`**

Replace the `toggleMenu` written in Task 1 ([panes.ts:590-593](../../../src/ui/panes.ts#L590-L593) after Task 1's edit) with:

```ts
  function openMenu(idx: 0 | 1): void {
    const cur = currentLoc(store.doc.nav.panes[idx])
    const rows = paneMenuItems()
    const foundIdx = cur ? rows.findIndex((r) => r.kind === cur.ref.kind) : -1
    menuSelected[idx] = foundIdx === -1 ? 0 : foundIdx
    menuOpen[idx] = true
    document.addEventListener('keydown', idx === 0 ? onMenuKeydown0 : onMenuKeydown1, true)
  }

  function closeMenu(idx: 0 | 1): void {
    if (!menuOpen[idx]) return
    menuOpen[idx] = false
    menuListEls[idx] = null
    document.removeEventListener('keydown', idx === 0 ? onMenuKeydown0 : onMenuKeydown1, true)
  }

  function toggleMenu(idx: 0 | 1): void {
    if (menuOpen[idx]) closeMenu(idx)
    else openMenu(idx)
    renderBar(idx)
  }

  function makeMenuKeydownHandler(idx: 0 | 1): (e: KeyboardEvent) => void {
    return (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const count = paneMenuItems().length
        menuSelected[idx] = clampMove(menuSelected[idx], e.key === 'ArrowDown' ? 1 : -1, count)
        paintSelection(menuListEls[idx], '.tt-pane-menu-item', menuSelected[idx])
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const teamId = store.doc.nav.activeTeamId
        const row = paneMenuItems()[menuSelected[idx]]
        if (!teamId || !row) return
        closeMenu(idx)
        openInPane(idx, { teamId, ref: row.ref })
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMenu(idx)
        renderBar(idx)
      }
    }
  }
  const onMenuKeydown0 = makeMenuKeydownHandler(0)
  const onMenuKeydown1 = makeMenuKeydownHandler(1)
```

- [ ] **Step 6: Migrate `buildMenu` to the shared row helpers**

Replace `buildMenu` (written in Task 1) with:

```ts
  function buildMenu(idx: 0 | 1, teamId: string): HTMLElement {
    const lc = localeNow()

    function pick(ref: ModuleRef): void {
      closeMenu(idx)
      openInPane(idx, { teamId, ref })
    }

    const itemBtns = paneMenuItems().map((row, i) =>
      el(
        'button',
        {
          type: 'button',
          ...selectableRowProps({
            class: 'tt-pane-menu-item',
            selected: i === menuSelected[idx],
            onCommit: () => pick(row.ref),
            onHover: () => {
              menuSelected[idx] = i
              paintSelection(menuListEls[idx], '.tt-pane-menu-item', menuSelected[idx])
            },
          }),
        },
        `${KIND_ICON[row.kind]} ${t(lc, row.labelKey)}`
      )
    )

    const listEl = el('div', { class: 'tt-pane-menu' }, ...itemBtns)
    menuListEls[idx] = listEl
    return listEl
  }
```

- [ ] **Step 7: Clean up `closeMenu` in `onDocumentClick`**

Replace [panes.ts:417-429](../../../src/ui/panes.ts#L417-L429) (post-Task-1 version):

```ts
  const onDocumentClick = (e: MouseEvent): void => {
    if (!menuOpen[0] && !menuOpen[1]) return
    const target = e.target as HTMLElement
    if (target.closest('.tt-pane-modules-btn') || target.closest('.tt-pane-menu')) return
    menuOpen[0] = false
    menuOpen[1] = false
    renderBar(0)
    renderBar(1)
  }
```

with:

```ts
  const onDocumentClick = (e: MouseEvent): void => {
    if (!menuOpen[0] && !menuOpen[1]) return
    const target = e.target as HTMLElement
    if (target.closest('.tt-pane-modules-btn') || target.closest('.tt-pane-menu')) return
    closeMenu(0)
    closeMenu(1)
    renderBar(0)
    renderBar(1)
  }
```

- [ ] **Step 8: Guarantee cleanup on `dispose()`**

In `dispose()` ([panes.ts:835-836](../../../src/ui/panes.ts#L835-L836)), add the two `closeMenu` calls before the existing `onDocumentClick` removal — mirrors `sidebar.ts`'s `closeTeamSwitcher()`-in-`dispose()` pattern ([sidebar.ts:694-699](../../../src/ui/sidebar.ts#L694-L699)):

```ts
    dispose(): void {
      closeMenu(0)
      closeMenu(1)
      document.removeEventListener('click', onDocumentClick)
```

- [ ] **Step 9: Run the tests, verify they pass**

Run: `npx vitest run test/panes.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 10: Full verification**

Run: `npx vitest run` — expect all files green.
Run: `npm run typecheck` — expect no errors.
Run: `npm run lint` — expect no errors.

- [ ] **Step 11: Commit**

```bash
git add src/ui/panes.ts test/panes.test.ts
git commit -m "feat: keyboard navigation for the pane module menu

ArrowDown/Up, Enter, and Escape now work the same way they do in
every other dropdown in the app (Ctrl+K, @ mentions, template
picker, team switcher) - same shared select-list.ts mechanics,
including the scroll-into-view fix that already landed for them."
```

---

### Task 3: Rename the Ctrl+K picker to "Fast Switch" (UI text only)

**Files:**
- Modify: `src/core/i18n.ts:20,257,479,708,210,661`
- Modify: `README.md:19-20`

**Interfaces:** none — pure string changes, no signatures affected.

- [ ] **Step 1: Change the four name-carrying i18n values**

In `src/core/i18n.ts`, the pt-BR block:

Replace [i18n.ts:20](../../../src/core/i18n.ts#L20):
```ts
  app_name_button_title: 'Abrir paleta de comandos (Ctrl+K)',
```
with:
```ts
  app_name_button_title: 'Abrir troca rápida (Ctrl+K)',
```

Replace [i18n.ts:257](../../../src/core/i18n.ts#L257):
```ts
  help_global_palette: 'Paleta de comandos',
```
with:
```ts
  help_global_palette: 'Troca rápida',
```

In the en-US block:

Replace [i18n.ts:479](../../../src/core/i18n.ts#L479):
```ts
  app_name_button_title: 'Open command palette (Ctrl+K)',
```
with:
```ts
  app_name_button_title: 'Open fast switch (Ctrl+K)',
```

Replace [i18n.ts:708](../../../src/core/i18n.ts#L708):
```ts
  help_global_palette: 'Command palette',
```
with:
```ts
  help_global_palette: 'Fast switch',
```

- [ ] **Step 2: Add the Ctrl+K hint to the search placeholder**

Replace [i18n.ts:210](../../../src/core/i18n.ts#L210) (pt-BR):
```ts
  palette_placeholder: 'Buscar módulo, pessoa, tarefa, marco ou risco…',
```
with:
```ts
  palette_placeholder: 'Buscar módulo, pessoa, tarefa, marco ou risco… (Ctrl+K)',
```

Replace [i18n.ts:661](../../../src/core/i18n.ts#L661) (en-US):
```ts
  palette_placeholder: 'Search module, person, task, milestone or risk…',
```
with:
```ts
  palette_placeholder: 'Search module, person, task, milestone or risk… (Ctrl+K)',
```

- [ ] **Step 3: Verify no test pins the old string values**

Run: `npx vitest run test/palette.test.ts`
Expected: PASS (no test in this file asserts an exact value for `app_name_button_title`, `help_global_palette`, or `palette_placeholder` — confirmed by inspection before writing this plan; this run is the safety check).

- [ ] **Step 4: Update README's screenshots table**

Replace [README.md:19-20](../../../README.md#L19-L20):
```md
| ![Risks matrix with chance/impact/exposure and mitigation plans](docs/screenshots/risks.png) | ![Ctrl+K command palette for jumping to any team, person, or item](docs/screenshots/command-palette.png) |
| Risks — chance × impact exposure | `Ctrl+K` command palette |
```
with:
```md
| ![Risks matrix with chance/impact/exposure and mitigation plans](docs/screenshots/risks.png) | ![Ctrl+K fast switch for jumping to any team, person, or item](docs/screenshots/command-palette.png) |
| Risks — chance × impact exposure | `Ctrl+K` fast switch |
```
(the screenshot filename itself, `docs/screenshots/command-palette.png`, is a path and stays unchanged.)

- [ ] **Step 5: Full verification**

Run: `npx vitest run` — expect all files green.
Run: `npm run typecheck` — expect no errors.
Run: `npm run lint` — expect no errors.

- [ ] **Step 6: Update the changelog**

Add to the `### Changed` section of the current unreleased version in `CHANGELOG.md` (check the version header still matches `package.json`'s current version before editing — see `CLAUDE.md`'s Changelog section for the convention):

```
- The pane's module ▾ menu now shows an icon per row and can be navigated with the arrow keys, Enter, and Escape — same as every other dropdown in the app. Jumping straight to one person's notes is now done via Ctrl+K (renamed "Fast Switch") instead of the pane menu.
- The Ctrl+K picker is now called "Fast Switch" throughout the app.
```

- [ ] **Step 7: Commit**

```bash
git add src/core/i18n.ts README.md CHANGELOG.md
git commit -m "feat: rename Ctrl+K picker to \"Fast Switch\" in UI text

Renames the two i18n keys that display the feature's name (button
tooltip, help screen row), adds a Ctrl+K hint to its search
placeholder, and updates README's screenshot caption/alt text.
Internal names (palette.ts, .tt-palette-* CSS, prefs_palette_* theme
keys) are unchanged."
```

## Self-review

- **Spec coverage:** icons ✓ (Task 1), flat list / no Person subtree ✓ (Task 1), keyboard nav (arrow/enter/escape, mirroring team switcher, dispose cleanup) ✓ (Task 2), i18n rename of both name-carrying keys ✓ (Task 3 Step 1), placeholder Ctrl+K hint ✓ (Task 3 Step 2), README alt-text/caption ✓ (Task 3 Step 4), CHANGELOG entry ✓ (Task 3 Step 6), internal names/CSS/CLAUDE.md/historical docs left alone ✓ (Global Constraints + Task 3 note).
- **Placeholder scan:** no TBDs; every step has literal code/diffs, not descriptions.
- **Type consistency:** `PaneMenuRow`/`paneMenuItems()` introduced in Task 1 and consumed as-is (same name, same shape) in Task 2's `openMenu` and keydown handler — no renaming drift. `ModuleRef`, `MsgKey`, `Locale` all pre-existing imports, no new type surface beyond `PaneMenuRow`.
