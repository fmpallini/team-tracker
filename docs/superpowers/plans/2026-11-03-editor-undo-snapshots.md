# Editor undo on snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the editor's hybrid undo (native stack + MutationObserver journal + paste re-wrap) with one stack the editor owns, built on per-block HTML snapshots, so every edit is undoable in order and Ctrl+Z never loses the user's place.

**Architecture:** `editor-snapshot.ts` takes and restores snapshots (per top-level block HTML, exact caret, scroll) replacing only the blocks that differ. `editor-undo.ts` owns the undo/redo stacks and the step policy (explicit `checkpoint()`, typing runs). `editor.ts` always `preventDefault`s native history, calls `checkpoint()` before every edit, and loses the journal and the paste re-wrap.

**Tech Stack:** TypeScript, DOM (`DOMParser`, `MutationObserver`), vitest/jsdom, Playwright/Chromium. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-03-editor-undo-snapshots-design.md` (read it first; decisions marked "my call" there are binding).

## Global Constraints

- Zero runtime dependencies; single-file build, CSP: no `eval`, no inline `on*` handlers.
- Desktop Chromium only; jsdom stubs `document.execCommand` (returns `false`) and has no real contenteditable.
- Every new `src` module needs a matching `test/*.test.ts`; user-visible strings go through `t()` (this feature adds none).
- Commit on `dev` directly, no branches/worktrees; every commit message ends with the attribution trailer from the session reminder. No version bump, so no CHANGELOG entry.
- Native history is never invoked: `keydown` and `beforeinput` `historyUndo`/`historyRedo` are always `preventDefault`ed (not when the editor is read-only).
- Undo stack cap: 100 entries per editor. Typing-run idle close: 1000 ms.
- Existing e2e specs in `e2e/editor.spec.ts` and `e2e/images.spec.ts` are the acceptance suite and must pass unchanged.

## Review Focus

- Ctrl+Z in a just-loaded note with nothing to undo does nothing and never lets the browser's stale native stack act or move the caret (Task 2 unit, Task 5 e2e).
- Large note (1,500+ lines) and the 100-entry cap: snapshot/undo stay within the existing large-paste time budget and memory stays bounded (Task 2 cap test, Task 5 e2e).
- Undo while a picture is still loading, or restoring a picture block: no stray or duplicate `<img>`, no error (Task 5 e2e).
- Selection edge shapes: caret in a nested `<li>`, selection across blocks, caret in a `<pre>` whose lines are `<br>`-separated vs `\n` text, caret after a trailing space (Task 1 units).
- A typing run that spans blur/focus, IME composition, or a second editor on the page: Ctrl+Z only affects the focused editor and never splits a composition (Task 2 units, Task 5 e2e).

---

## File structure

- Create `src/ui/editor-snapshot.ts` — pure snapshot/restore/selection helpers. Test: `test/editor-snapshot.test.ts`.
- Create `src/ui/editor-undo.ts` — stacks, step policy, key/`beforeinput` handling, per-root registry. Test: `test/editor-undo.test.ts`.
- Modify `src/ui/editor.ts` — wire it in, delete the journal and paste re-wrap.
- Modify `src/ui/atref.ts`, `src/ui/template-picker.ts` — import `recordEdit` from `./editor-undo`.
- Delete `src/ui/editor-history.ts` and `test/editor-history.test.ts` (Task 3).
- Create `e2e/editor-undo.spec.ts` (Task 5); extend `e2e/editor.spec.ts` (Task 4).

### Task 1: Snapshot module

**Files:**
- Create: `src/ui/editor-snapshot.ts`
- Test: `test/editor-snapshot.test.ts`

**Interfaces:**
- Produces:
  - `interface BlockPos { block: number; offset: number }`
  - `interface Snapshot { blocks: string[]; selection: { start: BlockPos; end: BlockPos } | null; scrollTop: number }`
  - `takeSnapshot(root: HTMLElement): Snapshot`
  - `sameBlocks(a: Snapshot, b: Snapshot): boolean` (blocks only; selection/scroll ignored)
  - `restoreSnapshot(root: HTMLElement, target: Snapshot): HTMLElement[]` — diffs the live document (taken internally) against `target.blocks`, keeps the common prefix/suffix nodes untouched, replaces only the middle with nodes parsed from `target`, restores selection and `root.scrollTop`, returns the newly inserted top-level elements.
- Consumes: `preLines` from `src/core/markdown.ts`.

- [ ] **Step 1: Write the failing tests** in `test/editor-snapshot.test.ts` (root = a `div` appended to `document.body`):
  - `takeSnapshot` returns one string per element child, in order.
  - A `.tt-img` block is stored with no children and no `data-img-loading`; a `<pre>` with `<span class="hl-kw">` highlight spans is stored as one text node of `preLines(pre).join('\n')` (an empty `<pre>` as `<br>`); `data-collapsed` and the pre's `spellcheck`/`autocorrect`/`autocapitalize` attributes are dropped; any `on*` attribute is dropped.
  - Selection: caret in a nested `<li>` → `{block: topLevelIndex, offset}`; collapsed caret after `"word "` stores offset 5; a selection from block 0 to block 2; a `<pre>` caret with `aa<br>bb` stores offset 3 after `bb`'s first char and the same text as `aa\nbb` plain gives the same offset; container === root maps to `{block: min(offset, n-1), offset: 0}`; selection outside root → `null`.
  - `restoreSnapshot`: unchanged prefix/suffix blocks keep node identity (`===`); insert, delete, replace-in-the-middle and replace-everything cases produce the target's `blocks`; returns exactly the new elements; the caret returns to `{block, offset}` exactly (including after a trailing space and inside a nested `<li>`, and a `<pre>` restored from plain text); `scrollTop` restored; restoring the current document is a no-op returning `[]`; an out-of-range offset is clamped.
  - Restore never executes markup: parsing goes through `DOMParser` (assert `document.body` gains no `<script>` and the call works for a block string containing `<img src=x onerror=...>`, whose `onerror` attribute must be absent in the result).

- [ ] **Step 2: Run** `npx vitest run test/editor-snapshot.test.ts` — expect FAIL (module missing).

- [ ] **Step 3: Implement `editor-snapshot.ts`.** Offsets are measured with a helper pair `offsetInBlock(block, node, offset): number` / `pointInBlock(block, offset): {node: Node; offset: number}` that walk text nodes and count a `<br>` inside a `<pre>` as one character (newline); for every other block `<br>` counts 0, matching `textContent`. Do not reuse `rangeForTextOffsets` (it ignores `<br>` in `<pre>`). Normalize clones, never the live nodes. Parse the replaced middle once: `new DOMParser().parseFromString('<body>' + joined + '</body>', 'text/html')`, then `document.importNode` each child.

- [ ] **Step 4: Run** the test file — expect PASS; run `npm run typecheck` and `npx eslint src/ui/editor-snapshot.ts test/editor-snapshot.test.ts`.

- [ ] **Step 5: Commit** (`feat(editor): block snapshots with exact caret restore`).

### Task 2: Undo stack and step policy

**Files:**
- Create: `src/ui/editor-undo.ts`
- Test: `test/editor-undo.test.ts`

**Interfaces:**
- Consumes: `takeSnapshot`, `restoreSnapshot`, `sameBlocks`, `Snapshot` from Task 1.
- Produces:
  - `interface UndoDeps { root: HTMLElement; afterRestore(replaced: HTMLElement[]): void; onChange(): void; isReadOnly(): boolean }` (`afterRestore` is where the editor re-runs code-block decoration, highlight sync, picture hydration, `refreshRefLabels`; `onChange` is `scheduleChange`)
  - `interface UndoStack { checkpoint(): void; undo(): boolean; redo(): boolean; handleKeydown(e: KeyboardEvent): boolean; handleBeforeInput(e: InputEvent): void; noteSelectionChange(): void; closeRun(): void; clear(): void; destroy(): void }`
  - `createUndoStack(deps: UndoDeps): UndoStack`
  - `registerUndo(root: HTMLElement, u: UndoStack): void`, `unregisterUndo(root: HTMLElement): void`, `recordEdit<T>(root: HTMLElement, fn: () => T): T` (checkpoint then run on the registered stack, or just run).
- Semantics (from the spec): `checkpoint()` stores a *pending* before-snapshot and is a no-op while a step is open (open until the end of the current task: close it with `queueMicrotask`). The pending snapshot is committed to the undo stack (and the redo stack cleared) only when a `MutationObserver` (childList + characterData, subtree) sees the document change; an edit that changes nothing leaves no entry and keeps redo. `undo()`/`redo()` close the run, take the live snapshot into the opposite stack, skip entries whose blocks equal the live ones, restore, then call `afterRestore(replaced)` and `onChange()`; they return `true` whenever the editor handled the request (even with nothing to undo) unless read-only. `handleBeforeInput` opens a typing run on `insertText`/`insertCompositionText`/`deleteContent*` and closes it on an input-kind change, on Enter (`insertParagraph`/`insertLineBreak` is its own step), and on 1000 ms idle; any other `inputType` opens a step if none is open. `noteSelectionChange` closes the run when the caret moved by something other than the typing itself. `handleKeydown` handles Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y (layout-independent via `e.code`/`e.key`), calls `preventDefault`, returns whether it handled.

- [ ] **Step 1: Write the failing tests** in `test/editor-undo.test.ts` (fake timers; root with a few `<div>`s; mutate the DOM directly to stand in for edits; `await Promise.resolve()` to flush the observer/microtask):
  - checkpoint → mutate → `undo()` restores; `redo()` replays; both return `true`.
  - Two `checkpoint()` calls in one synchronous task make one step.
  - A checkpoint followed by no mutation creates no entry and does not clear an existing redo stack.
  - Three `insertText` `beforeinput`s with mutations in between are one step; after `vi.advanceTimersByTime(1000)` the next one is a new step; a `deleteContentBackward` after typing is a new step; `insertParagraph` is its own step and typing after it is another; an `insertCompositionText` sequence is one step.
  - `noteSelectionChange` after a caret jump closes the run; `closeRun` closes it.
  - `undo()` with an empty stack returns `true` and leaves the document untouched.
  - After 101 committed steps only 100 undos are possible.
  - Entries identical to the live document are skipped (a no-op committed step costs no key press).
  - `isReadOnly() === true` → `handleKeydown` returns `false` and nothing changes.
  - `handleKeydown` returns `true` and calls `preventDefault` for Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, and `false` for other keys.
  - `clear()`/`destroy()` empty both stacks and stop the observer; `recordEdit` runs plainly for an unregistered root and checkpoints for a registered one.
  - Two roots with two stacks do not affect each other.

- [ ] **Step 2: Run** `npx vitest run test/editor-undo.test.ts` — expect FAIL.
- [ ] **Step 3: Implement `editor-undo.ts`** exactly to the semantics above. Idle timer uses `setTimeout` (fake-timer friendly).
- [ ] **Step 4: Run** the tests, typecheck, eslint on both files — expect PASS.
- [ ] **Step 5: Commit** (`feat(editor): undo stack with step policy`).

### Task 3: Swap the editor over

**Files:**
- Modify: `src/ui/editor.ts`, `src/ui/atref.ts`, `src/ui/template-picker.ts`, `test/editor.test.ts`
- Delete: `src/ui/editor-history.ts`, `test/editor-history.test.ts`

**Interfaces:**
- Consumes: `createUndoStack`, `registerUndo`, `unregisterUndo`, `recordEdit` (Task 2).
- Produces: in `editor.ts`, `const undoStack = createUndoStack({...})`; `edit<T>(fn: () => T): T` = `undoStack.checkpoint(); return fn()`; every later task adds checkpoints through these two names. `flattenTopLevelBlockWrappers(root: HTMLElement): void` (returns nothing again).

- [ ] **Step 1: Update the tests first.** In `test/editor.test.ts` change the `flattenTopLevelBlockWrappers` tests to the `void` return and delete the two `rewrapFlattened` tests. Delete `test/editor-history.test.ts`. Run `npx vitest run test/editor.test.ts` — expect FAIL on the removed API only after Step 2 starts; run the e2e baseline now: `npm run build && npx playwright test e2e/editor.spec.ts e2e/images.spec.ts` — expect PASS (the "before" reference).
- [ ] **Step 2: Rewire `editor.ts`.**
  - Remove: the `editor-history` import, `history`/`registerEditHistory`/`unregisterEditHistory`, `flattened`, `flattenPaste` (inline `flattenTopLevelBlockWrappers(editorEl)` back at its three call sites), `reflattenAfterHistory`, `FlattenedWrapper`, `rewrapFlattened`, the re-wrap branch of `onBeforeInput`, and the `fromHistory` branch that called them.
  - Create the stack in `createEditor` with `afterRestore = (els) => { decorateCodeBlocks(true); syncPreHighlight(); hydrateImages(); refreshRefLabels() }` (builder: restrict to `els` where cheap), `onChange = scheduleChange`, `isReadOnly = () => editorsReadOnly`; `registerUndo(editorEl, undoStack)`; `unregisterUndo` in `destroy()`.
  - `onKeydown`: first thing after the read-only guard, `if (undoStack.handleKeydown(e)) return`.
  - `onBeforeInput`: for `historyUndo`/`historyRedo` call `undoStack.undo()`/`redo()` and `preventDefault()` (when not read-only); otherwise `undoStack.handleBeforeInput(e)`.
  - `setMd`: `undoStack.clear()`. `onEditorBlur`: `undoStack.closeRun()`. The shared `selectionchange` dispatcher (`onDocumentSelectionChange` / registry entry) calls `undoStack.noteSelectionChange()` for the editor that owns the caret.
  - `edit` becomes `undoStack.checkpoint()` then `fn()`. Add an explicit `undoStack.checkpoint()` before the first change in `exec()`, `onPaste` (all three insert paths), `insertMarkdown`, `onCut`, `onDrop`/`addImages`, `pasteWithImages`, and `removeSelectedImage` (native delete).
- [ ] **Step 3: Point `atref.ts` and `template-picker.ts`** at `recordEdit` from `./editor-undo`; delete `src/ui/editor-history.ts`.
- [ ] **Step 4: Verify.** `npm run typecheck`, `npx eslint src test`, `npx vitest run` (all pass), then `npm run build && npx playwright test e2e/editor.spec.ts e2e/images.spec.ts` — every spec from before still passes unchanged (paste undo/redo, autoformat, Tab, quote exit, cut, chain, picture).
- [ ] **Step 5: Commit** (`refactor(editor): undo owned by snapshot stack, drop journal and paste re-wrap`).

### Task 4: Every command is one step

**Files:**
- Modify: `src/ui/editor.ts`
- Test: `e2e/editor.spec.ts`

**Interfaces:**
- Consumes: `undoStack.checkpoint()` from Task 3.

- [ ] **Step 1: Write the failing e2e tests** (new `describe('one command is one undo step')` in `e2e/editor.spec.ts`, using the existing `openEditor`/`clearEditor` helpers). For each command, build a baseline (`before` Enter `line`), run the command, press Ctrl+Z **once**, assert `innerHTML` equals the baseline and Ctrl+Shift+Z reapplies it: heading (Ctrl+2 on `line`), blockquote (Ctrl+Shift+9), code block (Ctrl+Shift+E), bulleted list (Ctrl+Shift+8), bold (Ctrl+B on a selected word), clear formatting (toolbar broom on a bold+heading line), link (Ctrl+K, fill the modal), horizontal rule button.
- [ ] **Step 2: Run** `npx playwright test e2e/editor.spec.ts -g "one command"` — expect FAIL (some commands take two presses).
- [ ] **Step 3: Add `undoStack.checkpoint()`** before the first native call in `formatBlockTag`, `toggleBlockquote`, `toggleCodeBlock`, `clearFormatting`, `insertList`, `applyBlockFormat`, `insertLink` (both the remove, swap and insert branches), `insertHr`, and every toolbar action that calls `execCommand` directly (grep `execCommand(` in `editor.ts`; any call not already behind `exec()` or a checkpoint gets one). The step-open guard from Task 2 makes the later `edit(...)` clean-ups part of the same step.
- [ ] **Step 4: Run** the new tests plus the full `e2e/editor.spec.ts` — expect PASS.
- [ ] **Step 5: Commit** (`fix(editor): one toolbar or shortcut command is one undo step`).

### Task 5: Acceptance specs, docs, full gate

**Files:**
- Create: `e2e/editor-undo.spec.ts`
- Modify: `CLAUDE.md` (one convention line), stale comments in `src/ui/editor.ts`

- [ ] **Step 1: Write `e2e/editor-undo.spec.ts`** (reuse the helpers from `e2e/editor.spec.ts`; extract into `e2e/helpers.ts` only if that avoids duplication) with these tests:
  - Order repro: `- a` Enter `b`, Tab, type `x`, Backspace; Ctrl+Z undoes the typing run, then the Tab, in that order, never resurrecting `x`.
  - Typing runs: type `one`, wait 1.2 s, type `two`, Ctrl+Z removes only `two`; `ab` Enter `cd` undoes to `ab⏎`, `ab`, empty.
  - Caret exactness: type `word ` (trailing space), pause, type more, Ctrl+Z → caret offset equals 5 in that block; and `scrollTop` unchanged after undoing an edit made far from the caret in a long note.
  - Empty stack: open a fresh note, Ctrl+Z several times → content, caret and `scrollTop` unchanged.
  - Two editors on one page (risks follow-up rows or the action-item modal, whichever the builder finds simplest): Ctrl+Z only affects the focused editor; undo in one split pane never touches the other pane; an outside reload of the note (edit it from the other pane) clears the stack.
  - Ctrl+Y redoes; the Edit-menu path (`page.evaluate(() => document.execCommand('undo'))`) goes through the same stack.
  - Paste a bullet list, Tab-indent a pasted item, undo all the way and redo all the way.
  - Highlighted code block: type code, move the caret out (highlight runs), type elsewhere, undo twice — the code text and the other text come back in order (the old known limitation).
  - Chip relabel then undo does not duplicate or lose text; mention chip and template insert undo/redo.
  - Picture: paste a picture, undo, redo (no duplicate `<img>`, no console error); undo immediately while the picture is still loading.
  - Performance: a 1,500-line note — one edit then Ctrl+Z finishes within the same time budget the existing large-paste spec uses.
- [ ] **Step 2: Run** `npx playwright test e2e/editor-undo.spec.ts` — fix any failure in the code (not by loosening the test); these may expose gaps in Tasks 2–4.
- [ ] **Step 3: Docs.** Add one line to `CLAUDE.md` Conventions: *Any new editor edit that changes the document must call `undoStack.checkpoint()` (or go through `edit()`/`recordEdit()`) before its first change; undo is the editor's own snapshot stack, native history is disabled.* Update comments in `editor.ts` that still mention the journal, the paste re-wrap or native undo.
- [ ] **Step 4: Full gate.** `npm run typecheck`, `npx eslint src test`, `npx vitest run`, `npm run test:e2e` — all pass.
- [ ] **Step 5: Commit** (`test(editor): undo acceptance specs; document the checkpoint rule`).
