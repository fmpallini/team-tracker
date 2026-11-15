# 1:1 Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** This plan adds three things for 1:1s:
- checklist items in every note editor;
- a "New 1:1" button on the person page, which carries open items forward;
- a cadence per person, which feeds the due panel, the org chart and dots on the module selector.

**Architecture:**
- **Markdown:** a bullet whose text starts with `[ ] `, `[x] ` or `[>] ` becomes `<li data-task="open|done|carried">`. The checkbox is drawn by CSS.
- **Pure core logic:** the carry-over and template build lives in `core/one-on-one.ts` and works on markdown. The cadence rule lives in `core/cadence.ts`, and `core/due.ts` consumes it.
- **Editor:** the editor gains an undoable `replaceMd`. The person page builds the new markdown from `editor.getMd()` and swaps it in as one undo step.
- **Schema:** schema 20 adds the optional `Person` fields and two prefs.

**Tech Stack:**
- TypeScript, with no runtime dependencies.
- vitest + jsdom for unit tests; Playwright for e2e.
- esbuild for the single-file build.

**Spec:** `docs/superpowers/specs/2026-11-13-one-on-one-flow-design.md`. Read it alongside this plan. Mockups: https://claude.ai/artifact/CqTRZP1ocdc2JvEjNxd2Z4

## Global Constraints

- **Dependencies:** zero runtime dependencies. The CSP forbids inline handlers, so wire events with `addEventListener` or `el()`'s `on*` props, never with HTML attributes.
- **Strings:** every user-visible string goes through `t()`, with keys added for both `pt-BR` and `en-US` in `src/core/i18n.ts`.
- **Design rules:** `test/design-rules.test.ts` must pass, and the `ui-consistency` skill must be loaded for every UI task.
  - Icon-only buttons go through `iconButton()`.
  - Use the style tokens, not literals.
- **Undo:** every editor change to the document calls `undoStack.checkpoint()`, `edit()` or `recordEdit()` before its first change.
- **Tests:** every new `src` module gets a `test/<name>.test.ts`.
- **Notes editor:** it never rebuilds its content from the store. The New 1:1 edit goes through the open editor.
- **Schema:** `SCHEMA_VERSION` 19 → 20, with `MIGRATIONS[19]`.
- **Running tests:** run vitest from `cd 'C:/Users/fmpal/vcup4'` (uppercase drive letter). A lowercase `c:` cwd makes every suite fail with "failed to find the current suite".
- **Git:** commit on `dev` directly. No branches, no worktrees.
- **Commit message trailer:** end every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Full gate before the final commit:**
  - `npm run lint`
  - `npm run typecheck`
  - `npm test`
  - `npm run test:e2e`

## Review Focus

These failure modes are not exercised by the happy-path tests. Each one has its pinning test in the task named.

1. **Nested open tasks are carried twice.** When an open task inside a carried subtree is left `open` in the original, the next New 1:1 collects it again. Expected: every open task inside a carried subtree is also marked `carried` in the original. Pinned in Task 6: `marks nested open tasks carried too`.
2. **Task syntax inside a fenced code block or an ordered list.** `- [ ] x` inside a fence, and `1. [ ] x`, are not tasks: not parsed, not carried, not marked. Pinned in Task 1 and Task 6.
3. **A plain bullet whose text starts with `[ ]`.** It must reload as plain text and never become a task. Pinned in Task 1: `plain bullet starting with [ ] round-trips as text`.
4. **A malformed `lastOneOnOne` or `oneOnOneEveryDays`** (from a hand-edited plain file). The person is never due, and nothing throws. Pinned in Task 5: `ignores malformed cadence fields`.
5. **The New 1:1 template was deleted, or has no `{carryover}`.** The block still gets a heading, and the carried items appear right after the block's first line. Pinned in Task 6.

---

### Task 1: Markdown task items

**Files:**
- Modify: `src/core/markdown.ts`:
  - `mdToHtml` `addListItem` and the `ul` branch (~L269–L363);
  - `renderListMd` (~L884);
  - `renderListText` (~L968).
- Test: `test/markdown.test.ts`

**Interfaces:**
- Produces: `export type TaskState = 'open' | 'done' | 'carried'`.
- Produces: `export const TASK_PREFIX = /^\[( |x|X|>)\](?: (.*))?$/`. It matches the text after `- `.

- [ ] **Step 1: Write the failing tests**

