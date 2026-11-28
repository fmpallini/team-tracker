// scripts/sample-seed.mjs — the one made-up workspace every public picture of
// the app is taken from: the sample `.tmv` linked from the README, the feature
// tour (generate-demo-video-short.mjs) and the README screenshots
// (generate-screenshots.mjs). Five teams; the first one, Platform Engineering,
// is the one the tour and the screenshots point at, so it is the dense one.
//
// Built at release time into dist/pwa/sample.tmv (scripts/build.mjs), so it is
// served next to the app and every date in it is relative to the build day —
// "overdue" and "due soon" stay meaningful instead of rotting in a committed
// file. The media scripts build it the same way on the day they run.
//
// Password-less on purpose (crypto.ts's `serializePlain`: the ASCII header
// line `TMV-PLAIN\n`, then raw `JSON.stringify(doc)`): nothing to type before
// the first click, and the recorded "Open" needs no password prompt.
//
// Hand-built literals, not imports from src/core: this file runs under bare
// `node` (build.mjs and the media scripts), which cannot resolve src/core's
// extensionless imports. test/sample-seed.test.ts guards the drift: it opens
// the bytes through the app's own parser, and checks the prefs and templates
// below against createEmptyDocument('en-US'). `schemaVersion` is read out of
// document.ts by regex, and the app runs `migrate()` on open.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const SAMPLE_FILENAME = 'sample.tmv'

const SCHEMA_VERSION = Number(
  readFileSync(path.resolve(HERE, '../src/core/document.ts'), 'utf8').match(/SCHEMA_VERSION\s*=\s*(\d+)/)?.[1]
)
if (!Number.isInteger(SCHEMA_VERSION)) throw new Error('sample-seed: could not read SCHEMA_VERSION from document.ts')

// --- Dates (local calendar days, as the app counts them) ----------------------

function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function todayIso() {
  return isoOf(new Date())
}
/** `YYYY-MM-DD` for today shifted by `deltaDays` (negative = past). */
function isoOffset(deltaDays) {
  const d = new Date()
  d.setDate(d.getDate() + deltaDays)
  return isoOf(d)
}
/** "Tue, 11/10/2026": what a template's `{date}` gives in en-US (i18n.ts formatDateWithWeekday). */
function weekdayDate(iso) {
  const [y, m, d] = iso.split('-')
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Number(y), Number(m) - 1, Number(d)).getDay()]
  return `${dow}, ${m}/${d}/${y}`
}
/** Weekdays only, `back` working days before today, oldest first. */
function workdays(back) {
  const days = []
  for (let d = -1; days.length < back; d--) {
    const dow = new Date(isoOffset(d) + 'T00:00:00').getDay()
    if (dow !== 0 && dow !== 6) days.unshift(isoOffset(d))
  }
  return days
}

// --- What createEmptyDocument('en-US') seeds (src/core/document.ts) -----------

const ONE_ON_ONE_TEMPLATE_ID = 'tpl-1on1'

const defaultPrefs = {
  theme: 'system', locale: 'en-US', font: 'system', fontSize: 'M', autoSaveMin: 60,
  palette: 'ledger', dueSoonDays: 7, openRefsInSecondaryPane: false,
  ctrlWheelFontSize: true, dailyEdgeScroll: true,
  oneOnOneDefaultDays: 14, oneOnOneTemplateId: ONE_ON_ONE_TEMPLATE_ID,
}

