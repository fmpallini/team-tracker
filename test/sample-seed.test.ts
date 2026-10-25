import { buildSampleBytes, SAMPLE_FILENAME } from '../scripts/sample-seed.mjs'
import { parsePlain } from '../src/core/crypto'
import { SCHEMA_VERSION } from '../src/core/document'

// The sample file is built by scripts/build.mjs from hand-written literals; this opens it through
// the app's own parser (migrate + shape check), so a persisted-shape change that the script has
// not followed fails here instead of in front of someone clicking the README link.
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

test('the sample keeps the .tmv extension the README link advertises', () => {
  expect(SAMPLE_FILENAME).toMatch(/\.tmv$/)
})
