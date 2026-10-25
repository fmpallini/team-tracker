---
name: ui-consistency
description: Use when adding or changing any screen, dialog, button, list row, card, hover/focus state, animation or spacing in src/ui, src/modules or styles.css — the app's UI rules, the tokens to use, and the guard test that enforces them.
---

# UI consistency

The app's screens agree on a small set of rules. Reuse the helper or token instead of writing a new variant; `test/design-rules.test.ts` fails the build when a rule is broken (it runs in pre-push and CI). The rules in short — `CLAUDE.md` (Conventions) is the prose version.

## Behavior

- **Edit surface.** Rich or many-field entities (task, risk, milestone) autosave as you type, in a modeless dialog or an inline row, closed with Close/Escape — never Cancel. Small forms (person, team, template, tag names, link) are Cancel/Save dialogs where Cancel discards. A picker's confirm button reads its verb (Copy, Move). Only the password prompt says OK.
- **Delete.** One item is never confirmed: delete it with an Undo toast (`createEntityDelete`, `deleteInTeamWithUndo` + `offerUndoToast`). Bulk or irreversible deletes (team, clear zone, delete all closed, column with cards, data cleanup) use `confirmDelete` (always danger-styled; say "cannot be undone" in `warning` when there is no Undo). Never the browser `confirm()`.
- **Feedback.** A change the user cannot see happen (move, copy, duplicate to another team) gets a toast; a move gets an Undo.
- **Names.** Missing name: "Name is required" in a dialog field, "This {thing} needs a name." on an inline row or card. Items are called by one word everywhere (tasks, not cards or actions).
- **Icon-only buttons** go through `iconButton()` in `ui/icons.ts` (sets `title` and `aria-label` from one string); re-label with `setIconButtonTitle()` on a locale switch.
- **Keyboard.** Card-like rows take arrows, Enter (open the full view) and, where a menu exists, Space (the context menu). Anything with a hover-only affordance needs a focus path.
- **Strings** go through `t()` with keys in both locales.

## Style (styles.css)

- **Motion.** `--dur-fast` (hover, reveal), `--dur-base` (entrances, sizing), `--ease`. Hoverable surfaces ease their wash, revealed buttons ease opacity. Reduced motion is the one rule at the end of the file — never add per-rule overrides.
- **Highlights.** `--hover-soft` (large surfaces), `--hover` (compact items, menus, icon buttons), `--selected` (keyboard-selected or current entry, stronger than hover), `--card-hover`. No raw `rgba(var(--accent-rgb), …)` in hover/selected rules.
- **Current item.** Lists: a 3px bar (`--state-bar`) plus `--selected` fill. Tab strips and segmented controls: accent fill.
- **Cards.** Task, risk, milestone and org box share one recipe (panel fill, `--shadow-card`, `--r-md`, `--card-hover`) defined once near the top of the file; new card-like items add `.tt-card` or join that list and keep only their own border, padding and layout.
- **Focus.** Buttons and fields use the global outline ring. Card-like items and list rows inside scroll containers use the one inset ring (`box-shadow: inset 0 0 0 2px …`). Never `outline: none` without it.
- **Spacing.** `--sp-1..4`; list items `--row-pad`, card rows `--card-row-pad`; panes pad `--sp-2` with no divider under the toolbar.
- **Radii.** `--r-sm/md/lg`, pills (999px), circles (50%), or a hairline of 3px or less. **Colors.** Tokens only; literals live in the palette blocks.
- **Row actions** rest faint (`opacity: .38`) and reach full strength on row hover or focus; decorative extras may stay hidden.

## Before you finish

1. `npm test -- test/design-rules.test.ts` (and the usual `npm test`, `npm run lint`, `npm run typecheck`).
2. If the guard rejects something you believe is right, the rule may need a new exception: add it to the allowlist in the test **with a one-line reason**, and say so in the commit message. Don't loosen a rule to make a diff pass.
3. When a rule itself changes, update this file, `CLAUDE.md` and the test together.
