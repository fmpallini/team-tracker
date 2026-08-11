# Pane module dropdown — title-as-trigger — design

## Goal

The pane bar's module switcher (▾ button, opens the Daily/General/Person/
Stakeholders/Members/Actions/Milestones/Risks menu) is a bare, icon-only
button on the far right of the bar, sandwiched between print 🖨️ and split ⧉.
It's easy to miss and doesn't read as the primary nav control it is. Make the
already-bold pane title itself the trigger, and drop the separate button.

Confirmed via a side-by-side mockup of three options (title-as-trigger,
right-side pill, dedicated selector row above the bar) — title-as-trigger
chosen: reuses existing bar real estate/eyeball attention instead of adding a
competing element, costs no extra vertical space, matches the familiar
"current value + ▾" `<select>` affordance.

## `src/ui/panes.ts` changes

`renderBar` ([panes.ts:694-770](../../../src/ui/panes.ts#L694-L770)) currently
builds two separate elements:
- `titleEl` — plain `<span class="tt-pane-title">`, just text, no interaction.
- `modulesBtn` — `<button class="tt-btn tt-pane-modules-btn">▾</button>`,
  bare chevron, right-aligned in `bar-right`.

Merge them into one trigger button in `bar-left`, right after `fwdBtn`:

```
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

- `tt-pane-modules-btn` class is kept unchanged so existing e2e hooks
  (`e2e/leak.spec.ts:78`, `e2e/perf.spec.ts:90,126`, both do
  `.tt-pane-modules-btn` → `.click()`) keep working with no edits.
- `disabled`/`title` logic (was on the old `modulesBtn`) carries over as-is —
  same `pane_modules_title` / `pane_no_team` i18n keys, no new keys.
- `titleEl` and the old bare `modulesBtn` are deleted. `left` becomes
  `el('div', { class: 'tt-pane-bar-left' }, backBtn, fwdBtn, modulesBtn)`.
  `right` becomes `el('div', { class: 'tt-pane-bar-right' }, printBtn, splitBtn)`.

`buildMenu`'s return value and all its logic (`menuOpen`, `personSubOpen`,
`pick`, click-outside-close at [panes.ts:417-421](../../../src/ui/panes.ts#L417-L421))
are untouched — only the menu's anchor position moves (see CSS below), since
`.tt-pane-menu` is appended as a sibling of `left`/`right` inside `barEl`
either way ([panes.ts:767-769](../../../src/ui/panes.ts#L767-L769)).

## `styles.css` changes

- `.tt-pane-menu` ([styles.css:487-492](../../../styles.css#L487-L492)):
  `right: .5rem` → `left: .5rem`, so it opens under the trigger's new
  left-side position instead of the old right-side button.
- Replace the plain `.tt-pane-title` rule
  ([styles.css:481](../../../styles.css#L481)) with a `.tt-pane-title-trigger`
  button reset + hover/open affordance (same visual family as
  `.tt-pane-modules-btn`'s current bare styling, but text-weight not
  bordered-button-weight — it should still read as a title, just an
  interactive one):
  ```
  .tt-pane-title-trigger {
    display: inline-flex; align-items: center; gap: .3rem; min-width: 0;
    background: transparent; border: none; color: var(--fg); cursor: pointer;
    padding: .2rem .35rem; border-radius: 4px; font-family: var(--font-display);
    font-weight: 700; font-size: 1rem;
  }
  .tt-pane-title-trigger:hover, .tt-pane-title-trigger:disabled { background: transparent; }
  .tt-pane-title-trigger:not(:disabled):hover { background: rgba(var(--accent-rgb), .12); color: var(--accent); }
  .tt-pane-title-trigger:disabled { cursor: not-allowed; color: var(--fg); opacity: .6; }
  .tt-pane-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tt-pane-title-chev { font-size: .7rem; opacity: .75; flex: none; }
  ```
  (mirrors the mockup's `.title-trigger` rule). `disabled` state (no team)
  keeps plain `--fg` at reduced opacity rather than the accent hover tint, so
  it doesn't look clickable when it isn't.

## Testing

`test/panes.test.ts` queries only `.tt-pane-modules-btn` and `.tt-pane-menu`
(checked — no test queries the now-removed `.tt-pane-title` span), so the
existing open/close/click-item tests
([panes.test.ts:407-424,786-806](../../../test/panes.test.ts#L407)) keep
passing unchanged against the merged element. Add one assertion that the
trigger's disabled state and title attribute still track `teamId === null`
the same way the old separate button did (currently implicit — worth an
explicit check since the disabled/title logic moved onto a different element).

## Out of scope

- Menu content/grouping/icons (flat list stays as-is).
- Keyboard navigation within the open menu.
- Ctrl+K palette (`buildModuleItems`) — separate picker, untouched.
