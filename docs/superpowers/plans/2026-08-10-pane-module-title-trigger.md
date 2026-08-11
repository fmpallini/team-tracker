# Pane Module Title-Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the pane bar's plain `.tt-pane-title` label and separate bare-▾ `.tt-pane-modules-btn` into one clickable trigger button that shows the current module name + chevron, positioned in `bar-left` instead of `bar-right`, so it reads as the primary "current module, click to switch" control instead of a buried icon button.

**Architecture:** Single-file change in `src/ui/panes.ts`'s `renderBar()` (replace two elements with one), a matching CSS swap in `styles.css` (new `.tt-pane-title-trigger` rule, `.tt-pane-menu` anchor flips from `right` to `left`), and one new test in `test/panes.test.ts` covering the merge. No new files, no i18n keys, no schema/doc changes.

**Tech Stack:** TypeScript, vitest + jsdom, plain DOM (`src/ui/dom.ts`'s `el()`), CSS custom properties (`styles.css`'s theme/palette tokens).

## Global Constraints

- Zero runtime dependencies — this is a DOM/CSS-only change, no new packages.
- Every user-visible string goes through `t(locale, key)` — this change adds no new strings, reuses `pane_modules_title` / `pane_no_team` / `pane_empty` from `src/core/i18n.ts` as-is.
- Keep `.tt-pane-modules-btn` as a class on the merged trigger — `e2e/leak.spec.ts:78` and `e2e/perf.spec.ts:90,126` click it by that selector and must not need edits.
- Follow the approved spec exactly: `docs/superpowers/specs/2026-08-10-pane-module-title-trigger-design.md`.

---

### Task 1: Merge pane title + modules button into one trigger

**Files:**
- Modify: `src/ui/panes.ts:694-770` (`renderBar` function)
- Modify: `styles.css:481` (delete `.tt-pane-title` rule), `styles.css:487-492` (`.tt-pane-menu` anchor)
- Test: `test/panes.test.ts` (new test, alongside the existing pane-bar tests around line 627)

