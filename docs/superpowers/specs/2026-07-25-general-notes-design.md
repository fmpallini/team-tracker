# General Notes module — design

Date: 2026-07-25

## Problem

Teams need a free-text place to stash general information that isn't tied to
a specific day (`dailyNotes`) or a specific person (`Person.notes`) — meeting
minutes, links, standing context, anything that's "about the team" rather
than about a date or an individual.

## Data model

- `Team` gains `generalNotes?: string` (`src/core/types.ts`) — a single
  markdown blob, team-scoped, no id. Same shape as `Person.notes`, not the
  id-bearing arrays (`actionItems`/`milestones`/`risks`), but **optional**,
  not required.
- **No `SCHEMA_VERSION` bump, no migration step.** This follows the existing
  precedent set by `Team.actionTagNames?:` (types.ts) — a team-level field
  added after the initial schema, kept optional specifically so a doc
  written before the field existed just has it `undefined` forever, read as
  `team.generalNotes ?? ''` at every call site, with no ladder step needed.
  The alternative (required field + migration, as originally scoped) would
  force every one of the ~20 test files that construct a bare `Team` object
  literal (`dailyNotes: {}` is the grep anchor) to gain a new required
  property for no behavioral benefit — optional-with-fallback is how this
  codebase already solves exactly this problem.
- `createEmptyTeam` seeds `generalNotes: ''` for newly created teams (same
  as it does for `actionTagNames`) — only pre-existing teams in older `.tmv`
  files ever see the field as `undefined`.
- `ModuleRef` gains `{ kind: 'general' }` — no `itemId`, since the note isn't
  individually addressable (mirrors `stakeholders`/`members`, not
  `actions`/`milestones`/`risks`).

## Renderer

New `src/modules/general-notes.ts`, modeled on `src/modules/person-notes.ts`
but simpler — no "underlying record deleted while pane is open" guard is
needed (action-items.ts shows no such guard for team deletion either; the
sidebar navigates away before a stale pane would re-render):

```ts
export function renderGeneralNotes(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void
```

- `if (loc.ref.kind !== 'general') return` defensive guard, same pattern as
  every other renderer.
- Single `createRichEditorBundle` bound to `team.generalNotes`:
  `onChange` writes through `ctx.store.update()`; `initialMd` reads
  `findTeam()?.generalNotes ?? ''`.
- `getTemplates` filters to `tpl.scope === 'any'` only — no new template
  scope. The note isn't tied to a date or a person, so `'daily'`/`'personal'`
  scoped templates don't apply.
- `getTemplateCtx` supplies `{ dateIso: todayIso(), time: nowHHMM(lc),
  teamName: findTeam()?.name, locale: lc }` (no `personName`).
- Per-container disposer registered in the module-local `WeakMap`, same as
  every other renderer (`bundle.dispose()`).

## Wiring

- `src/main.ts`: `pm.registerModule('general', renderGeneralNotes)`, placed
  with the other `registerModule` calls, before the post-registration
  `pm.renderAll()`.
- `src/ui/panes.ts`:
  - `titleFor()` gets `case 'general': return t(locale, 'module_general_notes')`.
  - `buildModuleItems()`: pushed as an explicit second entry, immediately
    after the Daily entry and *before* the per-person stakeholder/member
    loop — this is a placement decision (General Notes and Daily are the two
    free-text/no-id modules, grouped first), not a `FIXED_MODULE_KEYS`
    addition. `FIXED_MODULE_KEYS` only feeds the tail of the list
    (Stakeholders/Members/Actions/Milestones/Risks group entries), so
    reaching "right after Daily" requires a direct push, mirroring how the
    Daily entry itself is constructed inline rather than via that array.
  - This same function backs both the pane's "＋" module dropdown and the
    `Ctrl+K` palette (`src/ui/palette.ts`) — no separate palette wiring.
- `src/core/search.ts`:
  - `KIND_ICON.general = '🗒️'`.
  - `collectCandidates()` gains a loop pushing one candidate per team:
    `out.push({ raw: team.generalNotes ?? '', title: t(doc.prefs.locale,
    'module_general_notes'), ref: { kind: 'general' } })`. `searchDocument()`
    wraps `candidate.ref` into `{ teamId, ref }` itself (see its `loc:
    { teamId: team.id, ref: candidate.ref }` line) — `collectCandidates`
    only ever returns a bare `ModuleRef`, same as every other loop in that
    function. Unlike `dailyNotes` (one entry per date) this is a single
    entry per team, since there's exactly one blob; no need to skip empty
    notes — `allTermsMatch` on an empty string simply never matches, same
    as it would for a team with no daily notes.
  - Not added to `teamRefCandidates()` / `REF_KINDS` — the note has no id to
    target, so it's not `@`-mentionable, matching `stakeholders`/`members`.
- `src/core/refs.ts`: `unlinkRefsInTeam()` gains `team.generalNotes =
  unlink(team.generalNotes ?? '')` alongside its existing sweeps of
  `dailyNotes` and each person's `notes`. This is independent of the `REF_KINDS`
  decision above — the blob's free text can itself *contain* `@[label](kind:id)`
  mentions of people/actions/milestones/risks, and those need the same
  auto-unlink-on-delete as every other free-text field gets.

## i18n

New keys in both `pt-BR` and `en-US` blocks of `src/core/i18n.ts`:

- `module_general_notes` — nav/palette/search label ("General Notes" /
  "Notas Gerais").

No new placeholder/toast strings are needed — there's no not-found state for
this module (see Renderer section above).

## Icon

🗒️ (spiral notepad), distinct from 📅 (daily), 🧑/👥 (people), ✅/🚩/⚠️
(actions/milestones/risks).

## Testing

`test/general-notes.test.ts`, mounted against a real
`createStore(createEmptyDocument(locale))` + jsdom, following
`test/action-items.test.ts`'s pattern:

- Renders existing `team.generalNotes` content into the editor.
- Renders a team whose `generalNotes` is `undefined` (older-doc case, no
  field present) without throwing — editor starts empty.
- Typing updates `store.doc` via `store.update()` (marks dirty).
- Empty content round-trips as `''`, not left `undefined`.
- Template picker only offers `scope: 'any'` templates.
- `createEmptyTeam` seeds `generalNotes: ''` for a freshly created team.
- Search: a team with non-empty `generalNotes` shows up in
  `searchDocument()` results with `moduleKind: 'general'`.
- Search: a team with `generalNotes` left `undefined` doesn't throw and
  simply never matches (no crash on the missing field).
- Unlink: an `@[Name](person:id)` mention inside `generalNotes` reverts to
  plain text when that person is deleted.

## Out of scope

- No new template scope.
- No multi-entry/list UI — single blob per team, per the approved data-shape
  decision.
- No dedicated not-found placeholder — team deletion is handled upstream by
  navigation away from the pane, consistent with every other fixed-kind
  module (actions/milestones/risks/stakeholders/members).
- No `SCHEMA_VERSION` bump / migration ladder step — see Data model section.
