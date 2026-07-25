import { createRichEditorBundle } from '../src/ui/rich-editor'
import { createStore } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'

function fakePm() {
  return { openInPane: vi.fn(), openInFocused: vi.fn(), renderAll: vi.fn() } as any
}

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
