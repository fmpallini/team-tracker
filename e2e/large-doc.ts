// e2e/large-doc.ts — a deliberately large synthetic document plus the flow that
// opens it, shared by the latency specs (perf.spec.ts, nav-cost.spec.ts). It is
// written straight into OPFS in the app's own password-less `.tmv` format
// (`TMV-PLAIN\n` + JSON — see core/crypto.ts's serializePlain) and opened
// through the same real File System Access path every other e2e spec uses;
// `createEmptyDocument`/`createEmptyTeam` come from src so the seed can never
// drift from the current schema.
import { expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, writeOpfsFile, setNextOpenName } from './opfs-shim'
import { blockUpdateCheck } from './helpers'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Doc } from '../src/core/types'

export const TEAMS = 20
export const ITEMS_PER_TEAM = 100
export const NOTES_PER_TEAM = 60

/** A document far larger than a realistic one, so any work that scales with size shows up as time rather than as a hunch. */
export function buildLargeDoc(): Doc {
  const doc = createEmptyDocument('en-US')
  for (let t = 0; t < TEAMS; t++) {
    const team = createEmptyTeam(`team-${t}`, `Team ${t}`, '🚀', 'en-US')
    for (let i = 0; i < ITEMS_PER_TEAM; i++) {
      team.actionItems.push({
        id: `t${t}-a${i}`, summary: `Action item ${i} for team ${t}`, status: 'todo',
        dueDate: null, assignee: `Person ${i % 7}`, order: i, notes: `Notes body ${i} `.repeat(4), color: 'ledger',
      })
      team.milestones.push({ id: `t${t}-m${i}`, date: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`, title: `Milestone ${i}`, done: false, followup: `Follow-up ${i} `.repeat(3) })
      team.risks.push({ id: `t${t}-r${i}`, title: `Risk ${i}`, chance: (i % 3) + 1, impact: (i % 3) + 1, plan: 'mitigate', followup: `Mitigation ${i} `.repeat(3), order: i, closed: false })
    }
    for (let d = 0; d < NOTES_PER_TEAM; d++) {
      const date = `2026-06-${String((d % 28) + 1).padStart(2, '0')}`
      team.dailyNotes[date] = `Daily note for ${date} in team ${t}. ${'Some body text. '.repeat(20)}`
    }
    doc.teams.push(team)
  }
  doc.nav.activeTeamId = doc.teams[0]!.id
  return doc
}

/** Opens `doc` (default: the large one) through the real OPFS-backed open flow and waits for the shell. */
export async function openLargeDoc(page: Page, doc: Doc = buildLargeDoc()): Promise<void> {
  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)

  const payload = `TMV-PLAIN\n${JSON.stringify(doc)}`
  const bytes = Array.from(new TextEncoder().encode(payload))
  await writeOpfsFile(page, 'large.tmv', bytes)
  await setNextOpenName(page, 'large.tmv')

  // Password-less files are detected from the header, so this opens straight
  // through with no password prompt.
  await page.getByRole('button', { name: /Open/ }).first().click()
  await expect(page.locator('.tt-shell')).toBeVisible()
}