**Interfaces:**
- Consumes: `titleFor(store, cur, lc)` (existing, [panes.ts:112-139](../../../src/ui/panes.ts#L112-L139)) — unchanged signature, still returns the current module's display string.
- Consumes: `t(lc, 'pane_modules_title' | 'pane_no_team' | 'pane_empty')` — existing i18n keys, unchanged.
- Produces: nothing new consumed by other tasks — this is the only task in this plan.

- [ ] **Step 1: Write the failing test**

Add to `test/panes.test.ts`, near the other pane-bar tests (e.g. right after the `'print button is disabled...'` test around line 636):

```ts
test('module title/modules button are merged into one trigger: shows current module name, no separate title span, tracks disabled/title with team state', () => {
  const { store, pm } = setup()

  // No active team yet: trigger disabled, tooltip explains why, no title span exists separately.
  const before = paneBtn(0, 'tt-pane-modules-btn')
  expect(before.disabled).toBe(true)
  expect(before.title).toBe(t('en-US', 'pane_no_team'))
  expect(document.querySelector('[data-pane-idx="0"] .tt-pane-title')).toBeNull()

  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'risks' } })

  const after = paneBtn(0, 'tt-pane-modules-btn')
  expect(after.disabled).toBe(false)
  expect(after.title).toBe(t('en-US', 'pane_modules_title'))
  expect(after.textContent).toContain(t('en-US', 'module_risks'))
  expect(document.querySelector('[data-pane-idx="0"] .tt-pane-title')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/panes.test.ts -t "module title/modules button are merged"`
Expected: FAIL — today's `.tt-pane-modules-btn` is a bare `▾` button with no text content, and a separate `.tt-pane-title` span does exist, so both `textContent` and the "no separate span" assertions fail.

- [ ] **Step 3: Merge the two elements in `renderBar`**

In `src/ui/panes.ts`, `renderBar` currently builds ([panes.ts:727-740](../../../src/ui/panes.ts#L727-L740)):

```ts
const titleEl = el('span', { class: 'tt-pane-title' }, cur ? titleFor(store, cur, lc) : t(lc, 'pane_empty'))

const teamId = nav.activeTeamId
const modulesBtn = el(
  'button',
  {
    class: 'tt-btn tt-pane-modules-btn',
    type: 'button',
    title: t(lc, teamId ? 'pane_modules_title' : 'pane_no_team'),
    disabled: teamId === null,
    onclick: () => toggleMenu(idx),
  },
  '▾'
)
```

Replace both with a single merged trigger:

```ts
const teamId = nav.activeTeamId
const modulesBtn = el(
  'button',
  {
    class: 'tt-pane-title-trigger tt-pane-modules-btn',
    type: 'button',
    title: t(lc, teamId ? 'pane_modules_title' : 'pane_no_team'),
    disabled: teamId === null,
    onclick: () => toggleMenu(idx),
  },
  el('span', { class: 'tt-pane-title-text' }, cur ? titleFor(store, cur, lc) : t(lc, 'pane_empty')),
  el('span', { class: 'tt-pane-title-chev' }, '▾')
)
```

Then update the bar assembly a few lines down ([panes.ts:763-764](../../../src/ui/panes.ts#L763-L764)):

```ts
const left = el('div', { class: 'tt-pane-bar-left' }, backBtn, fwdBtn, modulesBtn)
const right = el('div', { class: 'tt-pane-bar-right' }, printBtn, splitBtn)
```

(was `el('div', { class: 'tt-pane-bar-left' }, backBtn, fwdBtn, titleEl)` and `el('div', { class: 'tt-pane-bar-right' }, modulesBtn, printBtn, splitBtn)`.)

No other lines in `renderBar` change — `barEl.append(left, right)` and the `if (menuOpen[idx] && teamId !== null) barEl.appendChild(buildMenu(idx, teamId))` block below it are untouched.

- [ ] **Step 4: Update the CSS**

In `styles.css`, delete the old title rule at line 481:

```css
.tt-pane-title { font-family: var(--font-display); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
```

Replace it with (same spot):

```css
.tt-pane-title-trigger {
  display: inline-flex; align-items: center; gap: .3rem; min-width: 0;
  background: transparent; border: none; color: var(--fg); cursor: pointer;
  padding: .2rem .35rem; border-radius: 4px; font-family: var(--font-display);
  font-weight: 700; font-size: 1rem;
}
.tt-pane-title-trigger:not(:disabled):hover { background: rgba(var(--accent-rgb), .12); color: var(--accent); }
.tt-pane-title-trigger:disabled { cursor: not-allowed; opacity: .6; }
.tt-pane-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tt-pane-title-chev { font-size: .7rem; opacity: .75; flex: none; }
```

Then flip the menu's anchor side at [styles.css:487-492](../../../styles.css#L487-L492) — change `right: .5rem;` to `left: .5rem;`:

```css
.tt-pane-menu {
  position: absolute; top: 100%; left: .5rem; z-index: 100; margin-top: .25rem;
  background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .25); display: flex; flex-direction: column;
  min-width: 200px; max-height: 60vh; overflow-y: auto; padding: .25rem;
}
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `npx vitest run test/panes.test.ts -t "module title/modules button are merged"`
Expected: PASS

- [ ] **Step 6: Run the full unit test suite**

Run: `npm test`
Expected: All tests pass, including the pre-existing `.tt-pane-modules-btn` click/menu tests (`test/panes.test.ts` lines ~407-424, ~786-806) which target the same class name and therefore keep working unchanged against the merged element.

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: Both clean — no new type errors (the `el()` calls use the same helper signature already used elsewhere in the file for nested children, e.g. `personGroup`), no lint violations.

- [ ] **Step 8: Build and run the two e2e specs that click `.tt-pane-modules-btn`**

Run: `npm run build && npx playwright test e2e/leak.spec.ts e2e/perf.spec.ts`
Expected: Both pass — confirms the kept `.tt-pane-modules-btn` class is still clickable and opens the menu the same way in a real Chromium page, not just jsdom.

- [ ] **Step 9: Commit**

```bash
git add src/ui/panes.ts styles.css test/panes.test.ts
git commit -m "feat: merge pane module title and dropdown trigger into one control"
```
