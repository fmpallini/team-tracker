# Team Tracker — Due/overdue reminders + named action-item tags (design)

Date: 2026-07-17. Approved by user on this date (text-only brainstorming, no visual companion — flow/logic features, not layout ones). Grew out of a feature-gap review against Notion/Linear/Asana/monday/Trello; these were the two gaps picked to build.

## Goal

Two independent, small features bundled into one spec because they share a schema bump and touch the same module (`action-items.ts`):

1. **Due/overdue reminders** — surface action items and milestones that are overdue or due soon, without any push notifications (no backend, no service-worker wakeups — in-app only, computed on load/mutation).
2. **Named action-item tags** — let each team give its own names to the 6 existing action-item colors (e.g. red → "Blocked"), and filter the Kanban board by tag. Not free-text tags — the colors stay the fixed vocabulary, only their labels become team-defined.

## Decisions (from brainstorming)

1. **Reminder mechanism**: in-app surfacing only. No `Notification` API, no PWA background wakeups — this app has no server and the design brief is explicit that mobile/background behavior isn't a target.
2. **Reminder surface**: both a sidebar badge (at-a-glance count) and a dedicated list (full detail, click to jump to the item).
3. **Due-soon window**: configurable in Prefs (`dueSoonDays`, default 3), not hardcoded — mirrors how `autoSaveMin` is already a user-tunable number in Prefs → General.
4. **Reminder scope**: both action items (`dueDate`, excluding `done`/`cancelled` status) and milestones (`date`, excluding `done: true`) — both already carry a date + completion flag, so excluding either would be an arbitrary carve-out.
5. **Tag scope**: action items only (not risks/milestones) — risks already have their own severity/plan taxonomy, milestones don't carry a color today.
6. **Tag naming scope**: per-team, not global — matches how stakeholders/members/action items are already team-scoped; a color's meaning ("Blocked" vs "Urgent") is a team convention, not an app-wide one.
7. **Tag usage**: display label on the card + a Kanban filter control. Explicitly **not** wired into global search (`core/search.ts`) — tag names are a board-organization affordance, not searchable content.

## Data model changes (schema v6)

```ts
// src/core/types.ts
export interface Prefs {
  // ...existing fields...
  dueSoonDays: number   // new — default 3
}
export interface Team {
  // ...existing fields...
  actionTagNames: Partial<Record<ActionItem['color'], string>>   // new — default {}
}
```

`actionTagNames` is `Partial` and keyed by the existing color literal (not a new id), so a missing/empty entry falls back to today's behavior (color name only) — no dead "untagged" state to design around.

### Migration (`src/core/document.ts`)

```ts
5: (d) => {
  const prefs = d.prefs as Record<string, unknown> | undefined
  if (prefs) prefs.dueSoonDays = prefs.dueSoonDays ?? 3
  for (const team of (d.teams as Record<string, unknown>[]) ?? []) {
    team.actionTagNames = team.actionTagNames ?? {}
  }
},
```

`SCHEMA_VERSION` → `6`. `createEmptyDocument()` sets `dueSoonDays: 3` and, since `emptyTeam()` (in `sidebar.ts`) also constructs `Team` objects directly for new teams, that helper gets `actionTagNames: {}` added too.

### Team export/import (`src/core/team-export.ts`)