// builtinTemplates('en-US') (src/core/templates.ts), with fixed ids so every copy of the file is the same document.
const builtinTemplates = [
  { id: 'tpl-first', name: 'First 1:1', scope: 'personal', body: '### First 1:1 — {date}\n\n**How they like to work / communicate**\n- \n**What motivates them**\n- \n**Career goals**\n- \n**What they need from me**\n- \n**Anything I should know**\n- \n**Agreed actions**\n- [ ] ' },
  { id: ONE_ON_ONE_TEMPLATE_ID, name: '1:1', scope: 'personal', body: '### 1:1 — {date}\n\n**Carried over**\n{carryover}\n**How are they / energy**\n- \n**Their topics**\n- \n**My topics**\n- \n**Feedback (given / received)**\n- \n**Agreed actions**\n- [ ] ' },
  { id: 'tpl-sbi', name: 'Feedback (SBI)', scope: 'personal', body: '### Feedback — {date}\n\n**Situation:** \n**Behavior:** \n**Impact:** \n**Agreed**\n- [ ] ' },
  { id: 'tpl-career', name: 'Career conversation', scope: 'personal', body: '### Career conversation — {date}\n\n**Where they want to be in 1–2 years**\n- \n**Strengths**\n- \n**Growth areas**\n- \n**Opportunities**\n- \n**Next steps**\n- [ ] ' },
  { id: 'tpl-meeting', name: 'Meeting', scope: 'any', body: '### Meeting — {time}\n\n**Attendees:** \n**Agenda**\n- \n**Decisions**\n- \n**Actions (who → what → when)**\n- [ ] ' },
  { id: 'tpl-weekly', name: 'Weekly status', scope: 'any', body: '### Weekly status — {date}\n\n**Highlights**\n- \n**Lowlights**\n- \n**Milestones**\n- \n**New risks**\n- \n**Next week**\n- ' },
  { id: 'tpl-decision', name: 'Decision', scope: 'any', body: '### Decision — {date}\n\n**Context:** \n**Options considered:** \n**Decision:** \n**Decided by:** \n**Revisit on:** \n**Consequences / follow-up**\n- [ ] ' },
  { id: 'tpl-retro', name: 'Retro / Incident', scope: 'any', body: '### Retro — {date}\n\n**What happened / timeline**\n- \n**Impact**\n- \n**What went well**\n- \n**What to improve**\n- \n**Actions**\n- [ ] ' },
]

// SUGGESTED_TAG_NAME_KEYS (src/core/document.ts) resolved to en-US.
const suggestedTagNames = {
  rust: 'Process', brass: 'People', slate: 'Financial',
  sage: 'Technical', plum: 'Operations', ledger: 'Legal',
}

// --- Row builders --------------------------------------------------------------

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
 * `rows`: [id, name, role, parentId | null, notes?, lastOneOnOneOffset?] rows, ordered among their siblings by
 * position. A person with no offset has never had a 1:1 recorded, so is never due one.
 */
function people(rows) {
  const seen = new Map()
  return rows.map(([id, name, role, parentId, notes = '', lastOff]) => {
    const order = seen.get(parentId) ?? 0
    seen.set(parentId, order + 1)
    return { id, name, role, parentId, order, notes, ...(lastOff === undefined ? {} : { lastOneOnOne: isoOffset(lastOff) }) }
  })
}

/** `rows`: [summary, status, dueOffsetDays | null, assignee, color] rows. */
function cards(prefix, rows) {
  const perStatus = new Map()
  return rows.map(([summary, status, due, assignee, color], i) => {
    const order = perStatus.get(status) ?? 0
    perStatus.set(status, order + 1)
    return { id: `${prefix}${i + 1}`, summary, notes: '', status, dueDate: due === null ? null : isoOffset(due), assignee, color, order }
  })
}

/** `rows`: [dayOffset, title, done, followup?] rows. */
function milestones(prefix, rows) {
  return rows.map(([off, title, done, followup = ''], i) => ({ id: `${prefix}${i + 1}`, date: isoOffset(off), title, done, followup }))
}

/** `rows`: [title, chance, impact, plan, followup?, closed?] rows. */
function risks(prefix, rows) {
  return rows.map(([title, chance, impact, plan, followup = '', closed = false], i) => ({ id: `${prefix}${i + 1}`, title, chance, impact, plan, followup, order: i, closed }))
}

