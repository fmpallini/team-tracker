// e2e/ref-click-shift.spec.ts — a risk or milestone follow-up editor shows its
// toolbar only while focused. Pressing an @ref chip in an unfocused editor
// focuses it, the toolbar appears and the text moves before the button is
// released; the chip must still open its target (ui/editor.ts onPressStart).
import { test, expect } from '@playwright/test'
import { buildDoc, openDoc } from './layout-fixtures'

test('pressing an @mention chip in an unfocused follow-up editor still opens it, though the toolbar shifts the text', async ({ page }) => {
  const doc = buildDoc('M', { kind: 'risks' }, { stakeholderRoots: 1 })
  doc.teams[0]!.risks[0]!.followup = 'Talk to @[Stakeholder number 0 with a long name](person:s0) first'
  await openDoc(page, doc)

  await page.locator('.tt-risk-row .tt-risk-expand-btn').first().click()
  const editor = page.locator('.tt-risk-followup-row .tt-editor').first()
  await expect(editor).toBeVisible()
  const toolbar = editor.locator('.tt-editor-toolbar')
  await page.locator('.tt-risks').click({ position: { x: 4, y: 4 } }) // make sure nothing in the editor is focused
  await expect(toolbar).toBeHidden()

  const chip = editor.locator('a.ref').first()
  const box = (await chip.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect(toolbar).toBeVisible() // focus revealed the toolbar: the text has moved
  await page.waitForTimeout(120) // a human press lasts longer than a frame
  await page.mouse.up()

  await expect(page.locator('.tt-person-notes')).toBeVisible()
})
