import { IMAGE_ID_RE, imageRefLine, parseImageLine, collectImageRefs, referencedBytes, markdownFields } from '../src/core/image-ref'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Doc } from '../src/core/types'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const C = 'c'.repeat(32)
const D = 'd'.repeat(32)
const ref = (id: string) => `![x](img:${id})`

function docWith(): Doc {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('T1', 'Team', '', 'en-US')
  team.dailyNotes['2026-01-01'] = `see\n\n${ref(A)}\n`
  team.milestones.push({ id: 'm', date: '2026-01-01', title: 'm', done: false, followup: ref(B) })
  team.actionItems.push({ id: 'a', summary: 's', notes: ref(C), status: 'todo', dueDate: null, assignee: '', color: null, order: 0 })
  doc.teams.push(team)
  doc.templates.push({ id: 't', name: 'n', scope: 'any', body: ref(D) })
  return doc
}

describe('image refs', () => {
  it('parseImageLine reads a reference line', () => {
    expect(parseImageLine(`![shot](img:${A})`)).toEqual({ id: A, alt: 'shot' })
  })

  it('imageRefLine strips bracket characters and newlines from alt', () => {
    const line = imageRefLine(A, 'a[b](c)\n')
    expect(parseImageLine(line)?.alt).toBe('abc')
  })

  it('parseImageLine rejects a prefix, an uppercase id and a web url', () => {
    expect(parseImageLine(`text ![x](img:${A})`)).toBeNull()
    expect(parseImageLine(`![x](img:${A.toUpperCase()})`)).toBeNull()
    expect(parseImageLine('![x](https://example.com/a.png)')).toBeNull()
  })

  it('IMAGE_ID_RE wants 32 lowercase hex chars', () => {
    expect(IMAGE_ID_RE.test(A)).toBe(true)
    expect(IMAGE_ID_RE.test('abc')).toBe(false)
  })

  it('collectImageRefs finds ids across field kinds', () => {
    expect([...collectImageRefs(docWith())].sort()).toEqual([A, B, C, D])
  })

  it('collectImageRefs ignores an id mentioned inline and counts duplicates once', () => {
    const doc = docWith()
    doc.teams[0]!.generalNotes = `look at ![x](img:${'e'.repeat(32)}) inline\n\n${ref(A)}`
    const ids = collectImageRefs(doc)
    expect(ids.has('e'.repeat(32))).toBe(false)
    expect(ids.size).toBe(4)
  })

  it('markdownFields yields person notes and action summaries too', () => {
    const doc = docWith()
    doc.teams[0]!.members.push({ id: 'p', name: 'n', role: '', parentId: null, order: 0, notes: ref(A) })
    expect([...markdownFields(doc)]).toContain(ref(A))
  })

  it('referencedBytes sums only referenced pool entries', () => {
    const doc = docWith()
    doc.images = {
      [A]: { mime: 'image/webp', w: 1, h: 1, bytes: 100 },
      [B]: { mime: 'image/webp', w: 1, h: 1, bytes: 10 },
      ['f'.repeat(32)]: { mime: 'image/webp', w: 1, h: 1, bytes: 9999 },
    }
    expect(referencedBytes(doc)).toBe(110)
  })
})