function notesByDay(days, texts) {
  return Object.fromEntries(days.map((d, i) => [d, texts[i % texts.length]]))
}

// --- Team 1: the one the tour and the screenshots point at -----------------------

/**
 * Mei's page is where the tour and the person screenshot run New 1:1: her last
 * 1:1 was 17 days ago on the 14-day default, so she is 3 days overdue (red on
 * the org chart, in the due list and on her page), and that 1:1 left two open
 * agreed actions for New 1:1 to carry forward.
 */
function meiNotes() {
  return [
    '**Focus**',
    'Leading the ingress load-testing workstream for the cutover.',
    '',
    '---',
    '',
    `### 1:1 — ${weekdayDate(isoOffset(-17))}`,
    '',
    '**How are they / energy**',
    '- Good — energised by owning the load test.',
    '**Their topics**',
    '- Wants to own the staging dry-run end to end — agreed.',
    '- Blocked briefly on vault access; unblocked by Nadia.',
    '**My topics**',
    '- Growth: pair more with SRE before joining the on-call rotation.',
    '**Agreed actions**',
    '- [x] Share the load-test plan with Aisha',
    '- [ ] Book two pairing sessions with SRE',
    '- [ ] Draft the ingress capacity numbers for the go/no-go',
  ].join('\n')
}

