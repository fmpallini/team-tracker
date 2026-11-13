# 1:1 flow — checklists, "New 1:1" with carry-over, per-person cadence

Status: design, approved approach (A + X). Date: 2026-11-13.

## Intent

The user runs recurring 1:1s and records each one on the person's notes page, keeping that person's whole
history on one page: today they type a separator line, insert the 1:1 template with `/`, and write. Three
gaps make that loop clumsy:

1. Agreed actions are plain bullets, so nothing tells open from done.
2. Starting the next 1:1 means re-reading the last one to bring open items forward by hand.
3. Nothing says who is due for a 1:1 — the app has a due panel for tasks and milestones, but not for people.

This design closes the loop: checklists in notes (#1), a "New 1:1" button that carries open items forward
(#7, retargeted from daily notes to person notes), and a per-person cadence that feeds the due panel and the
org chart (#9).

## Goals

- `- [ ]` / `- [x]` checklist items in every note editor, toggled by click or key.
- A "New 1:1" button on the person page that, in one step, appends a separator and the 1:1 template at the
  **bottom** of the person's notes, fills it, carries over every open checklist item, records today as the
  person's last 1:1, and puts the caret in the new 1:1.
- A cadence per person (global default in Preferences, per-person override) driving due/overdue 1:1s in the
  due panel, team badges, fast switch and the org chart.

## Non-goals

- No migration of existing note text: this is a new feature. Existing plain bullets stay bullets.
- No rewrite of templates the user has customized. (An *unmodified* old seed 1:1 is upgraded — see §5.)
- Daily notes get checklists like every other editor, but no auto-template and no carry-over.
- No reminders/notifications outside the app.

## Anti-goals (failure even if it "works")

- Carry-over that silently breaks after an ordinary edit (rename a heading, cut/paste the block).
- An item carried twice, or a carried item lost.
- The due panel flooding on the day this ships: people with no recorded 1:1 are never due.
- A checkbox the keyboard or a screen reader can't use.

## Constraints

- Zero runtime dependencies; CSP forbids inline handlers (`addEventListener` via `el()`).
- All strings through `t()` in both `pt-BR` and `en-US`.
- `test/design-rules.test.ts` rules and the `ui-consistency` skill apply to every new control.
- Any editor change to the document calls `undoStack.checkpoint()` (or goes through `edit()` / `recordEdit()`)
  before its first change.
- Every new `src` module gets a `test/*.test.ts`.
- The editor never rebuilds its content from the store (caret safety): the button must edit through the
  open editor, not by rewriting `person.notes` underneath it.
- Schema bump 19 → 20 with a `MIGRATIONS[19]` entry in `src/core/document.ts`.

## Approaches considered

**Checklist representation**
- **A — list item with a task state (chosen).** `- [ ] text` ↔ `<li data-task="open">`, box drawn by CSS.
  Inherits all list behavior (Enter continues, Tab indents, paste, undo); bullets and boxes mix in one list.
  Cost: the drawn box is not a native checkbox, so state must be exposed to assistive tech by hand.
- B — real checkbox chip (`contenteditable="false"`) at the start of the item, like @-mention chips. Native
  a11y, but a non-editable leaf at line start fights Backspace / Enter-split / Home — the editor's most
  bug-prone area. Rejected.
- Plain-text `[ ]` with no rendering — too crude. Rejected.

**How the button finds what to carry**
- **X — forwarded state (chosen).** Carry every *open* item anywhere in the person's notes; mark each original
  `- [>]` (rendered dimmed, "carried"). No hidden state, history shows what was forwarded, never carried
  twice, survives any edit. Trade-off accepted: old 1:1s are no longer byte-for-byte untouched.
- Y — hidden marker on the last inserted block. Old blocks untouched, but an invisible marker in editable text
  is easily deleted (select-all, cut, paste) and carry-over then fails silently. Rejected.

**How a 1:1 is detected** — explicit button that records the date (chosen) over inferring from the
`## 1:1 — {date}` heading (locale-formatted, user-editable, fragile).

## Design

### 1. Checklists (all note editors)

- **Markdown:** a bullet item whose text starts with `[ ] `, `[x] ` (also `[X] `) or `[>] ` is a task item:
  `open`, `done`, `carried`. Only in bullet (`-`) lists, any depth. Serializes back as `- [ ] `, `- [x] `,
  `- [>] ` with the existing indent rules.
- **HTML:** `<li data-task="open|done|carried">` inside the existing `<ul>`; the box is drawn by CSS
  (`::before`), done text styled done (struck/dimmed per the design tokens), carried shows an arrow mark and is
  dimmed.
- **Create:** toolbar button "Checklist" (icon via `iconButton()`), a shortcut (builder picks a free one and
  lists it in the toolbar title and Help), and typing `[] ` or `[ ] ` at the start of a bullet or an empty line
  converts it.
- **Escaping:** a literal `[ ]` at the start of a plain bullet must stay expressible (builder's call on syntax).
- **Toggle:** click on the box, or a key on the caret's line (proposal `Ctrl+Enter`; builder verifies it is
  free inside the editor). Toggle cycles `open ↔ done`. `carried` is display-only — not toggled by click or key
  (my call: it is history; the live copy is in the newer 1:1).
- **Editing:** Enter on a task item makes a new `open` task item; Enter on an empty task item leaves the list,
  like empty bullets today. Each toggle is one undo step.
- **Accessibility:** the state must be announced (checked / not checked / carried) and toggleable by keyboard.
  Exact technique is the builder's (see "Left to the builder").
- **Copy / export:** "Copy as markdown" keeps the `[ ]` / `[x]` / `[>]` syntax; plain-text copy and print show
  the state readably (e.g. `☐` / `☑` / `↪`).

### 2. Seed 1:1 template (both locales)

New `en-US` body (pt-BR equivalent; carry-over heading proposal "Pendências anteriores"):

```
## 1:1 — {date}
### Carried over
{carryover}
### How are they / energy
- 
### Their topics
- 
### My topics
- 
### Feedback
- 
### Agreed actions
- [ ] 
```

- New placeholder `{carryover}`, documented with the others (`resolveTemplate` doc comment,
  `prefs_templates_placeholders_hint`, `help_templates_text`). Outside the button (plain `/` insert) it
  resolves to empty, and the empty-section rule below applies.
- **Empty section rule:** when `{carryover}` resolves to nothing and it stands alone on its line, that line is
  removed, and so is the line directly above it **if** that line is a heading and is not the body's first line
  (so the `## 1:1 — {date}` heading itself is never removed).
- **Template without `{carryover}`** (customized, or any template picked in Preferences): the button still
  carries. It inserts `### <carried-over heading>` + the items right after the body's first line, so carried
  items are never lost (my call).
- `reseedBuiltinTemplates` matches a seeded template by its exact body, so its seed table must know both the old
  and the new 1:1 body for locale switching to keep working.

### 3. "New 1:1" button (person page)

- **Where:** person page header, next to the edit button; hotkey `Alt+O` (appears free — builder verifies),
  acting only when the **focused** pane shows a person page. No fast-switch command (my call: `>` commands
  have no target context today, and a person-picker flow would have to wait for the editor to mount).
- **Which template:** new pref `oneOnOneTemplateId: string | null`, chosen in Preferences → Templates as
  "Template for New 1:1" among `personal`/`any` templates. New docs point it at the seeded 1:1. If it is
  null or its template was deleted, the button uses a bare `## 1:1 — {date}` heading, and the carried-over
  section is inserted under it by the rule in §2 (my call: the button never fails).
- **One action, one undo step, through the open editor:**
  1. Collect every `open` task item in the person's notes, in document order, each **with its whole subtree**
     (non-task sub-bullets, multi-line content), placed top-level in the new 1:1 (user's choice). An open task
     nested inside another open task travels inside its parent's subtree and is not collected again. **Blank** open items (no text) are skipped: neither carried nor marked (my call —
     the template's empty `- [ ]` would otherwise travel forward every time).
  2. Mark each of those originals `carried`.
  3. Resolve the template (`{date}`, `{time}`, `{person}`, `{team}`, `{carryover}` = the collected items).
  4. Append at the end of the note: `---` then the resolved body. No separator when the note is empty.
  5. Scroll to the new block; caret on the first empty bullet after the carry-over section (falls back to the
     end of the block).
  6. Set `person.lastOneOnOne = today` in the store.
- **Undo:** Ctrl+Z reverts the text (insertion + carried marks) in one step. The recorded date is **not**
  reverted (my call — it lives on the person, not in the editor; editable in the person dialog).
- **Same day twice:** allowed; just inserts another and keeps today's date.

### 4. Cadence

- **Data (schema 20):**
  - `Person.lastOneOnOne?: string` — ISO date, set by the button, editable/clearable in the person dialog.
  - `Person.oneOnOneEveryDays?: number | null` — absent = follow the default for the person's group; `null` =
    explicitly none; number = override in days.
  - `Prefs.oneOnOneDefaultDays: number` — default 14; applies to **members**. Stakeholders' default is none.
  - `Prefs.oneOnOneTemplateId: string | null`.
- **One rule in `src/core`** (alongside `due.ts`): effective cadence for (person, group, prefs) and the due date
  `lastOneOnOne + cadence`; no `lastOneOnOne` or no cadence → not due.
- **Person dialog** (small Cancel/Save form): "1:1 every" — Default (shows N days) / None / custom days; and
  "Last 1:1" date field (clearable).
- **Preferences → Templates:** "Default 1:1 cadence (members)" in days, next to "Template for New 1:1".
- **Due panel:** new `DueItem.kind` for 1:1s, title = person name, `loc` = the person's notes page; same
  `overdue` / `dueSoon` buckets and `dueSoonDays` window. Team badges (`teamDueSummary`) and the fast switch's
  due listing pick it up from `collectDueItems`. Needs its own icon/label.
- **Org chart:** overdue people get a small mark on their node with an accessible name/tooltip
  "1:1 overdue by N days". **Overdue only**, not due-soon.
- **Person page:** a status line near the button — "Last 1:1: 12 days ago · every 14 days", "No 1:1 yet", or
  no cadence; clicking it opens the person dialog.
- **Day rollover:** due state refreshes at midnight like the existing due items (`ui/day-change.ts`).

### 5. Migration 19 → 20

- Add `oneOnOneDefaultDays: 14` and `oneOnOneTemplateId` to prefs. For an existing doc, point the template id at
  a template named "1:1" if one exists (scope `personal`/`any`), else `null`.
- A template whose body is exactly the old seed 1:1 body (either locale) is upgraded to the new body in the same
  locale. Customized templates are left alone (my call — the user asked for the new template; customized ones
  still work via the §2 no-placeholder rule).
- "Restore defaults" (`src/ui/prefs.ts`) only adds seeds whose *name* is missing, so it does not replace an
  existing "1:1" — unchanged by this design.
- No change to people (fields are optional) or to note text.

### 6. Due hints on the module selector (added scope)

The pane's module selector (`buildTabs` / `buildMenu` in `src/ui/panes.ts`) shows which modules of the pane's
team hold due items: Tasks (due dates), Milestones, and Members / Stakeholders (1:1 cadence, §4). Colors follow
the sidebar badge rule: red if anything in that module is overdue, brass if all of it is only due soon.
State comes from `collectDueItems` grouped by module for the pane's team, so tabs, the sidebar and the due panel
never disagree. Mockups: https://claude.ai/artifact/CqTRZP1ocdc2JvEjNxd2Z4.

**Dots only, no counts, everywhere** (user's choice: simpler; the global due counter already gives numbers).

- **Tab strip, named or icon-only:** a dot on the module icon's top-right corner (clear of the F-key tag). The
  current module's tab keeps its dot.
- **Narrow dropdown, closed:** a dot on the button when *another* module has due items.
- **Dropdown, open:** a dot on each row's icon.
- No special click behavior: the dot is decoration, clicking the tab/row navigates as today.
- The state ("2 overdue, 1 due soon") is in each tab's and row's tooltip and accessible name.

### 7. Help and docs

- Editor tab: checklists (create, toggle) and `Ctrl+Home` / `Ctrl+End` (native, already working, undocumented).
- Person notes tab: New 1:1, carry-over, cadence.
- Templates help: `{carryover}`.

## Left to the builder

- Accessibility technique for the CSS-drawn box (e.g. a visually hidden state text per item, or roles on a
  wrapper) — must satisfy: state announced, keyboard toggle, `test/design-rules.test.ts` passes.
- Exact shortcuts (checklist create, toggle) after checking conflicts in `editor.ts`, `app-hotkeys.ts` and the
  module hotkeys.
- Whether `- [>]` items show in search results as plain text (they should be findable).
- Whether the team structure export (`core/team-export.ts`, structure-only) carries cadence fields — default no.
- Icons and exact copy for the new UI, per `ui-consistency`.

## Later (parked, not in this design)

- **#6 Free `#tags` in notes** — inline `#topic` in any note, searchable/filterable. Open question: tags would be
  the first thing that crosses teams (@-refs are team-scoped by design, `core/refs.ts`).
- **#2 Free-form pages per team** — named pages beyond the single `generalNotes`, needing a new ref kind,
  pane route, search and fast-switch entries; may be grouped by tag (#6) rather than nested.
- **Daily-note auto-template** — dropped from this scope; daily notes keep manual `/` templates.
