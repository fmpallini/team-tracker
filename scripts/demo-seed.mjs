// scripts/demo-seed.mjs — builds the dummy document the short demo video
// records against, serialised as a password-less `.tmv` (plain text).
//
// Why a pre-built file instead of an on-camera setup flow: the short cut used
// to create the file + 4 teams + a person + a task live, then ffmpeg-trim the
// raw recording to hide it. That is brittle (every dialog is a chance to
// flake) and still records ~15s of nothing worth watching. Instead the doc is
// assembled here and demo-video-lib.mjs drops the bytes straight into OPFS for
// the recorded page to open — so the recording starts on a finished,
// populated app.
//
// This file is plain `.mjs` run by bare `node`, which (unlike the Playwright
// test runner) can't resolve the extensionless `./templates` / `./date`
// imports inside src/core — so the document is hand-built here against the
// shapes in src/core/types.ts rather than imported from
// src/core/document.ts. Two guards against drift: `schemaVersion` is read out
// of document.ts by regex (below), and the app runs `migrate()` on open, so a
// forward schema bump that ships its migration still loads this file. If you
// bump SCHEMA_VERSION *and* change a persisted shape, re-check the literals
// here.
//
// Plain text (not encrypted) on purpose: the recorded "Open" is a single
// click with no password prompt, and it doubles as a quiet demo of the
// readable-file option. Format is crypto.ts's `serializePlain`: the ASCII
// header line `TMV-PLAIN\n` followed by raw `JSON.stringify(doc)`.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const SEED_FILENAME = 'platform-engineering.tmv'

const SCHEMA_VERSION = Number(
  readFileSync(path.resolve(HERE, '../src/core/document.ts'), 'utf8').match(/SCHEMA_VERSION\s*=\s*(\d+)/)?.[1]
)
if (!Number.isInteger(SCHEMA_VERSION)) throw new Error('demo-seed: could not read SCHEMA_VERSION from document.ts')