function buildStarTeam() {
  const team = emptyTeam('t-plat', 'Platform Engineering', '🚀')

  team.members = people([
    ['m-miguel', 'Miguel Fernandez', 'Senior Backend Engineer', null,
      // Ends on a paragraph: the tour types `/` on a new line after it, and the template picker only opens on a line of its own.
      '**Growth**\n- [ ] Present the cutover plan at the engineering all-hands\n\nTech lead for the migration. Strong on backend, delegates well; wants to move toward staff level.', -6],
    ['m-mei', 'Mei Chen', 'Platform Engineer', 'm-miguel', meiNotes(), -17],
    ['m-aisha', 'Aisha Patel', 'Site Reliability Lead', 'm-miguel',
      `### 1:1 — ${weekdayDate(isoOffset(-12))}\n\n**Their topics**\n- Worried the rollback window is too tight; asked for a second rehearsal.\n- Interested in mentoring Tom on incident response.\n**Agreed actions**\n- [ ] Schedule the second rollback rehearsal\n\n---\n\n### Feedback — ${weekdayDate(isoOffset(-30))}\n\n**Situation:** cutover planning meeting\n**Behavior:** raised the rollback gap early and brought a proposal\n**Impact:** the plan now includes a second rehearsal`, -12],
    ['m-nadia', 'Nadia Rahman', 'Backend Engineer', 'm-miguel',
      '**Focus**\nVault migration. Careful, thorough, sometimes slow to ask for help.\n- Check in twice a week until the secrets move is done.', -4],
    ['m-diego', 'Diego Silva', 'Associate Platform Engineer', 'm-mei', '', -3],
    ['m-tom', 'Tom Becker', 'Site Reliability Engineer', 'm-aisha'],
  ])
  team.stakeholders = people([['s-priya', 'Priya Anand', 'Engineering Manager', null]])

  // 'todo' / 'done' / 'cancelled' are the fixed columns; the middle ones
  // (here "In Review" then "In Progress") live in actionColumns and are what
  // the tour's "columns you define" caption is about. "In Progress" keeps the
  // seeded 'wip' id so no card status dangles.
  team.actionColumns = [
    { id: 'review', name: 'In Review', order: 0 },
    { id: 'wip', name: 'In Progress', order: 1 },
  ]
  team.actionItems = cards('a', [
    ['Cut over the auth service to the new cluster', 'todo', 12, 'Miguel Fernandez', 'sage'],
    ['Write the cutover runbook', 'todo', 5, 'Aisha Patel', 'rust'],
    ['Load-test the new ingress tier', 'todo', -2, 'Mei Chen', 'sage'],
    ['Rehearse the rollback a second time', 'todo', 8, 'Aisha Patel', 'rust'],
    ['Update the on-call rota for cutover week', 'todo', 9, 'Tom Becker', 'plum'],
    ['Provision the staging cluster for a dry run', 'wip', 1, 'Diego Silva', 'sage'],
    ['Migrate secrets to the new vault', 'wip', null, 'Nadia Rahman', 'slate'],
    ['Review the rollback plan with SRE', 'review', 3, 'Aisha Patel', 'rust'],
    ['Sign off on the maintenance window', 'review', 4, 'Priya Anand', 'ledger'],
    ['Agree the go/no-go checklist with Priya', 'review', 6, 'Priya Anand', 'ledger'],
    ['Decommission the legacy build agents', 'done', null, 'Tom Becker', 'plum'],
    ['Draft the customer comms', 'done', null, 'Priya Anand', 'brass'],
    ['Archive the old cluster dashboards', 'done', null, 'Tom Becker', 'plum'],
    ['Compare ingress vendors', 'cancelled', null, 'Mei Chen', 'slate'],
  ])

  team.milestones = milestones('ms', [
    [-30, 'Discovery & capacity plan complete', true, 'Signed off by Priya.'],
    [-4, 'Alpha cluster cutover', false],
    [8, 'Dry run on staging', false, 'Needs the new vault in place first.'],
    [21, 'Beta rollout to all services', false],
    [45, 'Legacy cluster decommissioned', false],
    [70, 'Post-migration review', false],
  ])

  // Spread across the exposure quadrant so the chart looks lived-in; the tour
  // drags rk3 to a new cell and finds rk1 by typing "outage" in Fast Switch.
  team.risks = risks('rk', [
    ['Cloud provider outage during the migration window', 2, 3, 'mitigate', 'Run the cutover in the lowest-traffic window (Sat 02:00 UTC); keep rollback snapshots hot for 48h; on-call fully staffed for the whole cutover.'],
    ['DNS cutover propagates slower than planned', 3, 2, 'mitigate'],
    ['Key engineer unavailable for cutover weekend', 1, 2, 'transfer'],
    ['Secret rotation breaks a downstream service', 2, 1, 'accept'],
    ['Vendor ships the new ingress release late', 2, 3, 'transfer', 'Contract has a penalty clause; ask for a date in writing.'],
    ['Staging differs from production', 3, 3, 'eliminate', 'Rebuild staging from the same Terraform modules.'],
    ['Legacy build agents flaky during freeze', 1, 1, 'accept', '', true],
  ])

  team.dailyNotes = notesByDay(workdays(7), [
    '**Standup**\n- Capacity plan reviewed; two clusters is enough for the first wave.\n- Aisha owns the rollback runbook.\n\n**Mood:** focused, a little nervous about the cutover.',
    '### Meeting — architecture sync\n\n**Attendees:** Miguel, Aisha, Nadia\n**Decisions**\n- Blue/green for the auth service, canary for everything else.\n**Actions (who → what → when)**\n- [ ] Nadia → vault migration plan → this week',
    'Quiet day. Cleared the review queue and answered the vendor questions on pricing.',
    'Settled the dry-run date with Diego; he takes the staging provisioning task.',
    'Incident review for last week’s ingress blip: root cause was a stale health-check. Added to the cutover checklist.',
    '### Weekly status\n\n**Highlights**\n- Discovery complete, alpha cluster is up.\n**Lowlights**\n- Load test slipped.\n**Next week**\n- Dry run on staging.',
    'Budget check-in with Priya. No change to the cutover window; she wants a go/no-go review the day before.',
  ])
  // Ends on a paragraph: the tour types at the end of it (Ctrl+End), which inside a checklist would add list items.
  team.dailyNotes[todayIso()] = [
    '**Before the dry run**',
    '- [x] Staging cluster provisioned',
    '- [ ] Rollback runbook reviewed by SRE',
    '- [ ] Go/no-go checklist agreed with Priya',
    '',
    'Walked the team through the new cluster topology. Dry run scheduled for Thursday.',
  ].join('\n')

  // Rich on purpose: the README's rich-text screenshot is this page.
  team.generalNotes = [
    '## Platform migration — working notes',
    'Moving every service from the legacy cluster to the new one in three waves.',
    '',
    '> Cutover window is Sat 02:00–04:00 UTC — freeze all deploys until then.',
    '',
    '**Principles**',
    '- Roll back first, optimise later.',
    '- One owner per service, written down in Tasks.',
    '- Nothing ships on a Friday.',
    '',
    '**Rollback**',
    '```',
    'kubectl rollout undo deploy/auth -n platform',
    'kubectl get pods -n platform -w',
    '```',
    '',
    'Runbook: [cutover steps](https://wiki.example.com/cutover) · capacity plan v3',
  ].join('\n')

  return team
}

