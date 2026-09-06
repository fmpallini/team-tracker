// e2e/hotpath.spec.ts — work-count budgets on the per-keystroke paths.
//
// `perf.spec.ts` measures wall-clock latency; `leak.spec.ts` measures resource
// growth. Neither can see "this handler ran 30 times when once would do" —
// wall-clock hides it on a fast machine with small inputs, and the work leaves
// no residue for a heap/node count to find. This file counts the calls
// directly, inside the page, by wrapping the DOM APIs the hot paths go
// through:
//
//  - `querySelectorAll('pre')` — one per `syncPreHighlight` pass that got past
//    its collapsed-selection guard.
//  - `<pre>.innerHTML` reads — one per `highlightPre`, i.e. one full
//    `preLines()` DOM walk plus one `highlightCode()` re-tokenisation.
//  - pane-body childList churn — module teardown/rebuild.
//
// The budgets are all *ratios against a baseline measured in the same run*,
// never absolute counts, so they assert "this must not scale with N" rather
// than pinning a number that machine speed or an unrelated DOM tweak would
// invalidate.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, writeOpfsFile, setNextOpenName } from './opfs-shim'
import { blockUpdateCheck } from './helpers'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Doc } from '../src/core/types'

/** Enough expanded follow-up editors that a per-editor fan-out is unmistakable, without making the fixture slow to build. */
const RISKS = 30

/** A chunky code block: the highlight path's cost is per character of source, so a one-liner would hide it. */
const FENCE = [
  '```',
  ...Array.from({ length: 40 }, (_, i) => `  const value${i} = compute("arg ${i}", { flag: true }); // step ${i}`),
  '```',
].join('\n')

function buildDoc(): Doc {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('team-0', 'Team Zero', '🚀', 'en-US')
  for (let i = 0; i < RISKS; i++) {
    team.risks.push({
      id: `r${i}`, title: `Risk ${i}`, chance: (i % 3) + 1, impact: (i % 3) + 1,
      plan: 'mitigate', followup: `Mitigation ${i}\n\n${FENCE}\n`, order: i, closed: false,
    })
  }
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  return doc
}

interface Counters { qsaPre: number; preInnerHtmlRead: number; paneChurn: number }

/** Wraps the DOM APIs the hot paths funnel through, before any app code runs. */
async function installCounters(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __c: Counters }
    w.__c = { qsaPre: 0, preInnerHtmlRead: 0, paneChurn: 0 }
    const origQsa = Element.prototype.querySelectorAll
    Element.prototype.querySelectorAll = function (sel: string) {
      if (sel === 'pre') w.__c.qsaPre++
      return origQsa.call(this, sel) as never
    } as typeof Element.prototype.querySelectorAll

    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!
    Object.defineProperty(Element.prototype, 'innerHTML', {
      ...desc,
      get(this: Element) {
        if (this.tagName === 'PRE') w.__c.preInnerHtmlRead++
        return (desc.get as () => string).call(this)
      },
    })
  })
}

async function counters(page: Page): Promise<Counters> {
  return page.evaluate(() => ({ ...(window as unknown as { __c: Counters }).__c }))
}

async function resetCounters(page: Page): Promise<void> {
  await page.evaluate(() => {
    const c = (window as unknown as { __c: Counters }).__c
    c.qsaPre = 0; c.preInnerHtmlRead = 0; c.paneChurn = 0
  })
}

async function openDoc(page: Page): Promise<void> {
  await installCounters(page)
  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  const payload = `TMV-PLAIN\n${JSON.stringify(buildDoc())}`
  await writeOpfsFile(page, 'hot.tmv', Array.from(new TextEncoder().encode(payload)))
  await setNextOpenName(page, 'hot.tmv')
  await page.getByRole('button', { name: /Open/ }).first().click()
  await expect(page.locator('.tt-shell')).toBeVisible()
}

async function toModule(page: Page, paneIdx: 0 | 1, label: RegExp): Promise<void> {
  const pane = page.locator(`.tt-pane[data-pane-idx="${paneIdx}"]`)
  await pane.locator('.tt-pane-modules-btn').click()
  await pane.locator('.tt-pane-menu-item', { hasText: label }).first().click()
}

/** Types `text` and returns the counters accumulated while doing so. */
async function typeAndCount(page: Page, text: string): Promise<Counters> {
  await resetCounters(page)
  await page.keyboard.type(text, { delay: 40 })
  return counters(page)
}