function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** `YYYY-MM-DD` for today shifted by `deltaDays` (negative = past). */
function isoOffset(deltaDays) {
  const d = new Date(todayIso() + 'T00:00:00')
  d.setDate(d.getDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

// createEmptyDocument's default prefs (src/core/document.ts), English locale.
const defaultPrefs = {
  theme: 'system', locale: 'en-US', font: 'system', fontSize: 'M', autoSaveMin: 10,
  palette: 'ledger', dueSoonDays: 7, openRefsInSecondaryPane: false,
  dailyBackupEnabled: false, backupHandleId: null, backupFrequency: 'daily',
}

// builtinTemplates('en-US') (src/core/templates.ts) — only the tour's `1:1`
// beat strictly needs one to exist, but seeding the full set keeps the `/`
// picker realistic.
const builtinTemplates = [
  { id: 'tpl-1on1', name: '1:1', scope: 'personal', body: '## 1:1 — {data}\n### How are they / energy\n- \n### Their topics\n- \n### My topics\n- \n### Feedback\n- \n### Agreed actions\n- ' },
  { id: 'tpl-sbi', name: 'Feedback (SBI)', scope: 'personal', body: '## Feedback — {data}\n**Situation:** \n**Behavior:** \n**Impact:** \n**Agreed:** ' },
  { id: 'tpl-meeting', name: 'Meeting', scope: 'daily', body: '## Meeting — {hora}\n**Attendees:** \n### Agenda\n- \n### Decisions\n- \n### Actions (who → what → when)\n- ' },
  { id: 'tpl-decision', name: 'Decision', scope: 'any', body: '## Decision — {data}\n**Context:** \n**Options considered:** \n**Decision:** \n**Consequences / follow-up:** ' },
  { id: 'tpl-weekly', name: 'Weekly status', scope: 'daily', body: '## Weekly status — {data}\n### Highlights\n- \n### Lowlights\n- \n### New risks\n- \n### Next week\n- ' },
]

// SUGGESTED_TAG_NAME_KEYS (src/core/document.ts) resolved to en-US.
const suggestedTagNames = {
  rust: 'Process', brass: 'People', slate: 'Financial',
  sage: 'Technical', plum: 'Operations', ledger: 'Legal',
}

function emptyTeam(id, name, emoji) {
  return {
    id, name, emoji,
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
    dailyNotes: {},
    actionTagNames: { ...suggestedTagNames },
    actionColumns: [{ id: 'wip', name: 'WIP', order: 0 }],
    generalNotes: '',
  }
}

/**
 * Team 1 — the one every caption in the tour points at. Deliberately dense: a
 * real three-level org tree, cards spread across a custom column layout, four
 * milestones and four risks scattered across the exposure quadrant so the
 * chart looks lived-in and a drag has somewhere to land.
 */
function buildStarTeam() {
  const team = emptyTeam('t-plat', 'Platform Engineering', '🚀')

  // Mei carries real notes so the org-chart double-click in the tour opens a
  // populated person page, not a blank one.
  const meiNotes = [
    '## Focus',
    'Leading the ingress load-testing workstream for the cutover.',
    '',
    '## Recent 1:1 — 08/28',
    '- Wants to own the staging dry-run end to end — agreed.',
    '- Blocked briefly on vault access; unblocked by Nadia.',
    '- Growth: pairing more with SRE before taking the on-call rotation.',
  ].join('\n')

  team.members = [
    { id: 'm-miguel', name: 'Miguel Fernandez', role: 'Senior Backend Engineer', parentId: null, order: 0, notes: '' },
    { id: 'm-mei', name: 'Mei Chen', role: 'Platform Engineer', parentId: 'm-miguel', order: 0, notes: meiNotes },
    { id: 'm-diego', name: 'Diego Silva', role: 'Associate Platform Engineer', parentId: 'm-mei', order: 0, notes: '' },
    { id: 'm-aisha', name: 'Aisha Patel', role: 'Site Reliability Lead', parentId: 'm-miguel', order: 1, notes: '' },
    { id: 'm-tom', name: 'Tom Becker', role: 'Site Reliability Engineer', parentId: 'm-aisha', order: 0, notes: '' },
    { id: 'm-nadia', name: 'Nadia Rahman', role: 'Backend Engineer', parentId: 'm-miguel', order: 2, notes: '' },
  ]
  team.stakeholders = [
    { id: 's-priya', name: 'Priya Anand', role: 'Engineering Manager', parentId: null, order: 0, notes: '' },
  ]

  // 'todo' / 'done' / 'cancelled' are the fixed columns; the middle ones
  // (here "In Review" then "In Progress") live in actionColumns and are what
  // the "columns you define" caption is about. Reuse the seeded 'wip' id for
  // "In Progress" so no card status dangles.
  team.actionColumns = [
    { id: 'review', name: 'In Review', order: 0 },
    { id: 'wip', name: 'In Progress', order: 1 },
  ]
  team.actionItems = [
    { id: 'a1', summary: 'Cut over the auth service to the new cluster', notes: '', status: 'todo', dueDate: isoOffset(12), assignee: 'Miguel Fernandez', color: 'sage', order: 0 },
    { id: 'a2', summary: 'Write the cutover runbook', notes: '', status: 'todo', dueDate: isoOffset(5), assignee: 'Aisha Patel', color: 'rust', order: 1 },
    { id: 'a3', summary: 'Load-test the new ingress tier', notes: '', status: 'todo', dueDate: isoOffset(-2), assignee: 'Mei Chen', color: 'sage', order: 2 },
    { id: 'a4', summary: 'Provision the staging cluster for a dry run', notes: '', status: 'wip', dueDate: isoOffset(1), assignee: 'Diego Silva', color: 'sage', order: 0 },
    { id: 'a5', summary: 'Migrate secrets to the new vault', notes: '', status: 'wip', dueDate: null, assignee: 'Nadia Rahman', color: 'slate', order: 1 },
    { id: 'a6', summary: 'Review the rollback plan with SRE', notes: '', status: 'review', dueDate: isoOffset(3), assignee: 'Aisha Patel', color: 'rust', order: 0 },
    { id: 'a7', summary: 'Sign off on the maintenance window', notes: '', status: 'review', dueDate: isoOffset(4), assignee: 'Priya Anand', color: 'ledger', order: 1 },
    { id: 'a8', summary: 'Decommission the legacy build agents', notes: '', status: 'done', dueDate: null, assignee: 'Tom Becker', color: 'plum', order: 0 },
    { id: 'a9', summary: 'Draft the customer comms', notes: '', status: 'done', dueDate: null, assignee: 'Priya Anand', color: 'brass', order: 1 },
  ]

  team.milestones = [
    { id: 'ms1', date: isoOffset(-30), title: 'Discovery & capacity plan complete', done: true, followup: '' },
    { id: 'ms2', date: isoOffset(-4), title: 'Alpha cluster cutover', done: false, followup: '' },
    { id: 'ms3', date: isoOffset(21), title: 'Beta rollout to all services', done: false, followup: '' },
    { id: 'ms4', date: isoOffset(45), title: 'Legacy cluster decommissioned', done: false, followup: '' },
  ]

  team.risks = [
    { id: 'rk1', title: 'Cloud provider outage during the migration window', chance: 2, impact: 3, plan: 'mitigate', followup: 'Run the cutover in the lowest-traffic window; keep rollback snapshots hot for 48h.', order: 0, closed: false },
    { id: 'rk2', title: 'DNS cutover propagates slower than planned', chance: 3, impact: 2, plan: 'mitigate', followup: '', order: 1, closed: false },
    { id: 'rk3', title: 'Key engineer unavailable for cutover weekend', chance: 1, impact: 2, plan: 'transfer', followup: '', order: 2, closed: false },
    { id: 'rk4', title: 'Secret rotation breaks a downstream service', chance: 2, impact: 1, plan: 'accept', followup: '', order: 3, closed: false },
  ]

  team.dailyNotes = {
    [isoOffset(-3)]: 'Kicked off the Q3 platform migration. Capacity plan signed off by Priya.',
    [isoOffset(-1)]: 'Paired with SRE on the rollback runbook. Ingress load test still pending.',
    [todayIso()]: 'Walked the team through the new cluster topology. Dry run scheduled for Thursday.',
  }

  return team
}

/** Teams 2-4 — light, just real targets for team-switching and Fast Switch. */
function buildSupportingTeam(id, name, emoji, personName, personRole, note) {
  const team = emptyTeam(id, name, emoji)
  team.members = [{ id: id + '-p1', name: personName, role: personRole, parentId: null, order: 0, notes: '' }]
  team.dailyNotes = { [todayIso()]: note }
  return team
}

export function buildSeedDoc() {
  const star = buildStarTeam()
  const teams = [
    star,
    buildSupportingTeam('t-design', 'Design', '🎨', 'Elena Cruz', 'Product Designer', 'Reviewed the migration status-page mockups — ready for handoff.'),
    buildSupportingTeam('t-data', 'Data & Analytics', '📊', 'Sam Okafor', 'Data Analyst', 'Nightly ETL still points at the old cluster — need the new endpoints before cutover.'),
    buildSupportingTeam('t-mktg', 'Marketing', '📣', 'Lena Fischer', 'Comms Lead', 'Drafting customer comms for the maintenance window.'),
  ]

  return {
    schemaVersion: SCHEMA_VERSION,
    prefs: { ...defaultPrefs },
    templates: builtinTemplates.map((t) => ({ ...t })),
    // Open on the star team, split: daily notes (today) left, org chart right
    // — the layout the first beats of the tour expect.
    nav: {
      activeTeamId: star.id, split: true, focusedPane: 0,
      panes: [
        { history: [{ teamId: star.id, ref: { kind: 'daily', date: todayIso() } }], index: 0 },
        { history: [{ teamId: star.id, ref: { kind: 'members' } }], index: 0 },
      ],
      teamSplit: { [star.id]: true },
      sidebarCollapsed: false,
      calendarCollapsed: false,
    },
    teams,
  }
}

export function buildSeedBytes() {
  return new TextEncoder().encode('TMV-PLAIN\n' + JSON.stringify(buildSeedDoc()))
}