// --- Teams 2-5 ---------------------------------------------------------------------

function buildDesign() {
  const team = emptyTeam('t-design', 'Design', '🎨')
  team.members = people([
    ['d-elena', 'Elena Cruz', 'Design Lead', null, '**Focus**\nStatus-page redesign and the design-system refresh.\n\n**Agreed actions**\n- [ ] Run a user-testing round before the migration lands', -9],
    ['d-jonas', 'Jonas Weber', 'Product Designer', 'd-elena', 'Prefers async feedback in writing. Great with prototypes.'],
    ['d-yuki', 'Yuki Tanaka', 'UX Researcher', 'd-elena'],
    ['d-omar', 'Omar Haddad', 'Visual Designer', 'd-jonas'],
  ])
  team.stakeholders = people([['d-s1', 'Priya Anand', 'Engineering Manager', null]])
  team.actionColumns = [{ id: 'wip', name: 'In Progress', order: 0 }]
  team.actionItems = cards('dx', [
    ['Hand off the status-page mockups', 'todo', 2, 'Jonas Weber', 'sage'],
    ['Recruit five users for the usability round', 'todo', 7, 'Yuki Tanaka', 'plum'],
    ['Audit icon usage across the app', 'wip', 5, 'Omar Haddad', 'sage'],
    ['Design-system colour tokens v2', 'wip', -1, 'Elena Cruz', 'brass'],
    ['Publish the new component library', 'done', null, 'Elena Cruz', 'sage'],
    ['Retire the old logo files', 'done', null, 'Omar Haddad', 'ledger'],
  ])
  team.milestones = milestones('dm', [
    [-20, 'Component library published', true],
    [3, 'Status-page mockups handed off', false],
    [30, 'Usability round complete', false, 'Depends on recruiting five users.'],
  ])
  team.risks = risks('dr', [
    ['Mockups drift from what engineering can build', 2, 2, 'mitigate', 'Weekly walkthrough with the platform team.'],
    ['Not enough participants for the usability round', 2, 1, 'accept'],
  ])
  team.dailyNotes = notesByDay(workdays(6), [
    'Review of the status-page mockups with Priya — approved with two small changes.',
    'Jonas shared the clickable prototype; feedback due Friday.',
    'Recruiting channels with Yuki: she will start with the customer-success list.',
    'Colour-token work is behind. Moved the deadline and told Elena.',
    'Design critique went well. Omar presented the icon audit.',
    'Planning the usability round: five sessions, 45 minutes each.',
  ])
  team.dailyNotes[todayIso()] = 'Reviewed the migration status-page mockups — ready for handoff.'
  return team
}

