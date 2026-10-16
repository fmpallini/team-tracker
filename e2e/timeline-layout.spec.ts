// e2e/timeline-layout.spec.ts — the milestone timeline's labels stay inside its
// drawing at every text size, however long the first and last titles are, and
// the TODAY tag is drawn when today falls inside the milestone range.
import { test, expect } from '@playwright/test'
import { buildDoc, openDoc } from './layout-fixtures'

for (const size of ['XS', 'M', 'XL'] as const) {
  test(`timeline labels are not clipped by the drawing's edges, font size ${size}`, async ({ page }) => {
    const doc = buildDoc(size, { kind: 'milestones' }, { milestones: 'dense' })
    const team = doc.teams[0]!
    team.milestones[0]!.title = 'A deliberately very long first milestone title'
    team.milestones[team.milestones.length - 1]!.title = 'A deliberately very long last milestone title'
    await openDoc(page, doc)
    const svg = page.locator('.tt-milestone-svg')
    await expect(svg).toBeVisible()
    const out = await svg.evaluate((s) => {
      const w = Number(s.getAttribute('width'))
      return [...s.querySelectorAll<SVGTextElement>('text')]
        .map((t) => ({ text: t.textContent, box: t.getBBox() }))
        .filter((t) => t.box.x < -0.5 || t.box.x + t.box.width > w + 0.5)
        .map((t) => t.text)
    })
    expect(out).toEqual([])
    await expect(svg.locator('.tt-milestone-today-label')).toHaveCount(1)
  })
}
