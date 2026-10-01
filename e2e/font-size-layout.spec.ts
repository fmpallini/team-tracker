// e2e/font-size-layout.spec.ts — regression guards for layout that only breaks
// at the larger text sizes (prefs.fontSize → html[data-size]). jsdom has no
// layout engine, so none of these can be unit tests: each asserts on real
// measured geometry in Chromium.
//
// Every case runs at XL (the size that exposed them) and the module-menu and
// kanban cases also at XS, so a fix that merely trades one end for the other
// still fails.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, writeOpfsFile, setNextOpenName } from './opfs-shim'
import { blockUpdateCheck } from './helpers'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Doc, ModuleRef, Prefs } from '../src/core/types'

const TEAM_ID = 'team-0'

function buildDoc(size: Prefs['fontSize'], ref: ModuleRef, opts: { sidebarCollapsed?: boolean; locale?: 'en-US' | 'pt-BR' } = {}): Doc {
  const locale = opts.locale ?? 'en-US'
  const doc = createEmptyDocument(locale)
  doc.prefs.fontSize = size
  const team = createEmptyTeam(TEAM_ID, 'Plataforma de Pagamentos e Faturamento Corporativo', '💳', locale)
  for (let i = 0; i < 24; i++) {
    team.actionItems.push({
      id: `a${i}`, summary: i % 3 === 0 ? 'Revisar a arquitetura de integração com o sistema legado antes da reunião trimestral' : `Action item ${i}`,
      status: 'todo', dueDate: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`, assignee: 'Maria Fernanda Albuquerque',
      order: i, notes: '', color: (['slate', 'brass', 'sage', 'rust', 'plum', 'ledger'] as const)[i % 6]!,
    })
    team.milestones.push({ id: `m${i}`, date: `2026-1${i % 3}-${String(1 + (i % 28)).padStart(2, '0')}`, title: `Milestone ${i}`, done: false, followup: '' })
    team.risks.push({ id: `r${i}`, title: `Risk ${i}`, chance: ((i % 3) + 1) as 1 | 2 | 3, impact: (((i + 1) % 3) + 1) as 1 | 2 | 3, plan: 'mitigate', followup: '', order: i, closed: false })
  }
  doc.teams.push(team)
  doc.nav.activeTeamId = TEAM_ID
  doc.nav.split = false
  doc.nav.focusedPane = 0
  doc.nav.sidebarCollapsed = opts.sidebarCollapsed ?? false
  doc.nav.panes = [
    { history: [{ teamId: TEAM_ID, ref }], index: 0 },
    { history: [], index: -1 },
  ]
  return doc
}

async function openDoc(page: Page, doc: Doc): Promise<void> {
  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${E2E_BASE_URL}/app.html`)
  const bytes = Array.from(new TextEncoder().encode(`TMV-PLAIN\n${JSON.stringify(doc)}`))
  await writeOpfsFile(page, 'fs.tmv', bytes)
  await setNextOpenName(page, 'fs.tmv')
  await page.getByRole('button', { name: /Open/ }).first().click()
  await expect(page.locator('.tt-shell')).toBeVisible()
}

for (const size of ['XS', 'XL'] as const) {
  test.describe(`font size ${size}`, () => {
    test('module menu rows stay on one line, however short the trigger is', async ({ page }) => {
      // "General notes" is a short trigger: the menu hangs off a ~160px wrapper,
      // which used to cap its shrink-to-fit width and fold "Daily notes" in two.
      await openDoc(page, buildDoc(size, { kind: 'general' }))
      await page.locator('.tt-pane-modules-btn').first().click()
      const labels = page.locator('.tt-pane-menu-label')
      expect(await labels.count()).toBeGreaterThanOrEqual(7)
      const tall = await labels.evaluateAll((els) =>
        els
          .map((e) => ({ text: e.textContent, h: e.getBoundingClientRect().height, fs: parseFloat(getComputedStyle(e).fontSize) }))
          .filter((r) => r.h >= 2 * r.fs)
      )
      expect(tall).toEqual([])
    })

    test('kanban cards keep their full height and the column scrolls instead', async ({ page }) => {
      await openDoc(page, buildDoc(size, { kind: 'actions' }))
      await expect(page.locator('.tt-kanban-card').first()).toBeVisible()
      const r = await page.evaluate(() => {
        const body = document.querySelector('.tt-kanban-col-body')!
        const cards = [...body.querySelectorAll<HTMLElement>('.tt-kanban-card')]
        return {
          scrolls: body.scrollHeight > body.clientHeight,
          squashed: cards.filter((c) => c.scrollHeight > c.clientHeight + 1).length,
          count: cards.length,
        }
      })
      expect(r.count).toBe(24)
      expect(r.scrolls).toBe(true) // 24 cards cannot fit; the column must be the thing that scrolls
      expect(r.squashed).toBe(0)
    })
  })
}

// pt-BR: its "Não salvo – último salvamento hh:mm" save pill is the widest, which is what squeezed the search box to an icon.
test('header search keeps a usable width with the sidebar collapsed and a long team name (XL)', async ({ page }) => {
  await openDoc(page, buildDoc('XL', { kind: 'general' }, { sidebarCollapsed: true, locale: 'pt-BR' }))
  await expect(page.locator('.tt-header-team-indicator.visible')).toBeVisible()
  // A nav change dirties the doc, and the pill grows to "Não salvo – último salvamento hh:mm" — the widest state.
  await page.keyboard.press('F2')
  await page.keyboard.press('F1')
  await expect(page.locator('.tt-save-pill-text')).toContainText('Não salvo')
  const width = await page.locator('.tt-search-input').evaluate((e) => e.getBoundingClientRect().width)
  expect(width).toBeGreaterThanOrEqual(150)
  // The long team name gives way (ellipsis) rather than spilling out of its header slot over the save pill.
  const fit = await page.evaluate(() => {
    const center = document.querySelector('.tt-header-center')!.getBoundingClientRect()
    const ind = document.querySelector('.tt-header-team-indicator')!.getBoundingClientRect()
    const label = document.querySelector('.tt-header-team-indicator-label')!
    return { overflow: ind.right - center.right, clipped: label.scrollWidth > label.clientWidth }
  })
  expect(fit.overflow).toBeLessThanOrEqual(1)
  expect(fit.clipped).toBe(true)
})

test('SVG labels on the milestone timeline and risk quadrant follow the size setting (XL = 1.2 × M)', async ({ page }) => {
  await openDoc(page, buildDoc('XL', { kind: 'milestones' }))
  const dateLabel = page.locator('.tt-milestone-date-label').first()
  await expect(dateLabel).toBeVisible()
  expect(parseFloat(await dateLabel.evaluate((e) => getComputedStyle(e).fontSize))).toBeCloseTo(9 * 1.2, 1)

  await page.keyboard.press('F7')
  const tick = page.locator('.tt-risk-quadrant-tick').first()
  await expect(tick).toBeVisible()
  expect(parseFloat(await tick.evaluate((e) => getComputedStyle(e).fontSize))).toBeCloseTo(9 * 1.2, 1)
})