test.describe('per-keystroke work budgets', () => {
  // Each test opens its own document, so they are independent — no 'serial'.
  test.describe.configure({ timeout: 180_000 })

  test('code-block highlighting does not scale with the number of open editors', async ({ page }) => {
    await openDoc(page)
    await toModule(page, 0, /Risks/i)
    await expect(page.locator('.tt-risk-row').first()).toBeVisible()

    // Baseline: one expanded follow-up. The caret goes in the paragraph ABOVE
    // the code block — with the caret inside a <pre> that block is stripped to
    // plain text instead of highlighted, which is the cheap path, not the one
    // under test.
    await page.locator('.tt-risk-expand-btn').first().click()
    await expect(page.locator('.tt-risk-followup-row .editor')).toHaveCount(1)
    await page.locator('.tt-risk-followup-row .editor div').first().click()
    const one = await typeAndCount(page, 'abcde')

    // Same five keystrokes, same caret position, with every follow-up expanded.
    await page.locator('.tt-risk-expand-all-btn').click()
    await expect(page.locator('.tt-risk-followup-row .editor')).toHaveCount(RISKS)
    await page.locator('.tt-risk-followup-row .editor div').first().click()
    const many = await typeAndCount(page, 'abcde')

    console.log(
      `[hotpath] 1 editor: qsaPre=${one.qsaPre} preRehighlights=${one.preInnerHtmlRead} | ` +
        `${RISKS} editors: qsaPre=${many.qsaPre} preRehighlights=${many.preInnerHtmlRead}`
    )

    // Only the editor holding the caret (and, once, the one that just lost it)
    // can need work on a selection change. A listener per editor made this
    // ~30x; the shared dispatcher keeps it flat.
    expect(many.preInnerHtmlRead, 'code-block re-highlights per keystroke must not scale with open editor count')
      .toBeLessThan(one.preInnerHtmlRead * 3)
    expect(many.qsaPre, "'pre' sweeps per keystroke must not scale with open editor count")
      .toBeLessThan(one.qsaPre * 3)
  })

  test('typing in one pane does not re-highlight editors in the other pane', async ({ page }) => {
    await openDoc(page)
    // Split first: toggling split re-renders pane 0, which remounts the risks
    // module and disposes every expanded editor. Expanding afterwards is what
    // keeps them alive into the measurement.
    await page.locator('.tt-pane[data-pane-idx="0"] .tt-pane-split-btn').click()
    await toModule(page, 1, /Daily/i)
    const pane1 = page.locator('.tt-pane[data-pane-idx="1"]')
    await expect(pane1.locator('.editor')).toHaveCount(1)
    await toModule(page, 0, /Risks/i)
    await expect(page.locator('.tt-pane[data-pane-idx="0"] .tt-risk-row').first()).toBeVisible()

    await pane1.locator('.editor').first().click()
    const before = await typeAndCount(page, 'abcde')

    await page.locator('.tt-risk-expand-all-btn').click()
    await expect(page.locator('.tt-risk-followup-row .editor')).toHaveCount(RISKS)
    await pane1.locator('.editor').first().click()
    const after = await typeAndCount(page, 'abcde')

    console.log(
      `[hotpath] pane-1 typing: preRehighlights ${before.preInnerHtmlRead} with 0 risk editors, ` +
        `${after.preInnerHtmlRead} with ${RISKS} open in pane 0`
    )

    // Today's daily note is empty, so the editor being typed into holds no
    // code block at all — every re-highlight counted here belongs to the
    // *other* pane's editors and is pure waste.
    expect(after.preInnerHtmlRead, "the other pane's code blocks must not be re-highlighted on every keystroke")
      .toBeLessThan(before.preInnerHtmlRead + 10)
  })

  test('a preference change does not tear down and rebuild the open modules', async ({ page }) => {
    await openDoc(page)
    await toModule(page, 0, /Risks/i)
    await page.locator('.tt-risk-expand-all-btn').click()
    await expect(page.locator('.tt-risk-followup-row .editor')).toHaveCount(RISKS)

    await page.evaluate(() => {
      const w = window as unknown as { __c: Counters; __mo?: MutationObserver }
      const body = document.querySelector('.tt-pane[data-pane-idx="0"] .tt-pane-body')!
      w.__mo = new MutationObserver((records) => {
        for (const r of records) w.__c.paneChurn += r.removedNodes.length + r.addedNodes.length
      })
      w.__mo.observe(body, { childList: true, subtree: true })
    })

    await page.locator('.tt-btn-settings').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await resetCounters(page)
    // Theme is pure chrome — it lands on document.documentElement's dataset
    // (ui/shell.ts's applyPrefs) and no module renders anything from it.
    await page.locator('input[name="tt-prefs-theme"][value="dark"]').click()
    await page.waitForTimeout(400)
    const c = await counters(page)

    console.log(`[hotpath] theme change: pane-body node churn=${c.paneChurn}`)
    expect(c.paneChurn, 'a theme change must not rebuild the open module').toBeLessThan(10)
  })
})