function buildData() {
  const team = emptyTeam('t-data', 'Data & Analytics', '📊')
  team.members = people([
    ['x-sam', 'Sam Okafor', 'Analytics Lead', null, '**Focus**\nMoving the nightly ETL to the new cluster.\n- Wants a clear freeze window; the finance reports cannot be late.', -5],
    ['x-lucia', 'Lucía Romero', 'Data Engineer', 'x-sam'],
    ['x-ken', 'Ken Watanabe', 'Data Analyst', 'x-sam'],
    ['x-fatima', 'Fatima Zahra', 'Junior Analyst', 'x-ken', 'Started two months ago. Strong SQL; building confidence presenting.'],
  ])
  team.stakeholders = people([['x-s1', 'Priya Anand', 'Engineering Manager', null], ['x-s2', 'Marta Ivanova', 'Finance Director', null, 'Cares about month-end reports above all else.']])
  team.actionColumns = [{ id: 'wip', name: 'In Progress', order: 0 }, { id: 'blocked', name: 'Blocked', order: 1 }]
  team.actionItems = cards('xx', [
    ['Point the nightly ETL at the new endpoints', 'blocked', 4, 'Lucía Romero', 'sage'],
    ['Validate month-end totals after the move', 'todo', 14, 'Ken Watanabe', 'slate'],
    ['Document the dashboard refresh schedule', 'todo', null, 'Fatima Zahra', 'plum'],
    ['Rebuild the churn dashboard', 'wip', 10, 'Ken Watanabe', 'brass'],
    ['Backfill last quarter’s event data', 'wip', -3, 'Lucía Romero', 'sage'],
    ['Retire the unused reporting tables', 'done', null, 'Sam Okafor', 'plum'],
  ])
  team.milestones = milestones('xm', [
    [-10, 'Warehouse schema frozen', true],
    [9, 'ETL running on the new cluster', false],
    [25, 'Month-end report validated', false],
  ])
  team.risks = risks('xr', [
    ['Month-end report late during the migration', 2, 3, 'mitigate', 'Run both pipelines in parallel for one cycle.'],
    ['Backfill overwrites corrected data', 1, 3, 'eliminate', 'Write to a shadow table first.'],
    ['Analyst capacity during the cutover', 3, 1, 'accept'],
  ])
  team.dailyNotes = notesByDay(workdays(5), [
    'ETL dry run failed on the auth step — waiting for the new endpoints.',
    'Fatima presented her first dashboard to the team. Good feedback all round.',
    'Agreed with Marta: month-end gets a parallel run, no big-bang switch.',
    'Backfill is slower than estimated; asked Lucía for a new date.',
    'Sam wants a clear freeze window from the platform team.',
  ])
  team.dailyNotes[todayIso()] = 'Nightly ETL still points at the old cluster — need the new endpoints before cutover.'
  return team
}

function buildMarketing() {
  const team = emptyTeam('t-mktg', 'Marketing', '📣')
  team.members = people([
    ['k-lena', 'Lena Fischer', 'Comms Lead', null, '**Focus**\nCustomer comms for the maintenance window.\n- Prefers a draft two days before anything goes out.'],
    ['k-bruno', 'Bruno Costa', 'Content Writer', 'k-lena'],
    ['k-aiko', 'Aiko Sato', 'Community Manager', 'k-lena'],
  ])
  team.stakeholders = people([['k-s1', 'Priya Anand', 'Engineering Manager', null]])
  team.actionColumns = [{ id: 'wip', name: 'Drafting', order: 0 }]
  team.actionItems = cards('kx', [
    ['Announce the maintenance window to customers', 'todo', 11, 'Lena Fischer', 'rust'],
    ['Prepare the support FAQ', 'wip', 6, 'Bruno Costa', 'plum'],
    ['Brief the community forum moderators', 'todo', 7, 'Aiko Sato', 'brass'],
    ['Update the status-page copy', 'wip', 3, 'Bruno Costa', 'sage'],
    ['Publish the Q3 roadmap post', 'done', null, 'Lena Fischer', 'brass'],
  ])
  team.milestones = milestones('km', [
    [-12, 'Q3 roadmap post live', true],
    [10, 'Customer announcement sent', false, 'Needs the final window from engineering.'],
    [28, 'Post-migration thank-you note', false],
  ])
  team.risks = risks('kr', [
    ['Announcement goes out before the window is confirmed', 2, 3, 'eliminate', 'Single sign-off from Priya before sending.'],
    ['Support floods during the cutover', 2, 2, 'mitigate', 'FAQ + a pinned forum post.'],
  ])
  team.dailyNotes = notesByDay(workdays(4), [
    'Drafted the first version of the customer announcement. Lena wants a softer tone.',
    'Forum moderators briefed; Aiko will watch the first hours of the cutover.',
    'Waiting on engineering for the final window dates.',
    '### Meeting — comms sync\n\n**Attendees:** Lena, Bruno, Aiko\n**Decisions**\n- Announce one week before, remind the day before.',
  ])
  team.dailyNotes[todayIso()] = 'Drafting customer comms for the maintenance window.'
  return team
}

