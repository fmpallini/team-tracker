# Team Tracker — Team export/import (design)

Date: 2026-07-16. Approved by user on this date (text-only brainstorming, no visual companion — this is a data/flow feature, not a layout one).

## Goal

Let a user move one or more teams between `.tmv` files as a plain, unencrypted JSON file — e.g. sharing an org chart and its action items/milestones/risks with someone else, or seeding a new file from an old one — without ever carrying along personal or daily notes. Lives in a new **Data** tab in the Prefs modal, alongside General/Templates/Security/About.

## Decisions (from brainstorming)

1. **Scope**: multi-select, not whole-document and not single-team. Export shows a checklist of the current file's teams; user checks any subset. Import shows the same kind of checklist, built from whatever teams are in the picked file.
2. **What's included per team**: everything except two specific fields — `Team.dailyNotes` and each `Person.notes` (stakeholders and members). `ActionItem.notes`, `Milestone.followup`, and `Risk.followup` are **included** — they're intrinsic to the item (a risk's mitigation plan, a task's detail), not personal journaling, and stripping them would gut imported items. This exclusion is structural, not a filter that could be toggled or missed: the export type has no field to carry `dailyNotes`/`Person.notes` in the first place.
3. **Import collision handling**: always append as a new team with fresh IDs — never merge into or overwrite an existing team. Every imported team's name gets `" (imported)"` appended unconditionally (not just on name collision), so it's always visually obvious which teams came from a file, with no collision-detection logic needed.
4. **File format**: plain, unencrypted JSON. No password prompt anywhere in this flow, even though the export now carries action items/risks/milestones (not just an org chart) — same trust model as exporting a CSV from any other tool. The file is meant to be portable/diffable/greppable; encrypting it would work against that and duplicate `.tmv`'s job.
5. **Version gate**: reuses `SCHEMA_VERSION` directly (no second version number to maintain). Export stamps the current value. Import rejects a file whose `schemaVersion` is *greater* than the app's (same `SchemaTooNewError` concept as opening a newer `.tmv`). A file whose `schemaVersion` is *lower* gets migrated up automatically before import — see Migration section.
6. **UI placement**: new "Data" tab (5th, after About) rather than folding into General — the team checklists need room, matching why Templates already gets its own tab.
7. **Visible reassurance**: both the Export and Import sections carry a small fixed caption stating personal/daily notes are never included — true by construction in the code, but stated on-screen too, right where the user is about to click.

## Data model — export file shape

```ts
// src/core/team-export.ts
export interface ExportedPerson {
  id: string; name: string; role: string
  parentId: string | null; order: number
  // no `notes` field — structurally absent, not stripped at write time
}
export interface ExportedTeam {
  name: string; emoji: string
  stakeholders: ExportedPerson[]; members: ExportedPerson[]
  actionItems: ActionItem[]      // full shape, notes included (see decision 2)
  milestones: Milestone[]        // full shape, followup included
  risks: Risk[]                  // full shape, followup included
  // no `id`, no `dailyNotes` — id is regenerated on import regardless
}
export interface TeamExportFile {
  kind: 'team-tracker-teams-export'
  schemaVersion: number
  exportedAt: string   // ISO timestamp, informational only
  teams: ExportedTeam[]
}
```

`kind` exists purely so `parseImportFile` can reject an unrelated JSON file with a clear error instead of a confusing partial-parse failure.

Example file:

```json
{
  "kind": "team-tracker-teams-export",
  "schemaVersion": 5,
  "exportedAt": "2026-07-16T20:00:00.000Z",
  "teams": [
    {
      "name": "Engineering", "emoji": "🚀",
      "stakeholders": [{ "id": "a1", "name": "Priya", "role": "Sponsor", "parentId": null, "order": 0 }],
      "members": [{ "id": "a2", "name": "Marcus", "role": "Eng", "parentId": null, "order": 0 }],
      "actionItems": [{ "id": "b1", "summary": "Access review", "notes": "SOC2 audit", "status": "todo", "dueDate": null, "assignee": "Marcus", "color": "slate", "order": 0 }],
      "milestones": [],
      "risks": []
    }
  ]
}
```

## Architecture

New headless module `src/core/team-export.ts` (no DOM — matches `crypto.ts`/`document.ts`), plus a UI section added to `src/ui/prefs.ts`'s new Data tab.

### `src/core/team-export.ts` — pure, unit-testable functions

