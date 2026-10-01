// e2e/layout-fixtures.ts — a deliberately awkward document (long names, long
// titles, many items) plus the open-it-through-OPFS plumbing, shared by the
// layout regression specs (font-size-layout, scroll-and-overflow). Real layout
// only shows up with real content, so the fixture is the point.
import { expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, writeOpfsFile, setNextOpenName } from './opfs-shim'
import { blockUpdateCheck } from './helpers'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Doc, ModuleRef, Prefs } from '../src/core/types'

export const TEAM_ID = 'team-0'

export interface FixtureOpts {
  sidebarCollapsed?: boolean
  locale?: 'en-US' | 'pt-BR'
  /** Second pane's module; omit for a single pane. */
  splitRight?: ModuleRef
  /** How many root-level stakeholders (a wide, one-row org chart). */
  stakeholderRoots?: number
  /** Make the first few action items due today, so the due panel has rows. */
  dueToday?: boolean
  /** Milestones: 'spread' = months apart, 'dense' = 20 days in a row plus a far outlier cluster. */
  milestones?: 'spread' | 'dense'
}

const isoLocal = (offsetDays: number): string => {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d.toLocaleDateString('en-CA')
}

export function buildDoc(size: Prefs['fontSize'], ref: ModuleRef, opts: FixtureOpts = {}): Doc {
  const locale = opts.locale ?? 'en-US'
  const doc = createEmptyDocument(locale)
  doc.prefs.fontSize = size
  const team = createEmptyTeam(TEAM_ID, 'Plataforma de Pagamentos e Faturamento Corporativo', '💳', locale)
  for (let i = 0; i < 24; i++) {
    const due = opts.dueToday && i < 5 ? isoLocal(0) : `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`
    team.actionItems.push({
      id: `a${i}`, summary: i % 3 === 0 ? 'Revisar a arquitetura de integração com o sistema legado antes da reunião trimestral de planejamento com todos os times' : `Action item ${i}`,
      status: 'todo', dueDate: due, assignee: 'Maria Fernanda Albuquerque',
      order: i, notes: '', color: (['slate', 'brass', 'sage', 'rust', 'plum', 'ledger'] as const)[i % 6]!,
    })
    const msDate = opts.milestones === 'dense'
      ? (i < 20 ? isoLocal(i) : isoLocal(300 + i))
      : `2026-1${i % 3}-${String(1 + (i % 28)).padStart(2, '0')}`
    team.milestones.push({ id: `m${i}`, date: msDate, title: `Milestone ${i}`, done: false, followup: '' })
    team.risks.push({ id: `r${i}`, title: `Risk ${i}`, chance: ((i % 3) + 1) as 1 | 2 | 3, impact: (((i + 1) % 3) + 1) as 1 | 2 | 3, plan: 'mitigate', followup: '', order: i, closed: false })
  }
  for (let i = 0; i < (opts.stakeholderRoots ?? 0); i++) {
    team.stakeholders.push({ id: `s${i}`, name: `Stakeholder number ${i} with a long name`, role: 'Role', parentId: null, order: i, notes: '' })
  }
  doc.teams.push(team)
  doc.nav.activeTeamId = TEAM_ID
  doc.nav.focusedPane = 0
  doc.nav.sidebarCollapsed = opts.sidebarCollapsed ?? false
  const split = opts.splitRight !== undefined
  doc.nav.split = split
  doc.nav.teamSplit = split ? { [TEAM_ID]: true } : {}
  doc.nav.panes = [
    { history: [{ teamId: TEAM_ID, ref }], index: 0 },
    split ? { history: [{ teamId: TEAM_ID, ref: opts.splitRight! }], index: 0 } : { history: [], index: -1 },
  ]
  return doc
}

export async function openDoc(page: Page, doc: Doc, viewport = { width: 1440, height: 900 }): Promise<void> {
  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.setViewportSize(viewport)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  const bytes = Array.from(new TextEncoder().encode(`TMV-PLAIN\n${JSON.stringify(doc)}`))
  await writeOpfsFile(page, 'fs.tmv', bytes)
  await setNextOpenName(page, 'fs.tmv')
  await page.getByRole('button', { name: /Open/ }).first().click()
  await expect(page.locator('.tt-shell')).toBeVisible()
}
