import { createRichEditorBundle } from '../src/ui/rich-editor'
import { createStore } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'

function fakePm() {
  return { openInPane: vi.fn(), openInFocused: vi.fn(), renderAll: vi.fn() } as any
}

function setBlockText(editorEl: HTMLElement, text: string): void {
  editorEl.innerHTML = `<div>${text}</div>`
  const textNode = editorEl.firstChild!.firstChild as Text
  const range = document.createRange()
  range.setStart(textNode, textNode.textContent!.length)
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

function fireInput(editorEl: HTMLElement): void {
  editorEl.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('createRichEditorBundle wires initial content and forwards onChange', () => {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  doc.teams.push(team)
  const store = createStore(doc)
  const onChange = vi.fn()

  const bundle = createRichEditorBundle({
    store, pm: fakePm(), paneIdx: 0, locale: 'en-US', teamId: 't1',
    initialMd: 'Hello',
    onChange,
    getTeam: () => store.doc.teams[0],
    getTemplates: () => [],
    getTemplateCtx: () => ({ dateIso: '2026-07-24', time: '10:00', locale: 'en-US' }),
  })

  expect(bundle.editor.getMd()).toBe('Hello')
  bundle.dispose()
})

// Regression: this bundle is the shared wiring every free-text field in the
// app uses (daily notes, person notes, action-item notes, milestone/risk
// follow-ups) — its dispose() is documented to tear down the @ref dropdown,
// the template-picker dropdown, and the editor itself, but none of that was
// ever actually exercised here.
describe('dispose()', () => {
  function setup() {
    const doc = createEmptyDocument('en-US')
    const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
    doc.teams.push(team)
    const store = createStore(doc)
    const onChange = vi.fn()
    const bundle = createRichEditorBundle({
      store, pm: fakePm(), paneIdx: 0, locale: 'en-US', teamId: 't1',
      initialMd: '',
      onChange,
      getTeam: () => store.doc.teams[0],
      getTemplates: () => [],
      getTemplateCtx: () => ({ dateIso: '2026-07-24', time: '10:00', locale: 'en-US' }),
    })
    document.body.appendChild(bundle.editor.root)
    const editorEl = bundle.editor.root.querySelector('.editor') as HTMLElement
    return { bundle, editorEl, onChange }
  }

  test('tears down an open @-mention dropdown', () => {
    const { bundle, editorEl } = setup()
    setBlockText(editorEl, '@')
    fireInput(editorEl)
    expect(document.querySelector('.tt-atref-dropdown')).not.toBeNull()

    bundle.dispose()

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
  })

  test('tears down an open "/" template-picker dropdown', () => {
    const { bundle, editorEl } = setup()
    setBlockText(editorEl, '/')
    fireInput(editorEl)
    expect(document.querySelector('.tt-atref-dropdown')).not.toBeNull()

    bundle.dispose()

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
  })

  test('stops onChange from firing on edits made after teardown', () => {
    const { bundle, editorEl, onChange } = setup()
    bundle.dispose()
    onChange.mockClear()

    setBlockText(editorEl, 'typed after dispose')
    fireInput(editorEl)

    expect(onChange).not.toHaveBeenCalled()
  })

  test('is idempotent — calling it twice does not throw', () => {
    const { bundle, editorEl } = setup()
    setBlockText(editorEl, '@')
    fireInput(editorEl)

    bundle.dispose()
    expect(() => bundle.dispose()).not.toThrow()
  })
})
