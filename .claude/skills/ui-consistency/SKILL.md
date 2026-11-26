---
name: ui-consistency
description: Use when adding or changing any screen, dialog, button, list row, card, hover/focus state, animation or spacing in src/ui, src/modules or styles.css — the app's UI rules, the tokens to use, and the guard test that enforces them.
---

# UI consistency

The app's screens agree on a small set of rules. Reuse the helper or token instead of writing a new variant; `test/design-rules.test.ts` fails the build when a rule is broken (it runs in pre-push and CI). This file is the single written source of the rules.

## Behavior

- **Edit surface.** Rich or many-field entities (task, risk, milestone) autosave as you type, in a modeless dialog or an inline row, closed with Close/Escape — never Cancel. Small forms (person, team, template, tag names, link) are Cancel/Save dialogs where Cancel discards and the confirm button reads **Save**. A picker's confirm button reads its verb (Copy, Move). Only the password prompt says OK. Don't mix: a new screen picks one of the two by that rule.
- **Delete.** One item is never confirmed: delete it with an Undo toast (`createEntityDelete`, `deleteInTeamWithUndo` + `offerUndoToast`). Bulk or irreversible deletes (team, clear zone, delete all closed, column with cards, data cleanup) use `confirmDelete` (always danger-styled; say "cannot be undone" in `warning` when there is no Undo). Never the browser `confirm()`. The Undo expires on the next edit, so keep the toast short-lived and prominent.
- **Feedback.** A change the user cannot see happen (move, copy, duplicate to another team) gets a toast; a move gets an Undo.
- **Names.** Missing name: "Name is required" in a dialog field, "This {thing} needs a name." on an inline row or card. Items are called by one word everywhere (tasks, not cards or actions).
- **Icon-only buttons** go through `iconButton()` in `ui/icons.ts` (sets `title` and `aria-label` from one string); re-label with `setIconButtonTitle()` on a locale switch.
- **Keyboard.** Card-like rows take arrows, Enter (open the full view) and, where a menu exists, Space (the context menu), all unmodified (`isPlainKey`). Ctrl+Arrow (`isMoveChord`) moves the focused item wherever a drag does. Delete removes the item (with Undo), Home/End/PageUp/PageDown jump (`jumpIndex`). A list is one Tab stop (`rovingRows`), and a module with items answers `NEW_ITEM_EVENT` (Alt+N). A full rebuild goes through `keepRowFocus`, and a commit leaves focus on the row. Anything with a hover-only affordance needs a focus path.
- **Strings** go through `t()` with keys in both locales.

## Style (styles.css)

- **Motion.** `--dur-fast` (hover, reveal), `--dur-base` (entrances, sizing), `--ease`. Hoverable surfaces ease their wash, revealed buttons ease opacity. Dialogs and toasts rise in (toasts also fade out via `leaveToast`); a new popover joins the `tt-pop-in` list; what a layout change reveals joins the `tt-fade-in` list — never animate a size (sidebar, split, calendar, header): ResizeObservers and the split threshold would re-run every frame. List rebuilds animate through `keepRowFocus` (row-motion.ts) with no extra code; pass `{ animate: false }` only when rows can't move alone (the org chart). Reduced motion is the one rule at the end of the file — never add per-rule overrides; JS-driven motion checks `prefers-reduced-motion` itself.
- **Highlights.** `--hover-soft` (large surfaces), `--hover` (compact items, menus, icon buttons), `--selected` (keyboard-selected or current entry, stronger than hover), `--card-hover`. No raw `rgba(var(--accent-rgb), …)` in hover/selected rules.
- **Current item.** Lists: a 3px bar (`--state-bar`) plus `--selected` fill. Tab strips and segmented controls: accent fill.
- **Cards.** Task, risk, milestone and org box share one recipe (panel fill, `--shadow-card`, `--r-md`, `--card-hover`) defined once near the top of the file; new card-like items add `.tt-card` or join that list and keep only their own border, padding and layout.
- **Focus.** Buttons and fields use the global outline ring. Card-like items and list rows inside scroll containers use the one inset ring (`box-shadow: inset 0 0 0 2px …`). Never `outline: none` without it.
- **Spacing.** `--sp-1..4`; list items `--row-pad`, card rows `--card-row-pad`; panes pad `--sp-2` with no divider under the toolbar.
- **Control sizes.** Three height tiers: `--ctl-h-lg` (app header), `--ctl-h` (a pane's bars and toolbars: pane bar, person header, editor and module toolbars), `--ctl-h-sm` (actions inside a row, card or list; 24px, the WCAG 2.2 minimum target). Icon-only buttons are squares: `iconButton()` adds `.tt-btn-icon` (tier 2 by default); a row action joins the tier-3 list beside it in styles.css. No one-off heights or paddings that move a button between tiers.
- **Radii.** `--r-sm/md/lg`, pills (999px), circles (50%), or a hairline of 3px or less. **Colors.** Tokens only; literals live in the palette blocks.
- **Module actions** (labelled buttons in a pane toolbar, the person header, the calendar's Today, an empty pane's add) are `.tt-action` plus exactly one role: `.tt-btn-primary` (solid; the module's one main create action, "+ Risk", at most one per toolbar), `.tt-btn-secondary` (accent outline led by an icon; any other command) or `.tt-btn-quiet` (borderless until hover; changes only the view, like Expand all). Tasks has no primary: tasks are added from each column's dashed "+ Task", a column action.
- **Row actions** rest faint (`opacity: .38`) and reach full strength on row hover or focus; decorative extras may stay hidden.

## Before you finish

1. `npm test -- test/design-rules.test.ts` (and the usual `npm test`, `npm run lint`, `npm run typecheck`).
2. If the guard rejects something you believe is right, the rule may need a new exception: add it to the allowlist in the test **with a one-line reason**, and say so in the commit message. Don't loosen a rule to make a diff pass.
3. When a rule itself changes, update this file and the test together.