```ts
test('task items parse to li[data-task]', () => {
  expect(mdToHtml('- [ ] a\n- [x] b\n- [X] c\n- [>] d\n- e')).toBe(
    '<ul><li data-task="open">a</li><li data-task="done">b</li><li data-task="done">c</li><li data-task="carried">d</li><li>e</li></ul>')
})
test('task items round-trip, nested, any depth', () => {
  const md = '- [ ] a\n  - [x] b\n    - c\n- [>] d'
  expect(roundTrip(md)).toBe(md)            // roundTrip = htmlToMd(parse(mdToHtml(md))), the file's existing helper
})
test('[X] serializes back as [x]', () => expect(roundTrip('- [X] a')).toBe('- [x] a'))
test('empty open task round-trips', () => expect(roundTrip('- [ ] ')).toBe('- [ ] '))
test('ordered items are never tasks', () => expect(mdToHtml('1. [ ] a')).not.toContain('data-task'))
test('fenced task text stays literal', () => expect(mdToHtml('```\n- [ ] a\n```')).not.toContain('data-task'))
test('plain bullet starting with [ ] round-trips as text', () => {
  // A plain <li> whose text is "[ ] x" (no data-task) — escapeInline already writes \[ \]
  const md = htmlToMd(parse('<ul><li>[ ] x</li></ul>'))
  expect(md).toBe('- \\[ \\] x')
  expect(mdToHtml(md)).not.toContain('data-task')
})
test('plain-text copy shows task state', () => {
  expect(htmlToPlainText(parse(mdToHtml('- [ ] a\n- [x] b\n- [>] c')))).toBe('☐ a\n☑ b\n↪ c')
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run test/markdown.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement**
  - **Parsing:** `addListItem` gains a `task: TaskState | null` parameter, which emits `<li data-task="…">`. In the `ul` branch, match `TASK_PREFIX` against `ul[2]`:
    - ` ` → `open`;
    - `x` or `X` → `done`;
    - `>` → `carried`.
    - The item HTML comes from the remainder (`m[2] ?? ''`). It goes through the same `blockInline(preserveIndent(…))` call as now.
  - **Markdown out:** in `renderListMd`, for a `ul` `<li>` with a valid `data-task`, the first line's prefix becomes:
    - `- [ ] ` for open;
    - `- [x] ` for done;
    - `- [>] ` for carried.
  - **Plain text out:** `renderListText` prefixes the first line with `☐ `, `☑ ` or `↪ `.
  - **Ignore:** an `ol` `<li>` with `data-task` is serialized as a plain item.

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run test/markdown.test.ts test/markdown-fuzz.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(markdown): - [ ] / [x] / [>] task list items`

---

### Task 2: Checklists in the editor

**Files:**
- Modify: `src/ui/editor.ts`:
  - `detectBlockPrefix` (~L178);
  - `handleAutoFormat` (~L1116);
  - the `SHORTCUTS` table (~L1824);
  - `onKeydown`;
  - `onClick` (~L2383);
  - `onInput`;
  - the toolbar (~L2497);
  - the editor root setup.
- Modify: `src/ui/icons.ts` (add a `checklist` icon), `styles.css` and `src/core/i18n.ts`.
- Test: `test/editor.test.ts`
- Test: `e2e/editor.spec.ts`. Read `e2e/CLAUDE.md` first.

**Interfaces:**
- Consumes: `TaskState` from Task 1.
- Produces (internal to `createEditor`): `toggleTask(li: HTMLElement): void` and `makeTask(): void`.

These are the decisions the spec left to the builder:

- **One key.** `Ctrl+Enter` acts on every `<li>` the selection touches:
  - a plain bullet → `open`;
  - `open` → `done`;
  - `done` → `open`;
  - `carried` → unchanged.
  - On a non-list top-level block, it converts the block to a bullet list item with `data-task="open"`.
  - Inside an `ol`, a `<pre>` or a blockquote it does nothing.
  - This is checked to be free: the editor has no Ctrl+Enter binding today.
  - There is no separate "create" chord. Ctrl+Shift+C is devtools, and Ctrl+Shift+5/7/8/9 are taken.
- **The toolbar button** "Checklist" sits after the ordered-list button. It runs the same `makeTask()` as Ctrl+Enter, but only makes items: it never toggles existing ones.
- **Typed prefixes.** `[] ` or `[ ] `, typed as the whole text of a `ul` `<li>` or of an empty top-level block, converts it to an open task.
  - Extend `BlockPrefixMatch['type']` with `'task'`, matched by `/^\[ ?\][  ]$/` (regular space or U+00A0).
