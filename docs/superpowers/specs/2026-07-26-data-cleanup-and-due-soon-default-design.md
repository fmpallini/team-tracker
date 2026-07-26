# Data cleanup button + due-soon default change

Date: 2026-07-26

## 1. Due-soon default: 3 → 7 days

`prefs.dueSoonDays` controls the sidebar's overdue/due-soon window (`src/core/due.ts`). Two hardcoded `3`s become `7`:

- `src/core/document.ts:12` — default prefs for a brand-new document.
- `src/core/document.ts:90` — migration fallback (`prefs.dueSoonDays = prefs.dueSoonDays ?? 3`) for files whose schema predates the field.

Existing files that already have an explicit `dueSoonDays` value are untouched — this only changes what "not set" resolves to. No schema bump: the field already exists, only the default literal changes.

## 2. Cross-team cleanup button

Adds a "Cleanup" section to the Prefs → Data tab (`src/ui/prefs.ts` → `renderData`), below the existing Import section. Operates across every team in the document in one action (not scoped to the active team).

### What it deletes

Given a user-supplied `days` value and today's date:

- **Action items** with `status === 'done' || status === 'cancelled'` (both terminal states, per `isActionActive` in `src/core/due.ts`) — deleted regardless of age.
- **Milestones** with `done === true` — deleted regardless of age.
- **Risks** with `closed === true` — deleted regardless of age.
- **Daily notes** (`team.dailyNotes` keys are ISO date strings) — deleted when the date is strictly more than `days` days before today (i.e. `diffDays(today, date) > days` stays deleted; a note exactly `days` old is kept). Uses `diffDays` from `src/core/date.ts`.

This applies identically to every team in `doc.teams`.

### Core logic — `src/core/cleanup.ts` (new, pure, no DOM)

```ts
export interface CleanupCounts { actions: number; milestones: number; risks: number; dailyNotes: number }

export function countCleanupTargets(doc: Doc, days: number, today: string): CleanupCounts
export function applyCleanup(doc: Doc, days: number, today: string): void  // mutates doc.teams in place
```

`applyCleanup` is called from inside `store.update()` so it participates in the normal dirty/undo/save flow. `countCleanupTargets` is read-only, used to render the confirm-dialog preview and re-run live if the user edits the days field before confirming.

### UI — `src/ui/prefs.ts`

New section in `renderData`, after the Import section:

- Heading + short hint text (cross-team, cannot be undone).
- Number input, free field, label "Delete daily notes older than (days)", same clamp pattern as the existing `dueSoonInput`/`autoSaveInput` (min 1, max 3650, round, clamp on change; no default pre-filled beyond a reasonable starting value — reuse `prefs.dueSoonDays` as the initial value since it's already a "how many days matter" number the user has configured).
- "Clean up" button. On click:
  1. Compute `countCleanupTargets(store.doc, days, todayIso())`.
  2. If all four counts are zero, show a confirm modal saying there's nothing to clean (single OK-style dismiss, no destructive action).
  3. Otherwise show a confirm modal (existing `showModal`/confirm pattern, matching `confirmDelete` styling) listing the counts, e.g. "8 actions, 2 milestones, 1 risk, and 45 daily notes across all teams will be permanently deleted. This cannot be undone."
  4. On confirm: `store.update((d) => applyCleanup(d, days, todayIso()))`, close modal, `toast(...)` success message.

### i18n

New keys in both `pt-BR` and `en-US` blocks of `src/core/i18n.ts`, following the existing `data_export_*`/`data_import_*` naming convention: `data_cleanup_heading`, `data_cleanup_hint`, `data_cleanup_days_label`, `data_cleanup_btn`, `data_cleanup_confirm_title`, `data_cleanup_confirm_body` (interpolated with the four counts), `data_cleanup_nothing_title`, `data_cleanup_nothing_body`, `data_cleanup_success_toast`.

### Tests

- `test/core/cleanup.test.ts`: `countCleanupTargets` and `applyCleanup` across multiple teams — mixed statuses, zero-match case, boundary day (note dated exactly `days` old survives, `days + 1` old is removed), confirms other teams'/items' untouched fields are unaffected (no false-positive deletion of active items).
- `test/core/document.test.ts` (existing file, extend): default prefs and pre-field-migration both yield `dueSoonDays === 7`.
