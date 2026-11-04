# Editor undo/redo on snapshots — design

Date: 2026-11-03. Replaces the hybrid shipped in commit 6dc0df5 (native undo + edit journal + paste re-wrap).

## Why

The rich-text editor (`src/ui/editor.ts`) relied on the browser's native undo stack, which only knows edits the browser made itself (execCommand typing, insertHTML, delete). The editor also makes many edits by moving nodes directly: hoisting a pasted fragment out of Chromium's wrapper `<div>`, autoformat (`- `, `# `, `> `, ``` , `---`, `**bold**`), Tab / Shift+Tab on list items, Enter out of a quote or code block, link swap/removal, mention chips, template inserts, clear-formatting, post-`formatBlock` clean-ups. Those are invisible to the browser's stack, so Ctrl+Z did nothing visible or undid the wrong step, and the two drifted apart (first reported as "Ctrl+Z after pasting a bullet list does nothing").

Commit 6dc0df5 patched this with a hybrid: re-wrap pasted nodes around native history steps, plus a MutationObserver journal (`src/ui/editor-history.ts`) that inverts hand-made edits and decides who owns each Ctrl+Z by comparing a structural key of the document. An Opus review found the heuristic fragile (see "Known defects this removes"). Decision: the editor owns one undo/redo stack and never lets the browser undo.

## Goals

- Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y and the Edit/context-menu Undo/Redo all go through one stack owned by the editor instance. The browser's native history is never invoked (the `keydown` and `beforeinput` `historyUndo`/`historyRedo` are always `preventDefault`ed, including when our stack is empty, so a stale native step can never act).
- Every user-visible edit is one undoable step, in order: typing runs, paste, cut, drop, toolbar/shortcut formatting, autoformat, Tab/Shift+Tab, quote/code-block exit, link edit/remove, mention chip, template insert, picture add/delete.
- **Not losing the user's place is the top priority.** Undo/redo restores the caret/selection exactly (top-level block index + text offset, start and end) and the editor's scroll position, and does not rebuild blocks that did not change.
- Delete the mechanisms the hybrid needed: `structureKey`, MutationRecord inversion and replay, `rewrapFlattened` / `FlattenedWrapper` / `reflattenAfterHistory`, the `flattened` list, and the "known limitation" of code-block highlighting and ref relinking (out-of-band DOM rewrites stop mattering because undo never reuses old nodes).
- Keep every fix already shipped; the existing e2e specs for these behaviours are the acceptance suite and must pass unchanged.

## Non-goals / anti-goals

- No persistence of undo history across sessions, notes, or editor rebuilds. A stack lives as long as its editor instance. (Accepted: a module rebuild such as risks' `renderAll` after blur resets the stacks of the rebuilt editors, and a reload of the same note from outside — e.g. the other split pane editing it — clears that editor's stack. Restoring an old whole-note snapshot over newer external edits would lose them, so clearing is the safe behaviour.)
- No cross-editor or global undo. Only the focused editor reacts.
- No change to how notes are saved or to the markdown format.
- Markdown is not the snapshot format (see Snapshot): the saved note format is untouched and the undo stack never goes through it.
- Not a rewrite of the editor's formatting logic. Hand-made edits keep their current implementation; they only gain a `checkpoint()` call.
- Anti-goal: caret or scroll jumping on undo, a picture flickering, one Ctrl+Z undoing a surprising amount of typing, or losing text that was visible.

## Constraints

- Zero runtime dependencies; single-file build; CSP (`script-src` hash only, no `eval`, no inline handlers).
- Desktop Chromium is the target. Tests: vitest/jsdom for units (jsdom has no real contenteditable and stubs `execCommand`), Playwright/Chromium for real behaviour (`e2e/editor.spec.ts`, `e2e/images.spec.ts`).
- Every new `src` module needs a matching `test/*.test.ts`; strings go through `t()` (this feature adds none); styling rules in `CLAUDE.md` unaffected.
- Read-only editors (`setEditorsReadOnly`, tab locked by another tab) do no undo/redo.

## Design

### Snapshot
A snapshot is `{ blocks: string[], selection, scrollTop }`:
- `blocks`: one string per **top-level child** of the editor root: its `outerHTML`, normalized only to keep it small and stable — a picture block (`.tt-img`) is stored without its `<img>` (the data URI), a code block (`<pre>`) without its highlight spans (plain text with `<br>` lines, the shape the editor already uses for the caret's block), and transient attributes the editor adds for presentation are dropped. *Decision (my call, made so the caret comes back exactly):* blocks are stored as DOM HTML, **not** markdown. A markdown round trip trims trailing spaces, turns NBSP into a space, re-labels chips, can split one block into two, and would make the stored text offsets point at the wrong place. Storing the DOM the user actually saw makes restore exact by construction. Restoring parses the string with `DOMParser` (inert document) and adopts the nodes, never `innerHTML` on a live element.
- `selection`: start and end as `{ block: top-level index, offset: text offset inside that block }`, measured on the same stored HTML's text (so restore maps it back 1:1), using the existing text-offset helpers in `src/ui/editor-dom.ts`. A null selection is allowed.
- `scrollTop` of the editor element.
Snapshots are plain data; at most ~100 undo entries per editor (oldest dropped).

### Stacks and when a "before" snapshot is stored
Only the state **before** a step is stored. `undo()` takes the live document as a new snapshot (pushed to the redo stack), then restores the newest undo entry. `redo()` mirrors it. Any new step clears the redo stack. Entries identical to the current document are skipped on undo/redo (a no-op hand-made edit, e.g. Tab on the first list item, therefore costs nothing and cannot waste a key press).

One user action is exactly one step. *Decision (my call):* every action site calls an explicit `history.checkpoint()` **before its first change to the document**, native or manual, and a checkpoint is a no-op while that action's step is still open (the step stays open until the end of the current synchronous task; a microtask resets it). That makes a toolbar click that runs `execCommand('formatBlock')` and then a clean-up (`flattenNestedHeadings`, `normalizeFlatBlockChildren`, `demote*`) one step, not two or three, and the first undo never lands on a half-done document. The `edit(...)` wrapper becomes this checkpoint-then-run. Sites: all current `edit(...)` sites, the `exec()` helper, the toolbar/shortcut commands that call `execCommand` directly (`formatBlockTag`, `toggleBlockquote`, `toggleCodeBlock`, `clearFormatting`, `insertList`, link, picture add/delete), and the paste, cut, drop and template handlers (they call `execCommand('insertText'|'insertHTML'|'delete')` from their own handlers, so their `beforeinput` may look like plain typing and must not be left to `inputType` alone).

The step boundaries are therefore:
1. Before a hand-made or command-driven edit, via the explicit checkpoint above. Hand-made edits that run inside `onInput` right after native typing (autoformat) get their own step, and undo returns to the text as typed (e.g. `- `), as the journal does today.
2. A safety net for native edits that have no explicit checkpoint (browser-initiated: spellcheck replacement, drag-drop of text, browser context-menu formatting): `beforeinput` with an `inputType` other than plain typing/deleting opens a step if none is open.
3. Typing runs. The first `insertText`/`insertCompositionText`/`deleteContent*` after a boundary opens a run (before-snapshot stored). The run closes on: ~1 s without input, a change of kind (typing vs backspace/delete), Enter, a caret move not caused by the typing itself (`selectionchange` with no matching input), editor blur, or any boundary above. IME composition is one run, never split mid-composition.
4. **Enter is its own step** (my call; the browser-like behaviour): typing `ab`, Enter, `cd` undoes to `ab⏎`, then `ab`, then empty. Enter at the end of a list item, quote or code block is checkpointed like any other action (the quote/code-block exit already goes through a hand-made edit).
5. Before undo/redo themselves, the run is closed.

Snapshot cost is O(document), the same order as the existing 300 ms debounced `getMd`, and it runs at run starts, not per keystroke.

### Undo / redo restore
1. Close any open run; snapshot the live document (into the opposite stack).
2. Diff `blocks` by string equality: keep the common prefix and common suffix of unchanged blocks untouched (same DOM nodes), and replace only the middle range with nodes parsed from the stored HTML. Unchanged blocks keep their nodes, so scroll, spellcheck state and rendered pictures are untouched.
3. Re-run the post-restore passes on the replaced blocks only: code-block decoration/highlight sync, picture hydration (cached data URIs avoid flicker), chip label refresh (`refreshRefLabels`, so a restored chip shows the current label), flat-block shape (`flattenTopLevelBlockWrappers`) if needed.
4. Restore the selection from block index + offset, restore `scrollTop`, then `scheduleChange()` so the store receives the restored markdown. Offsets are exact except where step 3 changed a chip's label length, in which case the offset is clamped to the block.
5. Never run autoformat or open pickers on the restored text (the existing `fromHistory` guard in `onInput` stays; with browser history disabled it only matters for programmatic cases).

### Interception
`keydown` on the editor (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y, layout-independent via the existing `matchKey`) and `beforeinput` (`historyUndo`, `historyRedo`, for the context/Edit menu) both `preventDefault` and call `undo()`/`redo()`. The editor's read-only guard comes first. Because handlers are on the editor element, only the focused editor reacts; in pages with several editors (risks follow-ups, the action-item card modal) and in split view each editor instance has its own stack and its own keys.

### Lifecycle
`setMd(md)` (initial load and any reload from the store) clears both stacks; `destroy()` clears and drops everything. A hand-made edit made by another file (`atref.ts`, `template-picker.ts`) reaches the right editor's `checkpoint()` through the existing per-root registry (`registerEditHistory` / `recordEdit` keep their purpose; `recordEdit` becomes checkpoint-then-run).

### What stays from commit 6dc0df5
- `convertBlockToHeading` and the Ctrl+1..3-on-blank-line change (typing `# ` under a line no longer turns the line above into the heading).
- Ctrl+X through `execCommand('delete')` with the manual fallback for jsdom (add a checkpoint before it).
- `flattenTopLevelBlockWrappers` itself (the editor still needs the flat shape after a paste); only its returned list, `rewrapFlattened` and the re-wrap/re-flatten around history go.
- Skipping autoformat and pickers for history inputs.
- All e2e specs added in 6dc0df5 and the paste/undo specs; unit tests for the removed pieces (`rewrapFlattened`, `structureKey`, journal inversion) are deleted with them.

## Known defects this removes (from the review of 6dc0df5)
Wrong undo order when the document returns to a recorded key through typing + Backspace; one unreachable entry blocking all older ones; `<pre>` keying changing with highlighting alone; undo duplicating content when recorded nodes were swapped out; redo wiped by a no-op edit; the `flattened` list never cleared by `setMd`; autoformat firing after a cut (decide below); the code-block highlight and chip-relabel limitations.

## Open points left to the builder (with my default)
- Cut then autoformat: after `execCommand('delete')` the input handler runs autoformat on the remaining line. Default: leave as is (Backspace behaves the same).
- Exact idle threshold (default 1 s), and whether a word boundary should also end a run (default: no).
- Where the code lives: default one module `src/ui/editor-history.ts` (stack, snapshot, diff-restore, run policy) with a small interface (`checkpoint`, `undo`, `redo`, `clear`, `onBeforeInput`/`onKeydown` helpers), and the editor supplies `takeSnapshot`/`restoreBlocks` callbacks, so it unit-tests without a browser.
- Collapsed code-block state and other transient view state are not part of a snapshot; default: not preserved.

## Test plan (acceptance)
- Unchanged and passing: `e2e/editor.spec.ts` (paste undo/redo cases, autoformat, Tab, quote exit, cut, chain) and `e2e/images.spec.ts`; full e2e suite; lint/typecheck/unit.
- New e2e: Tab, type, Backspace, Ctrl+Z order (the reviewer's repro); typing run coalescing (type, pause, type, undo twice); caret and `scrollTop` unchanged after undoing an edit far from the caret in a long note; two editors on one page (risks follow-ups) — Ctrl+Z only affects the focused one; undo in a split pane does not touch the other pane; reload of the note from outside clears the stack; Ctrl+Y; Edit-menu path (`execCommand('undo')`); undo with an empty stack does nothing (native never acts); paste, Tab-indent a pasted item, undo all the way and redo all the way; undo across a highlighted code block and across a chip relabel; mention chip and template insert undo/redo; picture add/delete undo with no flicker.
- New e2e for caret exactness: type a word and a trailing space at the end of a line, pause, type more, undo — the caret returns to the exact spot after the space; one toolbar click (heading, quote, code block, clear formatting) is a single Ctrl+Z; Enter is its own step.
- Units: snapshot/restore round trip per block type; block diff (prefix/suffix, insert, delete, replace); no-op entry skipping; redo cleared by a new step; cap of 100; selection clamp; read-only inert.
- Performance guard: snapshot and restore of a 1,500-line note stay within the budget already used for the large paste test.