`ExportedTeam` gains `actionTagNames` (carried through unchanged by `buildExport`/`remapForImport` — it's keyed by color literal, not by any id that needs remapping, same treatment as `name`/`emoji`). Organizational metadata like tag names belongs with the team, unlike `dailyNotes`/`Person.notes` which stay excluded as personal content.

## Feature A — Due/overdue reminders

### `src/core/due.ts` (new, pure, unit-testable)

```ts
export interface DueItem {
  loc: Loc; title: string; teamName: string; date: string; kind: 'action' | 'milestone'
}
export interface DueBuckets { overdue: DueItem[]; dueSoon: DueItem[] }

export function collectDueItems(doc: Doc, today: string): DueBuckets
```

Walks every team's `actionItems` (skip `status === 'done' | 'cancelled'`, skip `dueDate === null`) and `milestones` (skip `done`), classifies each by comparing its date string to `today` and `today + prefs.dueSoonDays` (plain ISO string comparison, same style `isOverdue` in `action-items.ts` already uses — `date < today` is overdue). Both buckets sorted ascending by date. `isOverdue`'s existing "strictly before today, not done/cancelled" definition for action items is reused as-is so the Kanban card's own overdue styling and this feature never disagree.

### Sidebar (`src/ui/sidebar.ts`)

- A new fixed button, same slot/pattern as the existing `➕` add-team button: shows a badge with the total overdue+due-soon count (styled red if `overdue.length > 0`, amber if only `dueSoon.length > 0`, hidden entirely at zero). Click opens the due list (see below).
- Each team row (`.tt-team-item`) additionally gets a small count badge next to its name when that team has any due items — lets a user spot which team needs attention without opening the list, consistent with the two-part surface approved in brainstorming.
- Recomputed via `store.subscribe()` (already wired for team-list re-render) — no separate polling; a doc mutation is the only thing that can change due status anyway (no wall-clock timer needed beyond the date already changing daily, which a normal re-render on next interaction picks up — same as the daily-notes calendar's "today" marker today).

### Due list (modal, not a pane)

Reuses `showModal` (same infra as team add/edit) rather than a pane-manager module or a dropdown like search's. Rejected pane-manager module because `Loc` is always `{teamId, ref}` — pane history, split view, and Alt+1..9 team switching all assume single-team scope, and a cross-team view would need to special-case that everywhere. `search-ui.ts`'s dropdown already sidesteps this same problem by living outside the pane system, but a dropdown's inline-under-header shape fits a text query, not a two-section browsable list — a modal fits better here.

Content: two headed sections ("Overdue" / "Due soon"), each row = icon (kind) + title + team name + formatted date with a relative badge (`"3d overdue"` / `"in 2d"`). Clicking a row: close the modal, `switchTeam()` if the row's team isn't active (same guard `search-ui.ts`'s `commit()` uses), then `pm.openInFocused(loc)`. Empty state when both buckets are empty.

### Prefs (`src/ui/prefs.ts`, General tab)

New number input next to `autoSaveMin`'s existing one: `dueSoonDays`, min 1, writes via `store.update(d => { d.prefs.dueSoonDays = n })`.

## Feature B — Named action-item tags

### Edit-tags modal (`src/modules/action-items.ts`)

New button in a new toolbar row above `boardEl` (alongside the tag-filter chips below), opens a `showModal` with 6 rows — color swatch (visual only, not editable — the 6 colors stay fixed) + text input, pre-filled from `team.actionTagNames[color] ?? ''`. Save writes each non-empty trimmed value into `tm.actionTagNames[color]`, and **deletes** the key for an emptied input (`delete tm.actionTagNames[color]`) rather than storing `''`, keeping "unset" a single consistent state.

### Tag display + filter (same file)

- `renderCard()`: card gets a small label span using `team.actionTagNames[item.color] ?? t(lc, COLOR_KEYS[item.color])` — always shows something (today's color name as the fallback), so there's no branching between "tagged" and "untagged" card layouts.
- New chip row above the board: one chip per color (swatch + same fallback-or-custom label), plus an implicit "All" state. Clicking a chip toggles it as the sole active filter (click again clears). This is component-local state (`let activeTagFilter: ActionItem['color'] | null`), **not persisted** to the doc — resets on navigating away/back, same lifetime as `draggedId` and the other transient render-scoped state already in this file.
- `renderAll()`: when a filter is active, cards whose `color !== activeTagFilter` are skipped from each column's body. `doneCountEl`/`cancelledCountEl` zone-label counts stay unfiltered (total counts, matching what "clear zone" would actually delete) — filtering only affects which cards are drawn, not what those counts mean.

## i18n

New keys (both `pt-BR` and `en-US`):
`due_badge_title`, `due_panel_title`, `due_section_overdue`, `due_section_due_soon`, `due_empty`, `due_overdue_by` (interpolated `{days}`), `due_in_days` (interpolated `{days}`), `prefs_due_soon_days_label`, `kanban_edit_tags_btn`, `kanban_edit_tags_title`, `kanban_tag_filter_all`.

## Testing

- `test/due.test.ts` (new): `collectDueItems` — correct bucketing at the boundary (`date === today` is due-soon not overdue; `date === today + dueSoonDays` is the last due-soon day), excludes done/cancelled action items and done milestones, respects a non-default `dueSoonDays`, sorts ascending.
- `test/document.test.ts`: migration 5→6 defaults `prefs.dueSoonDays` to 3 and every team's `actionTagNames` to `{}`; a doc that already has these (re-migration safety, mirrors existing per-step tests) is left untouched.
- `test/sidebar.test.ts`: badge count/color reflects `collectDueItems` output; badge hidden at zero; clicking opens the modal; per-team row badges appear only for teams with due items.
- `test/action-items.test.ts`: edit-tags modal writes/clears `actionTagNames` correctly (including the delete-on-empty behavior); card label falls back to the color name when unnamed; filter hides non-matching cards across all four columns while zone-label counts stay unfiltered.
- `test/team-export.test.ts`: `actionTagNames` round-trips through `buildExport`/`remapForImport` unchanged.

## Out of scope

- No browser/OS notifications (decision 1) — in-app only, and only while the app is open.
- No wall-clock timer/polling for date rollover — due status is recomputed on the next store mutation or remount, same granularity the daily-notes calendar's "today" marker already accepts.
- No free-text tags beyond the 6 fixed colors — naming is the only customization (decision 6's "per-team," not "per-item").
- No multi-select tag filter — one active tag at a time, click again to clear.
- No persistence of the active tag filter across navigation or across sessions.
- No change to `core/search.ts` — tag names are not searchable (decision 7).
