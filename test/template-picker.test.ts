import { createEditor, type Editor, type EditorHooks } from '../src/ui/editor'
import { attachTemplatePicker } from '../src/ui/template-picker'
import type { Template } from '../src/core/types'
import type { TemplateCtx } from '../src/core/templates'
import type { Locale } from '../src/core/i18n'

function makeHooks(): EditorHooks {
  return {
    onChange() {},
    onRefClick() {},
    onAtTrigger() {},
    onSlashTrigger() {},
  }
}

const CTX: TemplateCtx = { dateIso: '2026-07-02', time: '10:00', locale: 'en-US' }

const TEMPLATES: Template[] = [
  {
    id: 't1',
    name: 'Decision',
    scope: 'any',
    body: '## Decision — {data}\n- a\n- b\n**bold** text',
  },
  {
    id: 't2',
    name: 'Weekly status',
    scope: 'daily',
    body: '## Status — {data}\n### Highlights\n- ',
  },
]

describe('attachTemplatePicker', () => {
  let editor: Editor | null = null

  afterEach(() => {
    editor?.destroy()
    editor = null
    document.body.innerHTML = ''
  })

  function setup(templates: Template[] = TEMPLATES, locale: Locale = 'en-US'): { editorEl: HTMLElement } {
    editor = createEditor(makeHooks(), locale)
    document.body.appendChild(editor.root)
    attachTemplatePicker(editor, { getTemplates: () => templates, getCtx: () => CTX, locale })
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    return { editorEl }
  }

  // Directly (re)writes the current block's text and places the caret at its
  // end — mirrors test/atref.test.ts's helper, exercising the same code path
  // since the picker re-derives its state from the live selection.
  function setBlockText(editorEl: HTMLElement, text: string): void {
    editorEl.innerHTML = `<div>${text}</div>`
    const textNode = editorEl.firstChild!.firstChild as Text | null
    const range = document.createRange()
    if (textNode) range.setStart(textNode, textNode.textContent!.length)
    else range.setStart(editorEl.firstChild!, 0)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }

  function fireInput(editorEl: HTMLElement): void {
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function fireKey(editorEl: HTMLElement, key: string): void {
    editorEl.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }

  // Builds a `<ul><li>/</li></ul>` trigger context (optionally with sibling
  // `<li>`s before/after) and places the caret at the end of the triggering
  // li's text — mirrors setBlockText but for a list-item trigger block,
  // exercising the ctx.block.tagName === 'LI' path in commit().
  function setListTriggerText(editorEl: HTMLElement, siblingsBefore: string[] = [], siblingsAfter: string[] = []): void {
    const before = siblingsBefore.map((s) => `<li>${s}</li>`).join('')
    const after = siblingsAfter.map((s) => `<li>${s}</li>`).join('')
    editorEl.innerHTML = `<ul>${before}<li>/</li>${after}</ul>`
    const lis = editorEl.querySelectorAll('li')
    const triggerLi = lis[siblingsBefore.length]!
    const textNode = triggerLi.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, textNode.textContent!.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }

  function clickTemplatesButton(): void {
    const btn = Array.from(editor!.root.querySelectorAll('button')).find((b) => b.textContent === '📋')
    if (!btn) throw new Error('📋 toolbar button not found')
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }

  test('typing "/" on an empty line opens the dropdown listing template names', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '/')
    fireInput(editorEl)

    const dropdown = document.querySelector('.tt-atref-dropdown')
    expect(dropdown).not.toBeNull()
    const labels = Array.from(dropdown!.querySelectorAll('.tt-atref-item')).map((n) => n.textContent)
    expect(labels).toEqual(['Decision', 'Weekly status'])
  })

  test('Enter removes the "/" and inserts the resolved, parsed template; caret lands at the end', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '/')
    fireInput(editorEl)

    fireKey(editorEl, 'Enter')

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    expect(editorEl.querySelector('h2')).not.toBeNull()
    expect(editor!.getMd()).toBe('## Decision — 07/02/2026\n- a\n- b\n**bold** text')

    const sel = window.getSelection()!
    expect(sel.rangeCount).toBe(1)
    expect(sel.getRangeAt(0).collapsed).toBe(true)
  })

  test('ArrowDown then Enter picks the second template', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '/')
    fireInput(editorEl)

    fireKey(editorEl, 'ArrowDown')
    fireKey(editorEl, 'Enter')

    expect(editor!.getMd()).toBe('## Status — 07/02/2026\n### Highlights\n- ')
  })

  test('clicking a list item inserts that template', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '/')
    fireInput(editorEl)

    const items = document.querySelectorAll('.tt-atref-item')
    ;(items[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    expect(editor!.getMd()).toBe('## Status — 07/02/2026\n### Highlights\n- ')
  })

  test('Escape cancels and leaves the literal "/" as typed', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '/')
    fireInput(editorEl)

    fireKey(editorEl, 'Escape')

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    expect(editorEl.querySelector('h2')).toBeNull()
    expect(editorEl.textContent).toBe('/')
  })

  test('clicking outside the dropdown closes it without inserting anything', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '/')
    fireInput(editorEl)
    expect(document.querySelector('.tt-atref-dropdown')).not.toBeNull()

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    expect(editorEl.textContent).toBe('/')
  })

  test('typing past the trigger closes the dropdown and leaves the typed text untouched', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '/')
    fireInput(editorEl)
    setBlockText(editorEl, '/x')
    fireInput(editorEl)

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    expect(editorEl.textContent).toBe('/x')
  })

  test('clicking a list item still inserts even if window.getSelection() is cleared before the click (real-browser focus loss on an external click)', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '/')
    fireInput(editorEl)

    // Real browsers can clear/move window.getSelection() on a click at an
    // external, non-input element — even when the row's own mousedown
    // handler calls preventDefault() — due to engine-dependent blur/
    // selection-collapse behavior around contenteditable focus. jsdom
    // doesn't model this quirk via ordinary event dispatch, so it's
    // simulated directly here to exercise the same commit() path a real
    // browser would take.
    window.getSelection()!.removeAllRanges()

    const first = document.querySelector('.tt-atref-item') as HTMLElement
    first.click()

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    expect(editor!.getMd()).toContain('Decision')
  })

  test('no templates for the current scope shows an empty-state row instead of a blank list', () => {
    const { editorEl } = setup([])
    setBlockText(editorEl, '/')
    fireInput(editorEl)

    const dropdown = document.querySelector('.tt-atref-dropdown')!
    expect(dropdown.querySelector('.tt-templates-empty')).not.toBeNull()
    expect(dropdown.textContent).toBe('No templates available')
  })

  test('the 📋 toolbar button opens the picker at the caret on an empty line', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '')
    clickTemplatesButton()

    const dropdown = document.querySelector('.tt-atref-dropdown')
    expect(dropdown).not.toBeNull()

    fireKey(editorEl, 'Enter')
    expect(editor!.getMd()).toBe('## Decision — 07/02/2026\n- a\n- b\n**bold** text')
  })

  test('the 📋 toolbar button on a non-empty line inserts the template after that line, untouched', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, 'existing note')
    clickTemplatesButton()

    expect(document.querySelector('.tt-atref-dropdown')).not.toBeNull()
    fireKey(editorEl, 'Enter')

    expect(editor!.getMd()).toBe('existing note\n## Decision — 07/02/2026\n- a\n- b\n**bold** text')
  })

  test('triggering "/" from the sole bullet of a list inserts the template after the list, leaving no stray "/" or nested blocks', () => {
    const { editorEl } = setup()
    setListTriggerText(editorEl)
    fireInput(editorEl)

    fireKey(editorEl, 'Enter')

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    // The trigger was the list's only <li>, so the original (now-empty) list
    // is discarded entirely — no leftover empty <ul>, no "/" surviving
    // anywhere. The template's own "- a\n- b" list is expected, but it must
    // land as a top-level sibling of the editor root (not nested inside the
    // discarded <ul>, which htmlToMd cannot walk).
    const uls = Array.from(editorEl.querySelectorAll('ul'))
    expect(uls.length).toBe(1)
    expect(uls[0]!.parentElement).toBe(editorEl)
    expect(Array.from(uls[0]!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['a', 'b'])
    // No element anywhere still holds the bare trigger "/" (the date's own
    // "/" separators in "07/02/2026" are expected and fine).
    expect(Array.from(editorEl.querySelectorAll('*')).some((el) => el.textContent === '/')).toBe(false)
    expect(editor!.getMd()).toBe('## Decision — 07/02/2026\n- a\n- b\n**bold** text')
    expect(editor!.getMd()).not.toContain('- /\n')
    expect(editor!.getMd().split('\n')).not.toContain('- /')
  })

  test('triggering "/" from a bullet with siblings preserves the other bullets and inserts the template after the list', () => {
    const { editorEl } = setup()
    setListTriggerText(editorEl, ['first'], ['last'])
    fireInput(editorEl)

    fireKey(editorEl, 'Enter')

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    const ul = editorEl.querySelector('ul')
    expect(ul).not.toBeNull()
    expect(Array.from(ul!.querySelectorAll(':scope > li')).map((li) => li.textContent)).toEqual(['first', 'last'])
    expect(editor!.getMd()).toBe('- first\n- last\n## Decision — 07/02/2026\n- a\n- b\n**bold** text')
  })

  test('caret lands inside the last bullet of a template that ends with an empty list item', () => {
    const { editorEl } = setup()
    setListTriggerText(editorEl)
    fireInput(editorEl)

    fireKey(editorEl, 'ArrowDown') // select "Weekly status", which ends in "- "
    fireKey(editorEl, 'Enter')

    expect(editor!.getMd()).toBe('## Status — 07/02/2026\n### Highlights\n- ')
    const lastLi = editorEl.querySelector('ul > li:last-child')
    expect(lastLi).not.toBeNull()
    const sel = window.getSelection()!
    expect(sel.rangeCount).toBe(1)
    expect(sel.getRangeAt(0).collapsed).toBe(true)
    expect(sel.anchorNode === lastLi || lastLi!.contains(sel.anchorNode)).toBe(true)
  })
})