- **Click to toggle.** A click whose `target` is the task `<li>` itself, and whose `offsetX` is less than the box gutter (the `<li>`'s computed `padding-left`), toggles it.
  - Clicks on the text never toggle.
  - In a read-only editor (`editorsReadOnly`) it does nothing.
- **Enter.** After a native `insertParagraph` inside a task `<li>`, the new `<li>` at the caret gets `data-task="open"`. Chromium clones the attribute, so a `done` item would otherwise create another done item.
  - Enter on an empty task item leaves the list natively, as today.
  - This is done in `onInput` for `inputType === 'insertParagraph'`.
- **Accessibility.**
  - The state is announced through CSS generated-content alt text: `li[data-task="open"]::before { content: "" / var(--tt-task-open) }`, and the same for done and carried.
  - The three custom properties are set once on `editorEl` with `style.setProperty('--tt-task-open', JSON.stringify(t(locale, 'editor_task_open_sr')))`. Setting style through the CSSOM is CSP-safe.
  - Ctrl+Enter is the keyboard toggle.
- **Undo.** Each toggle or conversion is one undo step, through `edit(() => …)`, followed by `scheduleChange()`.
- **CSS** (tokens only):
  - the `<li>` gets `list-style: none` and a box `::before` with `--r-sm` and a border in the text color;
  - done: a filled box with a check, and the text `text-decoration: line-through` dimmed;
  - carried: an arrow glyph box, with the text dimmed.
- **i18n keys** (both locales):
  - `editor_checklist_title`: "Checklist (Ctrl+Enter)" / "Checklist (Ctrl+Enter)".
  - `editor_task_open_sr`: "not done" / "não feito".
  - `editor_task_done_sr`: "done" / "feito".
  - `editor_task_carried_sr`: "carried over" / "levado adiante".

- [ ] **Step 1: Write the failing unit tests** (jsdom; follow the existing `execCommand` stub pattern at the top of `test/editor.test.ts`)

```ts
test('Ctrl+Enter on a plain bullet makes it an open task, then toggles done/open', () => {
  const ed = mount('- a'); caretIn(ed, 'a')
  key(ed, 'Enter', { ctrlKey: true }); expect(ed.getMd()).toBe('- [ ] a')
  key(ed, 'Enter', { ctrlKey: true }); expect(ed.getMd()).toBe('- [x] a')
  key(ed, 'Enter', { ctrlKey: true }); expect(ed.getMd()).toBe('- [ ] a')
})
test('Ctrl+Enter leaves a carried item alone', () => { /* '- [>] a' unchanged */ })
test('Ctrl+Enter on a plain top-level line makes an open task item', () => { /* 'a' → '- [ ] a' */ })
test('a toggle is one undo step', () => { /* toggle, Ctrl+Z → original md */ })
test('click in the box gutter toggles; click on the text does not', () => { /* dispatch MouseEvent with offsetX stubbed via Object.defineProperty */ })
test('read-only editor ignores the toggle', () => { /* setEditorsReadOnly(true) */ })
test('detectBlockPrefix matches "[] " and "[ ] " as task', () => {
  expect(detectBlockPrefix('[]\u00a0')).toEqual({ type: 'task', prefixLen: 3 })
  expect(detectBlockPrefix('[ ] ')).toEqual({ type: 'task', prefixLen: 4 })
})
test('toolbar has a Checklist button', () => { /* title === t('en-US','editor_checklist_title') */ })
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run test/editor.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement** the behavior listed above.

- [ ] **Step 4: Add the e2e cases** to `e2e/editor.spec.ts`. These need the real Chromium editing that jsdom lacks:
  - typing `- ` then `[] x` makes an open task;
  - Enter on a done item gives an open item;
  - a second Enter on the empty item leaves the list;
  - clicking the box toggles it, and reload keeps the state.

- [ ] **Step 5: Run the tests**

Run `npx vitest run test/editor.test.ts test/design-rules.test.ts test/i18n.test.ts`, then `npm run test:e2e -- editor.spec.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

Message: `feat(editor): checklists — Ctrl+Enter, toolbar, [] prefix, click to toggle`

---

### Task 3: The 1:1 seed template and `{carryover}`

**Files:**
- Modify: `src/core/templates.ts`.
- Modify: `src/core/i18n.ts`: `prefs_templates_placeholders_hint` and `help_templates_text` in both locales, adding `{carryover}`.
- Test: `test/templates.test.ts`

**Interfaces:**
- `TemplateCtx` gains `carryover?: string`.
- Produces: `export const ONE_ON_ONE_SEED_NAME = '1:1'`.
- Produces: `export function upgradeLegacySeedBodies(templates: Template[]): Template[]`. It maps a body that exactly equals a legacy seed body to the current body in the same locale.
- `TemplateSeed` gains `legacyBody?: { 'pt-BR': string; 'en-US': string }`. The old 1:1 bodies move there verbatim.

- [ ] **Step 1: Write the failing tests**

```ts
test('new 1:1 seed (en-US) is the spec body', () => {
  expect(builtinTemplates('en-US').find(t => t.name === '1:1')!.body).toBe(
    '## 1:1 — {date}\n### Carried over\n{carryover}\n### How are they / energy\n- \n### Their topics\n- \n### My topics\n- \n### Feedback\n- \n### Agreed actions\n- [ ] ')
})
test('pt-BR seed uses "### Pendências anteriores"', () => { /* body contains '### Pendências anteriores\n{carryover}\n' */ })
test('{carryover} fills in place', () => {
  expect(resolveTemplate('## A\n### C\n{carryover}\n### B', { ...ctx, carryover: '- [ ] x' })).toBe('## A\n### C\n- [ ] x\n### B')
})
test('empty {carryover} removes its line and the heading above it', () => {
  expect(resolveTemplate('## A\n### C\n{carryover}\n### B', ctx)).toBe('## A\n### B')
})
test('empty {carryover} never removes the first line', () => {
  expect(resolveTemplate('## A\n{carryover}\n- x', ctx)).toBe('## A\n- x')
})
test('empty {carryover} inline stays empty text, nothing removed', () => {
  expect(resolveTemplate('x {carryover} y', ctx)).toBe('x  y')
})
test('reseed recognizes the legacy 1:1 body', () => { /* legacy en body named '1:1' → pt-BR current body */ })
test('upgradeLegacySeedBodies upgrades only exact legacy bodies', () => { /* legacy pt → current pt; edited body untouched */ })
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run test/templates.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **Placeholder:** `resolveTemplate` handles `{carryover}` after the other placeholders.
  - **Empty-section rule (Spec §2):** when `ctx.carryover` is empty or absent, a line that is exactly `{carryover}` is removed. The line above it is also removed when it matches `/^#{1,3} /` and is not line 0.
  - **Doc comment:** update `resolveTemplate`'s doc comment to list `{carryover}`.
  - **Reseed:** `reseedBuiltinTemplates` also matches `s.legacyBody?.[oldLocale]`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run test/templates.test.ts test/i18n.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(templates): new 1:1 seed with {carryover}`

---

### Task 4: Schema 20 — person cadence fields and prefs

**Files:**
- Modify: `src/core/types.ts`, `src/core/document.ts` (`SCHEMA_VERSION`, `createEmptyDocument`, `MIGRATIONS[19]`) and `src/core/CLAUDE.md` (the schema line).
- Test: `test/document.test.ts` and `test/team-export.test.ts`.

**Interfaces:**
- `Person` gains:
  - `lastOneOnOne?: string`: ISO `YYYY-MM-DD`.
  - `oneOnOneEveryDays?: number | null`: absent means the group default, `null` means none.
- `Prefs` gains:
  - `oneOnOneDefaultDays: number`: 0..365, where 0 means no default. **My call:** 0 is the off switch, so the members default can be turned off.
  - `oneOnOneTemplateId: string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
test('new document points oneOnOneTemplateId at the seeded 1:1', () => {
  const d = createEmptyDocument('en-US')
  expect(d.schemaVersion).toBe(20)
  expect(d.prefs.oneOnOneDefaultDays).toBe(14)
  expect(d.templates.find(t => t.id === d.prefs.oneOnOneTemplateId)!.name).toBe('1:1')
})
test('migrate 19→20 adds prefs, points at "1:1", upgrades a legacy seed body', () => { /* v19 doc with legacy en body → current en body, id set */ })
test('migrate 19→20 leaves a customized 1:1 body alone and still points at it', () => {})
test('migrate 19→20 with no "1:1" template sets null', () => {})
test('migrate 19→20 ignores a "1:1" template scoped daily', () => {})
test('team export does not carry cadence fields', () => { /* person with lastOneOnOne/oneOnOneEveryDays → exported person lacks both */ })
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run test/document.test.ts test/team-export.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - `MIGRATIONS[19]` guards on `prefs` and `templates` being present, as the other steps do, and does three things:
    1. Run `upgradeLegacySeedBodies`.
    2. Set `oneOnOneDefaultDays ??= 14`.
    3. Set `oneOnOneTemplateId` to the first template whose name is `ONE_ON_ONE_SEED_NAME` and whose scope is `personal` or `any`; otherwise set it to `null`.
  - `validateDoc` is not changed: the new fields are optional, and malformed values are ignored by Task 5.

- [ ] **Step 4: Run the full suite and confirm it passes**

Run `npm test`. Expected: PASS. This catches fixtures pinned to `schemaVersion: 19`; update them.

- [ ] **Step 5: Commit**

Message: `feat(schema): v20 — 1:1 cadence fields and prefs`

---

### Task 5: Cadence rule and 1:1 due items

**Files:**
- Create: `src/core/cadence.ts`, with `test/cadence.test.ts`.
- Modify: `src/core/due.ts`, `src/ui/due-panel.ts`, `src/core/switcher.ts`, `src/ui/sidebar.ts` (`WATCHED` adds `'people'`; update its doc comment) and `src/core/i18n.ts`.
- Test: `test/due.test.ts`, `test/due-panel.test.ts`, `test/switcher.test.ts` and `test/sidebar.test.ts`.

**Interfaces:**
- `cadence.ts` produces:
  - `effectiveCadenceDays(person: Person, group: 'stakeholders' | 'members', prefs: Prefs): number | null`:
    - an integer between 1 and 365 in `oneOnOneEveryDays` wins;
    - `null` means none;
    - an absent field means members use `prefs.oneOnOneDefaultDays` (0 → null) and stakeholders get null;
    - any other value is treated as absent.
  - `oneOnOneDueDate(person, group, prefs): string | null`. It returns `addDaysIso(lastOneOnOne, cadence)`, or `null` when `lastOneOnOne` is not a valid `YYYY-MM-DD` or there is no cadence.
- `due.ts` changes:
  - `DueItem.kind` becomes `'action' | 'milestone' | 'person'`.
  - A person item has `loc = { teamId, ref: { kind: 'person', personId, group } }`, `title = person.name` and `date = due date`.
  - `export type DueModule = 'actions' | 'milestones' | 'members' | 'stakeholders'`.
  - `export function moduleDueSummary(buckets: DueBuckets, teamId: string): Map<DueModule, { overdue: number; dueSoon: number }>`.
  - `export function dueItemLabel(locale: Locale, item: DueItem): string`. It returns the title, or `t('due_one_on_one_title', { name })` for `person`.
- i18n: `due_one_on_one_title`: "1:1 · {name}" / "1:1 · {name}".

- [ ] **Step 1: Write the failing tests**

```ts
// cadence.test.ts
test('members default 14, stakeholders none', () => {
  expect(effectiveCadenceDays(p({}), 'members', prefs)).toBe(14)
  expect(effectiveCadenceDays(p({}), 'stakeholders', prefs)).toBeNull()
})
test('override and explicit none', () => {
  expect(effectiveCadenceDays(p({ oneOnOneEveryDays: 7 }), 'stakeholders', prefs)).toBe(7)
  expect(effectiveCadenceDays(p({ oneOnOneEveryDays: null }), 'members', prefs)).toBeNull()
})
test('default 0 turns members off', () => {})
test('no lastOneOnOne → never due', () => expect(oneOnOneDueDate(p({}), 'members', prefs)).toBeNull())
test('due date = last + cadence', () => expect(oneOnOneDueDate(p({ lastOneOnOne: '2026-11-01' }), 'members', prefs)).toBe('2026-11-15'))
test('ignores malformed cadence fields', () => {
  expect(oneOnOneDueDate(p({ lastOneOnOne: 'nope' as string }), 'members', prefs)).toBeNull()
  expect(effectiveCadenceDays(p({ oneOnOneEveryDays: -3 as number }), 'members', prefs)).toBe(14)
  expect(effectiveCadenceDays(p({ oneOnOneEveryDays: '7' as unknown as number }), 'members', prefs)).toBe(14)
})
// due.test.ts
test('overdue and due-soon 1:1s land in the buckets as kind person', () => {})
test('moduleDueSummary groups by module, person items by group', () => {})
// due-panel.test.ts / switcher.test.ts
test('a 1:1 row reads "1:1 · Ana"', () => {})
// sidebar.test.ts
test('recording a 1:1 (people-scoped update) refreshes the due badge', () => {})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run test/cadence.test.ts test/due.test.ts test/due-panel.test.ts test/switcher.test.ts test/sidebar.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - `collectDueItems` walks `team.members` and `team.stakeholders` through `oneOnOneDueDate` and puts each result through the existing `classify`.
  - The due panel and the switcher use `dueItemLabel`. The due panel's icon stays `kindIcon(REF_KINDS[item.kind].moduleKind)`, which gives `person`.

- [ ] **Step 4: Run the tests and confirm they pass** (same command as Step 2). Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(due): per-person 1:1 cadence feeds the due panel, badges and fast switch`

---

### Task 6: Carry-over core

**Files:**
- Create: `src/core/one-on-one.ts`, with `test/one-on-one.test.ts`.
- Modify: `src/core/i18n.ts`. Add `one_on_one_carried_heading`: "Carried over" / "Pendências anteriores". The seed headings use the same text.

**Interfaces:**
- Consumes: `resolveTemplate` and `TemplateCtx` (Task 3), and `TASK_PREFIX` (Task 1).
- Produces:
```ts
export interface OneOnOneResult {
  md: string                     // the whole new note
  /** How many `---` rule lines the appended block itself contains; the block starts right after the (n+1)-th rule from the end. null = the note was empty, so the block is the whole note. */
  blockHrFromEnd: number | null
}
export function buildOneOnOne(noteMd: string, body: string | null, ctx: TemplateCtx): OneOnOneResult
```
`body === null` means the template is missing. The fallback body is then `'## 1:1 — {date}'`.

**Algorithm** (on markdown lines; skip lines inside ``` fences, using the same fence rule as `mdToHtml`):
- **Task line:** a line `^( *)- ` whose remainder matches `TASK_PREFIX`.
- **Subtree:** the following lines with a deeper list indent (`^( *)(- |\d+\. )` with more leading spaces). A list item is exactly one line in this dialect, because a `<br>` continuation reloads as a plain line outside the list.
- **Collect:** walk top-down. An `open` task with non-blank text (`m[2]?.trim()`) is collected together with its subtree, dedented by its own indent. Then skip past the subtree.
  - Every `open` task inside a collected subtree, and the root itself, is rewritten `- [ ] ` → `- [>] ` in the original.
  - The copies stay `[ ]`.
- **Skip blanks:** blank open tasks are neither collected nor marked.
- **Placeholder present:** if `body` contains `{carryover}`, resolve it with `carryover = items.join('\n')`.
- **Placeholder absent, items present:** insert `### ${t(ctx.locale,'one_on_one_carried_heading')}\n${items}` after the resolved body's first line.
- **Join:** when the marked note is non-empty (`trim() !== ''`), the result is `markedNote.trimEnd() + '\n---\n' + block`. Otherwise it is just the block.

- [ ] **Step 1: Write the failing tests**

```ts
const ctx = { dateIso: '2026-11-13', time: '10:00', personName: 'Ana', locale: 'en-US' as const }
test('first 1:1 on an empty note: no rule, no carried section', () => {
  const r = buildOneOnOne('', SEED_EN, ctx)
  expect(r.md.startsWith('## 1:1 — ')).toBe(true); expect(r.md).not.toContain('Carried over'); expect(r.blockHrFromEnd).toBeNull()
})
test('carries open items with subtree, marks originals, skips done and blank', () => {
  const note = '## 1:1\n- [ ] a\n  - detail\n- [x] b\n- [ ] \n- [>] old'
  const r = buildOneOnOne(note, SEED_EN, ctx)
  expect(r.md).toContain('- [>] a\n  - detail\n- [x] b\n- [ ] \n- [>] old\n---\n## 1:1')
  expect(r.md).toContain('### Carried over\n- [ ] a\n  - detail\n### How are they')
})
test('nested open task under a non-task bullet is lifted to top level', () => {
  expect(buildOneOnOne('- topic\n  - [ ] x\n    - y', SEED_EN, ctx).md).toContain('### Carried over\n- [ ] x\n  - y\n')
})
test('marks nested open tasks carried too', () => {
  const r = buildOneOnOne('- [ ] a\n  - [ ] b', SEED_EN, ctx)
  expect(r.md.split('---')[0]).toBe('- [>] a\n  - [>] b\n')
  expect(r.md).toContain('### Carried over\n- [ ] a\n  - [ ] b\n')          // b travels once, inside a
  expect(buildOneOnOne(r.md, SEED_EN, ctx).md.match(/- \[ \] b/g)!.length).toBe(1) // second 1:1: b is open only in its newest copy
})
test('fenced and ordered task text is ignored', () => {})
test('template without {carryover} still carries after the first line', () => {
  expect(buildOneOnOne('- [ ] a', '## Mine\n- x', ctx).md).toContain('---\n## Mine\n### Carried over\n- [ ] a\n- x')
})
test('missing template falls back to a bare heading plus carried items', () => {
  expect(buildOneOnOne('- [ ] a', null, ctx).md).toMatch(/---\n## 1:1 — .+\n### Carried over\n- \[ \] a$/)
})
test('blockHrFromEnd counts rules inside the template body', () => {
  expect(buildOneOnOne('x', '## A\n---\n- ', ctx).blockHrFromEnd).toBe(1)
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run test/one-on-one.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `buildOneOnOne`** in `src/core/one-on-one.ts`.

- [ ] **Step 4: Run the tests and confirm they pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(core): 1:1 carry-over builder`

---

### Task 7: Undoable whole-note replace in the editor

**Files:**
- Modify: `src/ui/editor.ts`: the `Editor` interface, a new `replaceMd`, and the return object.
- Test: `test/editor.test.ts`

**Interfaces:**
- Produces: `Editor.replaceMd(md: string, caretTarget?: (root: HTMLElement) => Node | null): void`.
  - It is one undo step: `undoStack.checkpoint()`, then `editorEl.innerHTML = renderMd(md)`, then the same settle steps `setMd` runs (`decorateCodeBlocks(true)`, `syncPreHighlight()`, `hydrateImages()`), then `refreshRefLabels()` and `scheduleChange()`.
  - Unlike `setMd`, it does **not** clear the undo stack.
  - If `caretTarget` returns a node, it focuses the editor, calls `placeCaretAtStart(node)` and scrolls the node into view (`scrollIntoView({ block: 'center' })`). Otherwise the caret goes to the end of the content.
  - In a read-only editor it does nothing.

- [ ] **Step 1: Write the failing tests**

```ts
test('replaceMd swaps content as one undo step and keeps earlier history', () => {
  const ed = mount('a'); typeSomething(ed)            // creates an undo step
  ed.replaceMd('b'); expect(ed.getMd()).toBe('b')
  undo(ed); expect(ed.getMd()).toBe(mdBefore)          // back to pre-replace, not cleared
})
test('replaceMd places the caret on the target node', () => {})
test('replaceMd is a no-op when read-only', () => {})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run test/editor.test.ts -t replaceMd`. Expected: FAIL.

- [ ] **Step 3: Implement `replaceMd`.**

- [ ] **Step 4: Run the tests and confirm they pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(editor): undoable replaceMd`

---

### Task 8: The "New 1:1" button, Alt+O and the status line

**Files:**
- Modify: `src/modules/person-notes.ts`, `src/ui/rich-editor.ts` (`RichEditorBundle.templateCtx(): TemplateCtx`, the same object `getTemplateCtx` builds), `src/ui/panes.ts`, `src/ui/app-hotkeys.ts`, `src/main.ts`, `src/ui/icons.ts` (`oneOnOne` icon), `styles.css` and `src/core/i18n.ts`.
- Test: `test/person-notes.test.ts` and `test/app-hotkeys.test.ts`.

**Interfaces:**
- `panes.ts` produces `export const NEW_ONE_ON_ONE_EVENT = 'tt-new-one-on-one'` and `export function requestNewOneOnOne(paneIdx: 0 | 1): void`. These mirror `NEW_ITEM_EVENT` and `requestNewItem`.
- `app-hotkeys.ts`:
  - `AppHotkeyAction` adds `{ type: 'newOneOnOne' }`;
  - `AppHotkeyContext` adds `focusedPaneShowsPerson: boolean`;
  - `matchKey(e, 'o')` in the Alt block returns the action only when that flag is true, and `null` otherwise.
- `main.ts`: the `newOneOnOne` case runs `if (navPastModelessCard()) requestNewOneOnOne(store.doc.nav.focusedPane)`.
- Consumes: `buildOneOnOne` (Task 6), `Editor.replaceMd` (Task 7), `effectiveCadenceDays` and `oneOnOneDueDate` (Task 5).

**Behavior in `person-notes.ts`:**
- **Button.** Add `iconButton({ class: 'tt-person-header-btn tt-person-header-one-on-one-btn', icon: 'oneOnOne', title: t('person_new_one_on_one_title') })`. It goes before `editBtn`, and the container listens for `NEW_ONE_ON_ONE_EVENT`.
- **Running it:**
  1. Skip if the editor is read-only.
  2. Take `editor.getMd()`.
  3. Take the template: `doc.templates.find(id === prefs.oneOnOneTemplateId)`, falling back to `null`.
  4. Build `ctx` exactly as `createModuleEditor`'s `getTemplateCtx` does. Expose it: `RichEditorBundle` gains `templateCtx(): TemplateCtx`.
  5. Call `buildOneOnOne`.
  6. Call `editor.replaceMd(r.md, finder)`.
  7. `editor` already persists through `onChange`.
  8. Finally `ctx.store.update(d => { person.lastOneOnOne = todayIso() }, { teamId, sections: ['people'] })`.
- **Finder:** find the start of the block. That is the root when `blockHrFromEnd === null`. Otherwise it is the element after the `(blockHrFromEnd + 1)`-th `<hr>` counted from the end among the root's children. From there, take the first `<li>` whose text is blank and that is not `data-task="carried"`, falling back to the root's last child.
- **Status line.** Add a button `.tt-person-cadence` in the header. It opens the same dialog as `editBtn`, so refactor the existing `onclick` into `openEdit()`.
  - Text: `person_last_one_on_one` "Last 1:1: {ago}" or `person_no_one_on_one` "No 1:1 yet". Append `person_cadence_every` " · every {days} days" when the cadence is set.
  - `{ago}`: "today", or `due_overdue_by`-style counts via a new key `person_days_ago` "{days} days ago".
  - The class `overdue` is added when the due date is before today. It uses the `--danger` text token.
- **Refresh.** The status line repaints in the existing subscription, since `'people'` is in `WATCHED` via `BACKLINK_SECTIONS` plus `'teams'`. Add `'prefs'` to `WATCHED`. It also repaints in `watchDayChange`, which is unbound in the teardown.
- **i18n:**
  - `person_new_one_on_one_title`: "New 1:1 (Alt+O)" / "Novo 1:1 (Alt+O)";
  - `person_last_one_on_one`;
  - `person_no_one_on_one`;
  - `person_cadence_every`;
  - `person_days_ago`.

- [ ] **Step 1: Write the failing tests**

```ts
// app-hotkeys.test.ts
test('Alt+O → newOneOnOne only when the focused pane shows a person', () => {})
// person-notes.test.ts
test('New 1:1 appends the block, marks carried, records today, one undo step', () => {
  // person.notes '- [ ] a'; click .tt-person-header-one-on-one-btn
  // store person.notes (after flush) contains '- [>] a\n---\n## 1:1' and '### Carried over\n- [ ] a'
  // person.lastOneOnOne === todayIso(); undo restores '- [ ] a' and lastOneOnOne stays today
})
test('NEW_ONE_ON_ONE_EVENT on the pane body runs the same action', () => {})
test('deleted template id falls back to a bare heading', () => {})
test('status line: "No 1:1 yet · every 14 days" for a member; overdue class when late', () => {})
test('status line repaints after a people-scoped update', () => {})
test('teardown releases the day-change listener and subscription', () => {})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run test/person-notes.test.ts test/app-hotkeys.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the behavior above.

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run test/person-notes.test.ts test/app-hotkeys.test.ts test/lifecycle.test.ts test/design-rules.test.ts test/rich-editor.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(person): New 1:1 button with carry-over, Alt+O, cadence status line`

---

### Task 9: Cadence fields in the person dialog and in Preferences

**Files:**
- Modify: `src/ui/person-modal.ts`, `src/modules/people-tree.ts` (edit modal), `src/modules/person-notes.ts` (`openEdit`), `src/ui/prefs.ts` (`renderTemplates`) and `src/core/i18n.ts`.
- Test: `test/person-modal.test.ts`, `test/prefs.test.ts` and `test/people-tree.test.ts`.

**Interfaces:**
- `openPersonModal` opts gain an optional `oneOnOne?: { everyDays: number | null | undefined; last: string | undefined; defaultDays: number | null }`.
  - When it is present, the dialog shows its fields and `onSubmit` receives a third argument, `cadence: { everyDays: number | null | undefined; last: string | undefined }`. `undefined` for `everyDays` means "Default", so the caller deletes the field.
  - The add flow passes no `oneOnOne`, so it is unchanged.
- **Dialog fields:**
  - "1:1 every" is a `<select>` with three options: "Default ({n} days)" (or "Default (none)"), "None" and "Custom". Picking Custom reveals a number input, clamped 1..365 with `clampInt`.
  - "Last 1:1" uses `createDatePicker({ allowClear: true })`. The picker is destroyed on close.
- **Callers:** they write `p.oneOnOneEveryDays` (deleted when `undefined`) and `p.lastOneOnOne` (deleted when `''` or `undefined`) in the same update as name and role.
- **Preferences → Templates:** a `prefsSection` above the list holds two fields:
  - `prefsNumberField` "Default 1:1 cadence (members)", 0..365, with the hint "0 = none". It commits `oneOnOneDefaultDays`.
  - A `<select>` "Template for New 1:1" with `personal` and `any` templates plus "None (heading only)". It commits `oneOnOneTemplateId`.
  - Both use `store.update(fn)` with the same scope as the existing prefs edits (`PREFS_ONLY`).
  - The select re-renders in `refreshList()`, so a renamed, added or deleted template shows up.
- **i18n:**
  - `person_cadence_label`;
  - `person_cadence_default`;
  - `person_cadence_default_none`;
  - `person_cadence_none`;
  - `person_cadence_custom`;
  - `person_cadence_days_unit`;
  - `person_last_label`;
  - `prefs_one_on_one_default_label`;
  - `prefs_one_on_one_default_hint`;
  - `prefs_one_on_one_template_label`;
  - `prefs_one_on_one_template_none`.

- [ ] **Step 1: Write the failing tests**

```ts
test('edit dialog shows cadence fields and submits Default as undefined', () => {})
test('Custom reveals the days input; None submits null', () => {})
test('clearing Last 1:1 submits undefined', () => {})
test('add dialog has no cadence fields', () => {})
test('people-tree edit persists cadence fields', () => {})
test('prefs Templates tab edits oneOnOneDefaultDays and oneOnOneTemplateId', () => {})
test('template select lists only personal/any templates', () => {})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run test/person-modal.test.ts test/prefs.test.ts test/people-tree.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests and confirm they pass**

Run the same command, plus `test/design-rules.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(person,prefs): 1:1 cadence and last-1:1 fields`

---

### Task 10: Overdue mark on the org chart

**Files:**
- Modify: `src/modules/people-tree.ts` (`renderBox`, `WATCHED`, a day-change refresh), `styles.css` and `src/core/i18n.ts`.
- Test: `test/people-tree.test.ts`

**Interfaces:**
- Consumes: `oneOnOneDueDate` (Task 5).
- **Mark:** when the due date is before `todayIso()`, the box gets `el('span', { class: 'tt-org-due', role: 'img', 'aria-label': text, title: text })`, where `text = t('org_one_on_one_overdue', { days })`, "1:1 overdue by {days} days".
  - It is placed bottom-left, because `::after` holds the top-right fold.
  - It is a `--danger` dot using `--r-*` tokens.
  - **Overdue only.** Nothing is drawn for due-soon.
- **Refresh:** `WATCHED` adds `'prefs'`, and `watchDayChange(renderAll)` is unbound in the teardown.

- [ ] **Step 1: Write the failing tests**

```ts
test('overdue member gets .tt-org-due with "1:1 overdue by 3 days"', () => {})
test('due-soon and never-met people get no mark', () => {})
test('prefs change (default cadence) repaints marks', () => {})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run test/people-tree.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run test/people-tree.test.ts test/lifecycle.test.ts test/design-rules.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(org): overdue 1:1 mark on the org chart`

---

### Task 11: Due dots on the module selector

**Files:**
- Modify: `src/ui/panes.ts` (`buildTabs`, `buildMenu`, `renderBar`, the existing `store.subscribe` at ~L475, and `dispose`), `styles.css` and `src/core/i18n.ts`.
- Test: `test/panes.test.ts`

**Interfaces:**
- Consumes: `collectDueItems` and `moduleDueSummary` (Task 5).
- **Helper:** `dueState(teamId): Map<DueModule, {overdue, dueSoon}>`, computed with `todayIso()`.
- **Tabs and rows.** Both get `el('span', { class: 'tt-due-dot' + (overdue ? '' : ' soon'), 'aria-hidden': 'true' })` inside the icon's wrapper.
  - The dot sits at the icon's top-right, clear of `.tt-pane-tab-key`.
  - `title` and `aria-label` gain ` · ${t('pane_due_state', { overdue, soon })}`, for example "2 overdue, 1 due soon". Use separate keys when one of the two is 0: `pane_due_overdue` and `pane_due_soon`.
  - The current tab keeps its dot.
  - Clicking does exactly what it does today.
- **Closed dropdown button.** `.tt-pane-modules-btn` gets a dot when a module **other than** the current one has due items. It is red if any of those is overdue, otherwise brass. The state is added to the button's `title`.
- **Colors:**
  - red uses `--danger`;
  - brass uses `--brass`;
  - the rule is the same as `.tt-team-due-badge`.
- **Live refresh.** `renderBar` writes a signature of the painted state to `barEl.dataset.due`, for example `JSON.stringify([...map])`.
  - The existing subscription, not a new one (`test/lifecycle.test.ts` counts subscriptions), re-renders a bar when `scopeTouchesSections(scope, ['actions','milestones','people','prefs','teams'])` and the recomputed signature differs.
  - A `watchDayChange` registered in `createPaneManager` does the same check, and `dispose()` unbinds it.
  - Notes keystrokes, which are scoped `['notes']`, never recompute.

- [ ] **Step 1: Write the failing tests**

```ts
test('tab and menu row show a red dot for a module with an overdue item', () => {})
test('brass dot when only due soon; none when nothing is due', () => {})
test('members tab dots for an overdue 1:1', () => {})
test('current tab keeps its dot; closed dropdown dots only for other modules', () => {})
test('tooltip and aria-label carry the state', () => {})
test('an action-scoped update repaints the dot; a notes-scoped one does not recompute', () => {})
test('dispose unbinds the day-change listener', () => {})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run test/panes.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run test/panes.test.ts test/lifecycle.test.ts test/render-counts.test.ts test/design-rules.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(panes): due dots on module tabs and dropdown`

---

### Task 12: Help, docs and end-to-end check

**Files:**
- Modify: `src/ui/help.ts`, `src/core/i18n.ts` and `README.md` (the feature list, if it lists editor features).
- Create: `e2e/one-on-one.spec.ts`.
- Test: `test/help.test.ts`

**Help content:**
- **Editor tab, block rows:**
  - `['Ctrl+Enter', 'help_task_toggle']`: "Checklist item: make / tick / untick";
  - `['[ ] ', 'help_task_typed']`;
  - `['Ctrl+Home / Ctrl+End', 'help_doc_start_end']`.
- **People tab:**
  - `rowsSection(ctx, 'help_sec_one_on_one', [['Alt+O', 'help_one_on_one_new']])`;
  - `textSection(ctx, 'help_one_on_one_heading', 'help_one_on_one_text')`. The text explains carry-over (open items move forward and the old ones show ↪), the cadence (per person, with the default in Preferences → Templates) and where due 1:1s appear.
- **Global shortcuts list:** add Alt+O if it lists the Alt keys.
- **Templates:** `help_templates_text` was already updated in Task 3.

- [ ] **Step 1: Write the failing test.** In `test/help.test.ts`, the editor tab lists Ctrl+Enter, and the people tab lists Alt+O.

- [ ] **Step 2: Implement** the help rows and the i18n keys.

- [ ] **Step 3: Write `e2e/one-on-one.spec.ts`**, following `e2e/CLAUDE.md` and `helpers.ts`. It runs this flow:
  1. Create a team and a member, then open their notes.
  2. Type `- [] Ship plan`.
  3. Press the New 1:1 button. Expect `↪` styling on the original (`li[data-task="carried"]`), the new block at the bottom with `Ship plan` under "Carried over", and the caret in the "How are they" bullet.
  4. Press Ctrl+Z. Expect the block to be gone.
  5. Press Alt+O. Expect it to work again.
  6. Edit the person: set Last 1:1 to 20 days ago. Expect the Members tab to show a red `.tt-due-dot` and the org box to show `.tt-org-due`.
  7. Open the due panel. Expect it to list "1:1 · <name>".

- [ ] **Step 4: Run the full gate**

Run each of these:
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:e2e`

Expected: all PASS. The `help.spec.ts` and `a11y.spec.ts` e2e tests cover the new controls.

- [ ] **Step 5: Commit**

Message: `docs(help): checklists, New 1:1, cadence; e2e for the 1:1 flow`

---

## Notes for the executor

- **No CHANGELOG or version bump here.** That happens at release (load the `changelog` skill then).
- **Spec order:** §1 is Tasks 1–2, §2 is Task 3, §3 is Tasks 6–8, §4 is Tasks 4, 5, 9 and 10, §5 is Task 4, §6 is Task 11, and §7 is Task 12.
- **Calls this plan made beyond the spec:**
  - Ctrl+Enter both creates and toggles a task, so there is no separate create chord.
  - Typed `[]`/`[ ]` and the toolbar button create tasks.
  - The screen-reader state comes from CSS alt text fed by custom properties.
  - `oneOnOneDefaultDays: 0` means none.
  - 1:1 due rows read "1:1 · Name".
  - The New 1:1 edit is a whole-note replace, as one undo step. View-only code-block collapse state resets, which is acceptable.
  - The cadence fields appear in the edit dialog, not the add dialog.