- `buildExport(teams: Team[]): TeamExportFile` — maps each `Team` to `ExportedTeam`, dropping `id`/`dailyNotes` and each person's `notes`. Stamps `schemaVersion: SCHEMA_VERSION` and `exportedAt: new Date().toISOString()`.
- `parseImportFile(bytes: Uint8Array): TeamExportFile` — `JSON.parse`s the text, throws `InvalidExportFileError` if `kind` doesn't match or the shape is unparseable, throws `ExportTooNewError` if `schemaVersion > SCHEMA_VERSION`. Does **not** migrate — that's a separate step so `parseImportFile` stays a pure validation/parse function.
- `remapForImport(teams: ExportedTeam[]): Team[]` — the one genuinely new piece of logic. For each team: generates a fresh team `id`, appends `" (imported)"` to `name`, and rebuilds `stakeholders`/`members` with fresh `Person.id`s via an old-ID→new-ID map (scoped per team, per list — stakeholders and members remap independently) so `parentId` chains stay internally consistent. `actionItems`/`milestones`/`risks` each get a fresh `id` too (flat, no parent-links to rebuild there).

### `src/core/document.ts` — new export, reusing the existing migration ladder

```ts
export function migrateTeams(teams: unknown, fromVersion: number): Team[] {
  const shim = { schemaVersion: fromVersion, teams }
  return migrate(shim).teams
}
```

The existing `MIGRATIONS` functions already guard on `d.nav`/`d.prefs` presence before touching them (see migrations 2 and 4), so feeding them a shim missing those keys safely no-ops the doc-scoped steps while the team-scoped ones (1: risk/actionItem/milestone defaults; 3: actionItem `text`→`summary`/`done`→`status`/`color`) apply correctly. Zero duplicated migration logic — same table, same guarantees `.tmv` opening already has.

### Import flow (in `prefs.ts`)

1. User picks a `.json` file via `<input type="file" accept=".json">` (plain one-shot read, no File System Access session — nothing here needs a write-back handle).
2. `parseImportFile(bytes)` → on failure, `showErrorModal` with a message keyed to which error was thrown.
3. If `file.schemaVersion < SCHEMA_VERSION`: `migrateTeams(file.teams, file.schemaVersion)` before continuing.
4. Render the checklist (team icon + name + one-line summary: "4 stakeholders · 6 members · 5 action items · 2 milestones · 2 risks"), all checked by default.
5. On "Import": `remapForImport()` the checked subset, `store.update(d => d.teams.push(...newTeams))`, toast success, close back to the checklist's empty state.

### Export flow (in `prefs.ts`)

1. Checklist of `store.doc.teams` (icon + name), unchecked by default.
2. On "Export": `buildExport()` the checked subset → `JSON.stringify(..., null, 2)` → save via the File System Access "save" picker when supported (same pattern as `.tmv` create), else `downloadFallback` — filename `team-tracker-export-<YYYY-MM-DD>.json`.

## i18n

New keys (both `pt-BR` and `en-US`): `prefs_tab_data`, `data_export_heading`, `data_export_hint` (the "notes never included" caption), `data_export_empty` (no teams to export), `data_export_btn`, `data_import_heading`, `data_import_hint` (same caption, repeated), `data_import_pick_btn`, `data_import_summary` (interpolated: stakeholders/members/action-items/milestones/risks counts), `data_import_btn`, `data_import_success_toast`, `err_export_invalid_file`, `err_export_too_new`.

## Testing

`test/team-export.test.ts` (new, pure-function coverage):
- `buildExport` strips `dailyNotes` and every `Person.notes`; keeps `ActionItem.notes`/`Milestone.followup`/`Risk.followup`; omits team `id`.
- `parseImportFile` rejects wrong `kind`, rejects `schemaVersion` greater than current, accepts valid files.
- `remapForImport` gives every team/person/action-item/milestone/risk a fresh ID, correctly rebuilds `parentId` chains against the new person IDs, appends `" (imported)"` to every name unconditionally.
- `migrateTeams` (in `document.test.ts`, alongside the existing migration-ladder tests): a v1-shaped team gets `risk.closed`/`actionItem.notes`/`milestone.followup` defaulted; a v3-shaped team's `actionItems` get renamed/reshaped — mirrors the existing per-version migration test style.

`test/prefs.test.ts` additions: Data tab renders both checklists, export checkbox selection reaches `buildExport`, import file pick → checklist → confirm reaches `store.update`, error modal shows on invalid/too-new file.

## Out of scope

- No merge/update-in-place on name collision (decision 3) — every import is strictly additive.
- No partial-team export (e.g. "just the org chart, not the action items") — it's whole-team-minus-notes or nothing, per the checklist granularity being *which teams*, not *which fields*.
- No password/encryption option for the export file (decision 4).
- No drag-and-drop file import — a standard file picker button only.
