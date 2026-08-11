# Pane module dropdown — icons + keyboard navigation — design

## Goal

The pane's module ▾ menu (`buildMenu`, [panes.ts:596-660](../../../src/ui/panes.ts#L596-L660))
is a hand-rolled two-level tree — Daily / General / "Person ▸" toggle (with
Stakeholders/Members subitems once expanded) / Stakeholders / Members /
Actions / Milestones / Risks — with no icons and no keyboard support: every
row is a plain `onclick` button, opened/closed and picked entirely by mouse.

Meanwhile the Ctrl+K palette already solves the same "pick a module" problem
with icons (`KIND_ICON`, via `buildModuleItems`, [panes.ts:90-110](../../../src/ui/panes.ts#L90-L110))
and full keyboard navigation, built on the shared `select-list.ts` helpers
(`paintSelection`, `clampMove`, `selectableRowProps`) that also power
@-mentions, the `/` template picker, header search, and the sidebar's team
switcher.

Decision: keep the pane menu's current tree shape (confirmed — not
flattening it into a palette-style searchable list), but bring it up to the
same standard as every other dropdown in the app — icons on every row, and
arrow-key/Enter/Escape navigation via the same shared mechanics, closely
mirroring the team switcher ([sidebar.ts:194-227](../../../src/ui/sidebar.ts#L194-L227)),
the closest existing precedent for a button-triggered (not text-input-
triggered) list.

## Icons

Every row gets its `KIND_ICON[kind]` prefix, same constant `buildModuleItems`
already uses for the palette — no new icons, no new i18n keys:

- `dailyBtn` → `KIND_ICON.daily`
- `generalBtn` → `KIND_ICON.general`
- `personToggle` and every person subitem → `KIND_ICON.person`
- each of the five `fixedBtns` → `KIND_ICON[kind]` (already the row's own
  `kind`, from `FIXED_MODULE_KEYS`)

## Keyboard navigation

`src/ui/panes.ts` changes:

1. Import `paintSelection`, `clampMove`, `selectableRowProps` from
   `./select-list`.
2. Add per-pane state next to `menuOpen`/`personSubOpen`:
   `const menuSelected: [number, number] = [0, 0]`.
3. `toggleMenu(idx)` — on open, set `menuSelected[idx]` to the flat-row index
   matching the pane's current module kind (`currentLoc(...)?.ref.kind`),
   falling back to `0` (Daily) if not found in the flat list (e.g. current
   loc is a specific person/card). Mirrors the team switcher defaulting to
   the active team on open ([sidebar.ts:234](../../../src/ui/sidebar.ts#L234)).
4. `buildMenu` — replace every row's plain `onclick`-only `el('button', {class:'tt-pane-menu-item', ...})`
   with `selectableRowProps({ class: 'tt-pane-menu-item', selected: <row index === menuSelected[idx]>, onCommit: () => pick(ref), onHover: () => { menuSelected[idx] = <row index>; paintSelection(listEl, '.tt-pane-menu-item', menuSelected[idx]) } })`,
   same pattern as `sidebar.ts:241-246`. Requires giving `buildMenu`'s
   returned `<div class="tt-pane-menu">` a stable reference (`listEl`) to
   pass into `paintSelection` — currently it's an inline `el(...)` return
   with no local binding.
5. New `onMenuKeydown(e, idx)`, attached via
   `document.addEventListener('keydown', onMenuKeydown, true)` when the menu
   opens and removed when it closes (same lifecycle as
   `onSwitcherKeydown`/`closeTeamSwitcher`, [sidebar.ts:200-227](../../../src/ui/sidebar.ts#L200-L227)):
   - `ArrowDown`/`ArrowUp`: `e.preventDefault()`, re-read the current row
     count from the live DOM (`listEl.querySelectorAll('.tt-pane-menu-item').length`
     — changes when Person expands/collapses), `clampMove` +
     `paintSelection`.
   - `Enter`: if the selected row is the Person-toggle row, expand/collapse
     it (`personSubOpen[idx] = !personSubOpen[idx]`, re-render the menu,
     keep `menuSelected[idx]` unchanged so the toggle stays highlighted) —
     matches the toggle's existing click behavior. Otherwise, commit the
     selected row's ref the same way a click does (`pick(ref)`), which
     already closes the menu.
   - `Escape`: close the menu (`menuOpen[idx] = false`, same cleanup
     `toggleMenu` does on close) and return focus to the trigger button.
6. Row index mapping stays purely positional against whatever
   `.tt-pane-menu-item` rows are currently in the DOM — no separate index
   array to keep in sync with expand state, since `clampMove`/`paintSelection`
   both operate on "however many matching rows exist right now," identical to
   how `atref.ts` already handles its own filtered/changing row count.

## `styles.css` changes

`.tt-pane-menu-item:hover` ([styles.css:507](../../../styles.css#L507)) becomes
`.tt-pane-menu-item.selected, .tt-pane-menu-item:hover { background: rgba(var(--accent-rgb), .1); }`,
matching the existing `.selected, :hover` convention used by
`.tt-team-switcher-item`, `.tt-palette-item`, and `.tt-atref-item`
(styles.css:206, 526, 626).

## Testing

Extend `test/panes.test.ts`:
- Every rendered `.tt-pane-menu-item`'s `textContent` starts with its
  `KIND_ICON` value.
- `ArrowDown`/`ArrowUp` move `.selected` across rows in order, clamped at
  both ends (no wraparound), and the moving set changes once Person is
  expanded (more rows) vs collapsed (fewer).
- `Enter` on the Person-toggle row expands it (`personSubOpen` becomes true,
  menu stays open) without picking anything.
- `Enter` on a non-toggle row commits (`openInPane` called with that row's
  ref) and closes the menu — same assertion shape the existing click tests
  already use.
- `Escape` closes the menu.

## Out of scope

- No search/filter input — tree structure stays as-is (explicitly rejected
  the palette-style flat list).
- No per-item action/milestone/risk cards in this menu — stays module-level
  only, same scope `buildMenu` has today (only `buildModuleItems`, used by
  the palette, expands into individual cards).
- Ctrl+K palette itself — untouched, already has icons/keyboard nav.
- `select-list.ts`'s `paintSelection` scroll-into-view behavior — already
  shipped separately (see `e9f89b5`), reused here as-is.
