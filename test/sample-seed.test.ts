import { buildSampleBytes, SAMPLE_FILENAME } from '../scripts/sample-seed.mjs'
import { parsePlain } from '../src/core/crypto'
import { SCHEMA_VERSION, createEmptyDocument } from '../src/core/document'
import { oneOnOneOverdueDays } from '../src/core/cadence'
import { todayIso } from '../src/core/i18n'

// The sample file is built by scripts/build.mjs from hand-written literals; this opens it through
// the app's own parser (migrate + shape check), so a persisted-shape change that the script has
// not followed fails here instead of in front of someone clicking the README link. The README
// screenshots and the feature tour are taken from the same file.
test('the sample file opens as a current, populated, password-less document', () => {
  const doc = parsePlain(buildSampleBytes())
  expect(doc).not.toBeNull()
  expect(doc!.schemaVersion).toBe(SCHEMA_VERSION)
  expect(doc!.teams.length).toBeGreaterThanOrEqual(4)
  for (const team of doc!.teams.filter((t) => t.id !== 't-general')) {
    expect(team.members.length).toBeGreaterThan(0)
    expect(team.actionItems.length).toBeGreaterThan(0)
    expect(team.milestones.length).toBeGreaterThan(0)
    expect(team.risks.length).toBeGreaterThan(0)
    expect(Object.keys(team.dailyNotes).length).toBeGreaterThan(0)
  }
})

test('every card sits in a column its team defines', () => {
  const doc = parsePlain(buildSampleBytes())!
  for (const team of doc.teams) {
    const columns = new Set(['todo', 'done', 'cancelled', ...(team.actionColumns ?? []).map((c) => c.id)])
    for (const card of team.actionItems) expect(columns.has(card.status), `${team.name}: ${card.summary}`).toBe(true)
  }
})

// migrate() leaves a current-schema file's prefs and templates alone, so stale literals would ship as they are.
test('prefs and templates are what a new en-US document gets', () => {
  const doc = parsePlain(buildSampleBytes())!
  const fresh = createEmptyDocument('en-US')
  const shape = (tpls: typeof fresh.templates) => tpls.map(({ name, scope, body }) => ({ name, scope, body }))
  expect(shape(doc.templates)).toEqual(shape(fresh.templates))
  const freshOneOnOne = fresh.templates.find((tpl) => tpl.id === fresh.prefs.oneOnOneTemplateId)!
  expect(doc.templates.find((tpl) => tpl.id === doc.prefs.oneOnOneTemplateId)?.name).toBe(freshOneOnOne.name)
  expect({ ...doc.prefs, oneOnOneTemplateId: null }).toEqual({ ...fresh.prefs, oneOnOneTemplateId: null })
})

// The tour and the person screenshot run New 1:1 on Mei: she must be overdue and have open items to carry.
test('Mei is overdue for a 1:1 and has open items to carry forward', () => {
  const doc = parsePlain(buildSampleBytes())!
  const mei = doc.teams[0]!.members.find((p) => p.name === 'Mei Chen')!
  expect(oneOnOneOverdueDays(mei, 'members', doc.prefs, todayIso())).toBeGreaterThan(0)
  expect(mei.notes).toMatch(/^- \[ \] \S/m)
})

test('the sample keeps the .tmv extension the README link advertises', () => {
  expect(SAMPLE_FILENAME).toMatch(/\.tmv$/)
})
