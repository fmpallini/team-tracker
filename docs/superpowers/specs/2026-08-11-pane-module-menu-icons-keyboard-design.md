# Pane module dropdown — icons + keyboard navigation — design

## Goal

The pane's module ▾ menu (`buildMenu`, [panes.ts:596-660](../../../src/ui/panes.ts#L596-L660))
is a hand-rolled two-level tree — Daily / General / "Person ▸" toggle (with
Stakeholders/Members subitems once expanded) / Stakeholders / Members /
Actions / Milestones / Risks — with no icons and no keyboard support: every
row is a plain `onclick` button, opened/closed and picked entirely by mouse.

Meanwhile the Ctrl+K picker already solves the same "pick a module" problem
with icons (`KIND_ICON`, via `buildModuleItems`, [panes.ts:90-110](../../../src/ui/panes.ts#L90-L110))
and full keyboard navigation, built on the shared `select-list.ts` helpers
(`paintSelection`, `clampMove`, `selectableRowProps`) that also power
@-mentions, the `/` template picker, header search, and the sidebar's team
switcher.

Decision, revised: rather than keep the pane menu's tree shape, drop the
Person branch entirely. The pane menu becomes a **plain, flat module list** —
Daily, General, Stakeholders, Members, Actions, Milestones, Risks — with no
expand/collapse and no individual people. Jumping straight to one person's
notes is Ctrl+K's job (renamed "Fast Switch" — see below), which already
lists every person by name via `buildModuleItems`. This is a strict
simplification of this spec's first draft (tree-shaped, superseded): no tree
state, no dynamic row count, no toggle-vs-commit branching in the keyboard
handler — just a fixed 7-row list, closely mirroring the team
switcher ([sidebar.ts:194-227](../../../src/ui/sidebar.ts#L194-L227)), the
closest existing precedent for a button-triggered (not text-input-triggered)
list.

## Icons

Every row gets its `KIND_ICON[kind]` prefix, same constant `buildModuleItems`
already uses for Ctrl+K — no new icons, no new i18n keys:
`daily`, `general`, and each of the five `FIXED_MODULE_KEYS` kinds
(`stakeholders`/`members`/`actions`/`milestones`/`risks`).

## `src/ui/panes.ts` changes

1. Import `paintSelection`, `clampMove`, `selectableRowProps` from
   `./select-list`.
2. Delete `personSubOpen` entirely (state, the `toggleMenu` reset on close,
   and every read/write) — no longer meaningful once there's no toggle.
3. Add per-pane state next to `menuOpen`: `const menuSelected: [number, number] = [0, 0]`.
4. `toggleMenu(idx)` — on open, set `menuSelected[idx]` to the index of the
   row matching the pane's current module kind in the fixed 7-item list,
   falling back to `0` (Daily) if the current loc's kind isn't one of the
   seven (e.g. it's a specific person). Mirrors the team switcher defaulting
   to the active team on open ([sidebar.ts:234](../../../src/ui/sidebar.ts#L234)).
5. `buildMenu` — replace `dailyBtn`/`generalBtn`/`personToggle`+subitems/
   `fixedBtns` with one flat array built the same way `buildModuleItems`
   assembles its first two entries plus `FIXED_MODULE_KEYS`, but rendered as
   `.tt-pane-menu-item` buttons via `selectableRowProps({ class: 'tt-pane-menu-item', selected: <index === menuSelected[idx]>, onCommit: () => pick(ref), onHover: () => { menuSelected[idx] = <index>; paintSelection(listEl, '.tt-pane-menu-item', menuSelected[idx]) } })`,
   same pattern as `sidebar.ts:241-246`. `buildMenu`'s returned
   `<div class="tt-pane-menu">` needs a stable `listEl` reference to pass into
   `paintSelection` (currently it's an inline `el(...)` return with no local
   binding).
6. New `onMenuKeydown(e, idx)`, attached via
   `document.addEventListener('keydown', onMenuKeydown, true)` when the menu
   opens and removed when it closes (same lifecycle as
   `onSwitcherKeydown`/`closeTeamSwitcher`, [sidebar.ts:200-227](../../../src/ui/sidebar.ts#L200-L227)):
   - `ArrowDown`/`ArrowUp`: `e.preventDefault()`, `clampMove` over the fixed
     count of 7 + `paintSelection`.
   - `Enter`: `e.preventDefault()`, commit the selected row (`pick(ref)`,
     same as a click) — no toggle branch needed now.
   - `Escape`: close the menu (`menuOpen[idx] = false`, same cleanup
     `toggleMenu` does on close) and return focus to the trigger button.
7. `personGroup`/`subItems`/`tt-pane-menu-subheader`/`tt-pane-menu-subitem`/
   `tt-pane-menu-parent` construction in `buildMenu` is deleted along with
   the state — nothing in `styles.css` references them elsewhere (checked),
   so their CSS rules ([styles.css:508-510](../../../styles.css#L508-L510))
   are removed too.

## `styles.css` changes

- `.tt-pane-menu-item:hover` ([styles.css:507](../../../styles.css#L507))
  becomes
  `.tt-pane-menu-item.selected, .tt-pane-menu-item:hover { background: rgba(var(--accent-rgb), .1); }`,
  matching the existing `.selected, :hover` convention used by
  `.tt-team-switcher-item`, `.tt-palette-item`, and `.tt-atref-item`
  (styles.css:206, 526, 626).
- Delete `.tt-pane-menu-subitem`, `.tt-pane-menu-subheader`,
  `.tt-pane-menu-group` ([styles.css:508-510](../../../styles.css#L508-L510)).

## Rename: Ctrl+K picker → "Fast Switch" (UI text only)

Internal names (`palette.ts`, `Palette`, `createPalette`, `PaletteRow`,
every `.tt-palette-*` CSS class, `prefs_palette_*` i18n keys — those are the
unrelated color-theme picker) are unchanged. Only the two i18n keys that
render the feature's name to the user change, both locales, in
`src/core/i18n.ts`:

- `app_name_button_title` (button title/tooltip on the sidebar's app-name
  button, [shell.ts:112,251](../../../src/ui/shell.ts#L112)):
  - en-US: `Open command palette (Ctrl+K)` → `Open fast switch (Ctrl+K)`
  - pt-BR: `Abrir paleta de comandos (Ctrl+K)` → `Abrir troca rápida (Ctrl+K)`
- `help_global_palette` (row label in the keyboard-shortcuts help screen,
  [help.ts:32](../../../src/ui/help.ts#L32)):
  - en-US: `Command palette` → `Fast switch`
  - pt-BR: `Paleta de comandos` → `Troca rápida`

Also update `palette_placeholder` (the modal's search input placeholder,
[i18n.ts:210,661](../../../src/core/i18n.ts#L210)) to add the Ctrl+K hint the
user asked for, on top of its existing "what you can search" text:
- en-US: `Search module, person, task, milestone or risk…` →
  `Search module, person, task, milestone or risk… (Ctrl+K)`
- pt-BR: `Buscar módulo, pessoa, tarefa, marco ou risco…` →
  `Buscar módulo, pessoa, tarefa, marco ou risco… (Ctrl+K)`

**README.md** — two genuinely user-facing (not internal/architecture) hits,
in the screenshots table ([README.md:19-20](../../../README.md#L19-L20)):
- alt text: `Ctrl+K command palette for jumping to any team, person, or item`
  → `Ctrl+K fast switch for jumping to any team, person, or item`
- caption: `` `Ctrl+K` command palette `` → `` `Ctrl+K` fast switch ``
Screenshot filename (`docs/screenshots/command-palette.png`) stays as-is —
it's a path, not user-facing text.

Everything else that still says "command palette" is internal/developer-
facing and stays unchanged: `CLAUDE.md`'s and `README.md`'s own architecture
sections (describe `src/ui/palette.ts` by its code identity, same reasoning
as the internal-names rule above), code comments (`shell.ts`, `hotkeys.ts`,
`due-panel.ts`, `palette.ts`, `styles.css`), e2e test descriptions, and every
already-published `CHANGELOG.md` entry and past `docs/superpowers/
specs|plans/*.md` file — those are historical records this project's
convention (see `CLAUDE.md`'s Changelog section) says never to rewrite.

## Testing

Check `test/palette.test.ts` for any assertion on the exact string value of
`app_name_button_title`, `help_global_palette`, or `palette_placeholder` and
update it to match; no new test needed purely for a copy change.

Extend `test/panes.test.ts`:
- Every rendered `.tt-pane-menu-item`'s `textContent` starts with its
  `KIND_ICON` value; exactly 7 rows, no person rows.
- `ArrowDown`/`ArrowUp` move `.selected` across the 7 rows in order, clamped
  at both ends (no wraparound).
- `Enter` commits the selected row (`openInPane` called with that row's ref)
  and closes the menu.
- `Escape` closes the menu.
- Opening the menu selects the row matching the pane's current module kind
  (falls back to Daily for a person loc).

Extend `test/i18n.test.ts` (or wherever key-presence/no-placeholder checks
live) only if it already asserts specific values for the two renamed keys —
otherwise no test change needed there.

## Out of scope

- Jumping to an individual person's notes from the pane menu — that's Fast
  Switch's job now.
- No search/filter input in the pane menu itself — stays a plain list, not
  adopting Fast Switch's flat searchable model.
- No per-item action/milestone/risk cards in this menu — stays module-level
  only (only `buildModuleItems`, used by Fast Switch, expands into
  individual cards).
- Fast Switch's own behavior/mechanics — untouched, only its displayed name
  changes.
- `select-list.ts`'s `paintSelection` scroll-into-view behavior — already
  shipped separately (`e9f89b5`), reused here as-is.
