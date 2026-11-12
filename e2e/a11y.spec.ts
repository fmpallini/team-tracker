// e2e/a11y.spec.ts — automated accessibility scan (axe-core): the start
// screen, the main shell, every module with real content in it, and the
// overlays a keyboard user lives in (Settings, fast switch, Help, the card
// editor). Nothing else in the suite checks ARIA roles/names, focus
// semantics, or contrast.
//
// Served over http://localhost (secure context) via the OPFS picker shim, the
// same setup fs-api.spec.ts uses, so the real create → shell flow runs.
import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'
import { buildDoc, openDoc, TEAM_ID } from './layout-fixtures'
import type { Doc, ModuleRef, PaletteId } from '../src/core/types'

const TODAY = new Date().toLocaleDateString('en-CA')

type Theme = 'light' | 'dark'
const THEMES: Theme[] = ['light', 'dark']

/** layout-fixtures' busy document (some tasks due today, the rest overdue), plus the note content its builder leaves empty. */
function contentDoc(ref: ModuleRef, theme: Theme = 'light', palette: PaletteId = 'ledger', splitRight?: ModuleRef): Doc {
  const doc = buildDoc('M', ref, { stakeholderRoots: 3, milestones: 'spread', dueToday: true, ...(splitRight ? { splitRight } : {}) })
  doc.prefs.theme = theme
  doc.prefs.palette = palette
  const team = doc.teams.find((t) => t.id === TEAM_ID)!
  const note = '# Weekly sync\n\n- **Decision**: ship on Friday\n- Follow up with [link](https://example.com)\n\n> Quote\n\n```\ncode()\n```'
  team.dailyNotes[TODAY] = note
  team.generalNotes = note
  team.stakeholders[0]!.notes = note
  team.risks[0]!.followup = note
  team.milestones[0]!.followup = note
  return doc
}

// WCAG 2 A/AA is the bar; scope each scan to the surface under test.
const scan = (page: Page, selector: string, skipRules: string[] = []) =>
  new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).include(selector).disableRules(skipRules).analyze()

/** One line per offending node (`rule: selector — html`), so a failure reads at a glance instead of as axe's raw dump. */
const violations = (results: Awaited<ReturnType<typeof scan>>): string[] =>
  results.violations.flatMap((v) => v.nodes.map((n) => {
    const c = n.any[0]?.data as { fgColor?: string; bgColor?: string; contrastRatio?: number } | null | undefined
    const ratio = c?.contrastRatio ? ` [${c.fgColor} on ${c.bgColor} = ${c.contrastRatio}]` : ''
    return `${v.id}: ${n.target.join(' ')}${ratio} — ${n.html.slice(0, 140)}`
  }))