function buildGeneral() {
  const team = emptyTeam('t-general', 'General', '🌐')
  team.generalNotes = [
    '# 👋 Welcome to the sample file',
    '',
    'This is a made-up workspace so you can try Team Tracker. Everything here is fake — edit, drag, delete, break it.',
    '',
    '## Things to try',
    '- **Org chart** — open *Platform Engineering → Members* and drag a person onto another to re-organise the tree.',
    '- **1:1s** — double-click *Mei Chen*: her 1:1 is overdue. Press **+ New 1:1** (`Alt+O`) and her open items carry over.',
    '- **Checklists** — type `[]` or press `Ctrl+Enter` in any note, then click a box to tick it.',
    '- **Tasks** — drag cards between columns, add a column, filter by tag.',
    '- **Risks** — drag a risk on the chance × impact chart to re-score it.',
    '- **Milestones** — switch between the timeline and the list.',
    '- **Fast Switch** — `Ctrl+Shift+K` jumps to any module, person or favorite in any team; type `>` for commands.',
    '- **Search** — `Ctrl+Shift+F` searches every team at once.',
    '- **Teams and modules** — `Alt+1`…`Alt+9` switch teams, `F2`…`F8` switch modules, `F1` opens help.',
    '- **Settings** — try the dark theme and a different palette.',
    '',
    '## Good to know',
    '- This file is **not** password-protected. Use *Settings → Security* to add a password.',
    '- Dates are relative to the day this sample was published, so a few items are already overdue — on purpose.',
    '- When you are done, close the file with `Ctrl+Alt+L` and start your own from the start screen.',
  ].join('\n')
  return team
}

// --- The document ----------------------------------------------------------------

export function buildSampleDoc() {
  const star = buildStarTeam()
  return {
    // Fixed so every copy of the sample is the same document to the browser copy.
    docId: '7e3d1c9a5b2f48e6a0c4d8f1b3a5e792',
    schemaVersion: SCHEMA_VERSION,
    prefs: { ...defaultPrefs },
    templates: builtinTemplates.map((t) => ({ ...t })),
    // Open on the star team, split: today's daily note left, org chart right
    // — the layout the tour's first beats and the first screenshot expect.
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
    teams: [star, buildDesign(), buildData(), buildMarketing(), buildGeneral()],
    // Starred panes in three teams, so Fast Switch opens on a Favorites group
    // that already spans teams; the tour stars the Tasks board live on top.
    favorites: [
      { teamId: star.id, ref: { kind: 'milestones' } },
      { teamId: 't-design', ref: { kind: 'daily', date: todayIso() } },
      { teamId: 't-general', ref: { kind: 'general' } },
    ],
    images: {},
  }
}

export function buildSampleBytes() {
  return new TextEncoder().encode('TMV-PLAIN\n' + JSON.stringify(buildSampleDoc()))
}
