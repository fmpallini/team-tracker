import { createRichEditorBundle, createModuleEditor } from '../src/ui/rich-editor'
import { createSearchIndex } from '../src/core/search'
import { formatDate } from '../src/core/i18n'
import type { ModuleCtx } from '../src/ui/panes'
import type { Store } from '../src/core/store'
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

describe('createModuleEditor', () => {
  function mount(opts: Partial<Parameters<typeof createModuleEditor>[2]> = {}) {
    const doc = createEmptyDocument('en-US')
    doc.teams.push(createEmptyTeam('t1', 'Alpha', '🙂', 'en-US'))
    doc.templates = [
      { id: 'a', name: 'AnyTpl', scope: 'any', body: 'T:{team} P:{person} D:{date}' },
      { id: 'd', name: 'DailyTpl', scope: 'daily', body: 'daily' },
      { id: 'p', name: 'PersonalTpl', scope: 'personal', body: 'personal' },
    ]
    const store: Store = createStore(doc)
    const ctx: ModuleCtx = {
      store, pm: fakePm(), paneIdx: 0, locale: 'en-US',
      searchIndex: createSearchIndex(() => store.doc, () => store.rev),
      saveStatus: { requestSaveNow: () => {}, subscribeSaveState: () => () => {} },
    }
    const onChange = vi.fn()
    const bundle = createModuleEditor(ctx, 't1', { initialMd: '', onChange, templateScopes: ['any'], ...opts })
    document.body.appendChild(bundle.editor.root)
    const editorEl = bundle.editor.root.querySelector('.editor') as HTMLElement
    return { store, bundle, editorEl, onChange }
  }
  const offered = (): string[] => Array.from(document.querySelectorAll('.tt-atref-item')).map((n) => n.textContent ?? '')
  function pick(editorEl: HTMLElement, name: string): void {
    setBlockText(editorEl, '/')
    fireInput(editorEl)
    Array.from(document.querySelectorAll<HTMLElement>('.tt-atref-item')).find((n) => n.textContent === name)!.click()
  }
  afterEach(() => { vi.useRealTimers() })

  test('offers only the requested scopes, in document order', () => {
    const { editorEl, bundle } = mount({ templateScopes: ['personal', 'any'] })
    setBlockText(editorEl, '/')
    fireInput(editorEl)
    expect(offered()).toEqual(['AnyTpl', 'PersonalTpl'])
    bundle.dispose()
  })

  test('fills {team} live and {person}/{date} from the overrides', () => {
    vi.useFakeTimers()
    const { store, editorEl, bundle } = mount({ templateDate: () => '2026-07-24', personName: () => 'Bia' })
    store.update((d) => { d.teams[0]!.name = 'Beta' })
    pick(editorEl, 'AnyTpl')
    vi.advanceTimersByTime(500)
    expect(bundle.editor.getMd()).toContain(`T:Beta P:Bia D:${formatDate('2026-07-24', 'en-US')}`)
    bundle.dispose()
  })

  test('{date} defaults to today', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 14, 10, 0))
    const { editorEl, bundle } = mount()
    pick(editorEl, 'AnyTpl')
    vi.advanceTimersByTime(500)
    expect(bundle.editor.getMd()).toContain(`D:${formatDate('2026-10-14', 'en-US')}`)
    bundle.dispose()
  })

  test('a whitespace-only body reaches onChange as an empty string', () => {
    vi.useFakeTimers()
    const { editorEl, onChange, bundle } = mount()
    setBlockText(editorEl, '   ')
    fireInput(editorEl)
    vi.advanceTimersByTime(500)
    expect(onChange).toHaveBeenLastCalledWith('')
    bundle.dispose()
  })
})