test.describe('accessibility (axe-core)', () => {
  test('start screen has no WCAG A/AA violations', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await expect(page.locator('.tt-start-screen')).toBeVisible()

    const results = await scan(page, '.tt-start-screen')
    expect(violations(results)).toEqual([])
  })

  test('main shell (document open, first team created) has no WCAG A/AA violations', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, 'e2e-a11y-password')

    await page.getByRole('button', { name: /Create first team/ }).click()
    const teamDialog = page.getByRole('dialog')
    await teamDialog.locator('input[name="tt-team-name"]').fill('Team A')
    await teamDialog.getByRole('button', { name: 'Save' }).click()
    await teamDialog.waitFor({ state: 'hidden' })

    const results = await scan(page, '.tt-shell')
    expect(violations(results)).toEqual([])
  })

  // The scans above are scoped to an element, so axe's page-level rules never run there: this one covers the page's language.
  test('the page declares a valid language, on the start screen and with a document open', async ({ page }) => {
    const langScan = async (): Promise<string[]> =>
      violations(await new AxeBuilder({ page }).withRules(['html-has-lang', 'html-lang-valid']).analyze())
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await expect(page.locator('.tt-start-screen')).toBeVisible()
    expect(await langScan()).toEqual([])

    await createEncryptedDoc(page, 'e2e-a11y-password')
    expect(await langScan()).toEqual([])
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  })

  test('the Settings modal has no WCAG A/AA violations', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, 'e2e-a11y-password')

    await page.click('.tt-btn-settings')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const results = await scan(page, '.tt-modal-overlay')
    expect(violations(results)).toEqual([])
  })

  const MODULES: Array<[string, ModuleRef]> = [
    ['daily notes', { kind: 'daily', date: TODAY }],
    ['general notes', { kind: 'general' }],
    ['stakeholders', { kind: 'stakeholders' }],
    ['members (empty)', { kind: 'members' }],
    ['person notes', { kind: 'person', personId: 's0', group: 'stakeholders' }],
    ['tasks (kanban)', { kind: 'actions' }],
    ['milestones', { kind: 'milestones' }],
    ['risks', { kind: 'risks' }],
  ]
  // Both themes: contrast is a per-theme property, and the default palette is what most users run.
  for (const theme of THEMES) {
    for (const [name, ref] of MODULES) {
      test(`the ${name} module has no WCAG A/AA violations (${theme})`, async ({ page }) => {
        await openDoc(page, contentDoc(ref, theme))
        await expect(page.locator('.tt-pane-body').first()).not.toBeEmpty()
        const results = await scan(page, '.tt-shell')
        expect(violations(results)).toEqual([])
      })
    }

    const OVERLAYS: Array<[string, ModuleRef, (page: Page) => Promise<void>, string, string[]]> = [
      // The result list scrolls without being a Tab stop: focus stays in the input, whose arrows move the selection
      // and scroll it into view. (It still lacks combobox/listbox semantics — a known gap, not hidden by this.)
      ['the fast switch', { kind: 'daily', date: TODAY }, (page) => page.keyboard.press('Control+Shift+K'), '.tt-palette-overlay', ['scrollable-region-focusable']],
      ['Help', { kind: 'daily', date: TODAY }, (page) => page.keyboard.press('F1'), '.tt-modal-overlay', []],
      ['the task editor', { kind: 'actions' }, (page) => page.locator('.tt-kanban-card').first().dblclick(), '.tt-modal-overlay', []],
    ]
    for (const [name, ref, open, overlay, skipRules] of OVERLAYS) {
      test(`${name} has no WCAG A/AA violations (${theme})`, async ({ page }) => {
        await openDoc(page, contentDoc(ref, theme))
        await open(page)
        await expect(page.getByRole('dialog')).toBeVisible()
        const results = await scan(page, overlay, skipRules)
        expect(violations(results)).toEqual([])
      })
    }
  }
})

// The other palettes, for contrast only (nothing else varies by palette): every module, two per page in split view,
// plus the task editor (the danger button on a tinted dialog). test/palette-contrast.test.ts proves the token recipes
// statically; this catches a surface that uses a recipe it does not know about.
const PALETTES: PaletteId[] = ['signal', 'forest', 'cosmic', 'synthwave', 'verdant', 'ember', 'graphite', 'rose', 'citrus', 'contrast', 'colorsafe']
test.describe('palette contrast (axe-core color-contrast)', () => {
  for (const palette of PALETTES) {
    for (const theme of THEMES) {
      test(`${palette} ${theme}: every module and the task editor read at AA`, async ({ page }) => {
        const contrast = (selector: string) =>
          new AxeBuilder({ page }).withRules(['color-contrast']).include(selector).analyze()
        const SPLITS: Array<[ModuleRef, ModuleRef]> = [
          [{ kind: 'milestones' }, { kind: 'daily', date: TODAY }],
          [{ kind: 'stakeholders' }, { kind: 'person', personId: 's0', group: 'stakeholders' }],
          [{ kind: 'actions' }, { kind: 'risks' }],
        ]
        for (const [left, right] of SPLITS) {
          await openDoc(page, contentDoc(left, theme, palette, right))
          await expect(page.locator('.tt-pane-body').nth(1)).not.toBeEmpty()
          expect(violations(await contrast('.tt-shell')), `${left.kind} | ${right.kind}`).toEqual([])
        }
        await page.locator('.tt-kanban-card').first().dblclick()
        await expect(page.getByRole('dialog')).toBeVisible()
        expect(violations(await contrast('.tt-modal-overlay'))).toEqual([])
      })
    }
  }
})
