// scripts/sample-seed.mjs — the sample `.tmv` linked from the README: the demo
// document (demo-seed.mjs) grown into a populated workspace, so someone trying
// the app has teams, notes, boards, milestones and risks to poke at.
//
// Built at release time into dist/pwa/sample.tmv (scripts/build.mjs), so it is
// served next to the app and every date in it is relative to the build day —
// "overdue" and "due soon" stay meaningful instead of rotting in a committed
// file. Password-less on purpose: nothing to type before the first click.
import { buildSeedDoc, emptyTeam, isoOffset, todayIso } from './demo-seed.mjs'

export const SAMPLE_FILENAME = 'sample.tmv'

/** Weekdays only, `back` working days before today, oldest first. */
function workdays(back) {
  const days = []
  for (let d = -1; days.length < back; d--) {
    const dow = new Date(isoOffset(d) + 'T00:00:00').getDay()
    if (dow !== 0 && dow !== 6) days.unshift(isoOffset(d))
  }
  return days
}

/** `people`: [id, name, role, parentId | null, notes?] rows, ordered among their siblings by position. */
function people(rows) {
  const seen = new Map()
  return rows.map(([id, name, role, parentId, notes = '']) => {
    const order = seen.get(parentId) ?? 0
    seen.set(parentId, order + 1)
    return { id, name, role, parentId, order, notes }
  })
}

/** `cards`: [summary, status, dueOffsetDays | null, assignee, color] rows. */
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

/** Gives each group (by `groupOf`) consecutive `order` values in array order, so appended rows sort after the seed's. */
function renumber(items, groupOf) {
  const next = new Map()
  for (const item of items) {
    const g = groupOf(item)
    item.order = next.get(g) ?? 0
    next.set(g, item.order + 1)
  }
}

function notesByDay(days, texts) {
  return Object.fromEntries(days.map((d, i) => [d, texts[i % texts.length]]))
}

function enrichStarTeam(team) {
  const days = workdays(10)
  Object.assign(team.dailyNotes, notesByDay(days.slice(0, 7), [
    '## Standup\n- Capacity plan reviewed; two clusters is enough for the first wave.\n- Aisha owns the rollback runbook.\n\n**Mood:** focused, a little nervous about the cutover.',
    '## Meeting — architecture sync\n**Attendees:** Miguel, Aisha, Nadia\n### Decisions\n- Blue/green for the auth service, canary for everything else.\n### Actions\n- Nadia → vault migration plan → this week',
    'Quiet day. Cleared the review queue and answered the vendor questions on pricing.',
    '## 1:1 — Diego\nSettling in well; wants more ownership. Gave him the staging provisioning task.\n- Pair with Mei on Thursdays.',
    'Incident review for last week’s ingress blip: root cause was a stale health-check. Added to the cutover checklist.',
    '## Weekly status\n### Highlights\n- Discovery complete, alpha cluster is up.\n### Lowlights\n- Load test slipped.\n### Next week\n- Dry run on staging.',
    'Budget check-in with Priya. No change to the cutover window; she wants a go/no-go review the day before.',
  ]))
  team.generalNotes = [
    '# Platform migration — working notes',
    '',
    'Moving every service from the legacy cluster to the new one in three waves.',
    '',
    '## Principles',
    '- Roll back first, optimise later.',
    '- One owner per service, written down in Tasks.',
    '- Nothing ships on a Friday.',
    '',
    '## Useful links',
    '- Cutover runbook (draft, owned by Aisha)',
    '- Capacity plan v3',
  ].join('\n')

  const byId = Object.fromEntries(team.members.map((m) => [m.id, m]))
  byId['m-miguel'].notes = '## About\nTech lead for the migration. Strong on backend, delegates well.\n\n## Growth\n- Wants to move toward staff level — needs more visible cross-team work.\n- Agreed to present the cutover plan at the engineering all-hands.'
  byId['m-aisha'].notes = '## 1:1 — recent\n- Worried the rollback window is too tight; asked for a second rehearsal.\n- Interested in mentoring Tom on incident response.\n\n## Feedback\n**Situation:** cutover planning meeting\n**Behavior:** raised the rollback gap early and brought a proposal\n**Impact:** the plan now includes a second rehearsal'
  byId['m-nadia'].notes = '## Focus\nVault migration. Careful, thorough, sometimes slow to ask for help.\n\n- Check in twice a week until the secrets move is done.'

  team.actionItems.push(...cards('ax', [
    ['Agree the go/no-go checklist with Priya', 'review', 6, 'Priya Anand', 'ledger'],
    ['Rehearse the rollback a second time', 'todo', 8, 'Aisha Patel', 'rust'],
    ['Update the on-call rota for cutover week', 'todo', 9, 'Tom Becker', 'plum'],
    ['Compare ingress vendors', 'cancelled', null, 'Mei Chen', 'slate'],
    ['Archive the old cluster dashboards', 'done', null, 'Tom Becker', 'plum'],
  ]))
  renumber(team.actionItems, (c) => c.status)
  team.milestones.push(...milestones('msx', [
    [-15, 'Capacity plan approved', true, 'Signed off by Priya.'],
    [8, 'Dry run on staging', false, 'Needs the new vault in place first.'],
    [70, 'Post-migration review', false],
  ]))
  team.risks.push(...risks('rkx', [
    ['Vendor ships the new ingress release late', 2, 3, 'transfer', 'Contract has a penalty clause; ask for a date in writing.'],
    ['Staging differs from production', 3, 3, 'eliminate', 'Rebuild staging from the same Terraform modules.'],
    ['Legacy build agents flaky during freeze', 1, 1, 'accept', '', true],
  ]))
  renumber(team.risks, () => '')
}

function buildDesign() {
  const team = emptyTeam('t-design', 'Design', '🎨')
  team.members = people([
    ['d-elena', 'Elena Cruz', 'Design Lead', null, '## Focus\nStatus-page redesign and the design-system refresh.\n\n## 1:1\n- Wants to run a user-testing round before the migration lands.'],
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
    '## 1:1 — Yuki\nDiscussed recruiting channels; will start with the customer-success list.',
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
    ['x-sam', 'Sam Okafor', 'Analytics Lead', null, '## Focus\nMoving the nightly ETL to the new cluster.\n\n- Wants a clear freeze window; the finance reports cannot be late.'],
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
    '## 1:1 — Sam\nSam wants a clear freeze window from the platform team.',
  ])
  team.dailyNotes[todayIso()] = 'Nightly ETL still points at the old cluster — need the new endpoints before cutover.'
  return team
}

function buildMarketing() {
  const team = emptyTeam('t-mktg', 'Marketing', '📣')
  team.members = people([
    ['k-lena', 'Lena Fischer', 'Comms Lead', null, '## Focus\nCustomer comms for the maintenance window.\n\n- Prefers a draft two days before anything goes out.'],
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
    '## Meeting — comms sync\n**Attendees:** Lena, Bruno, Aiko\n### Decisions\n- Announce one week before, remind the day before.',
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
    '- **Person notes** — double-click *Mei Chen* to open her page.',
    '- **Tasks** — drag cards between columns, add a column, filter by tag.',
    '- **Risks** — drag a risk on the chance × impact chart to re-score it.',
    '- **Milestones** — switch between the timeline and the list.',
    '- **Fast Switch** — `Ctrl+Shift+K` jumps to any module, person or favorite in any team.',
    '- **Search** — `Ctrl+Shift+F` searches every team at once.',
    '- **Teams** — `Alt+1`…`Alt+9` switch teams.',
    '- **Settings** — try the dark theme and a different palette.',
    '',
    '## Good to know',
    '- This file is **not** password-protected. Use *Settings → Security* to add a password.',
    '- Dates are relative to the day this sample was published, so a few items are already overdue — on purpose.',
    '- When you are done, close the file with `Ctrl+Alt+L` and start your own from the start screen.',
  ].join('\n')
  team.members = []
  team.dailyNotes = {}
  return team
}

export function buildSampleDoc() {
  const doc = buildSeedDoc()
  enrichStarTeam(doc.teams[0])
  doc.teams = [doc.teams[0], buildDesign(), buildData(), buildMarketing(), buildGeneral()]
  doc.favorites.push({ teamId: 't-general', ref: { kind: 'general' } })
  return doc
}

export function buildSampleBytes() {
  return new TextEncoder().encode('TMV-PLAIN\n' + JSON.stringify(buildSampleDoc()))
}
