import { buildSnapshot, commitSnapshot } from '../src/core/snapshot'
import { createStore } from '../src/core/store'
import { createImageStore, type ImageStore } from '../src/core/image-store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { parsePlainWithVersion } from '../src/core/crypto'
import type { LivePersister } from '../src/core/live-persist'

const IMG = 'a'.repeat(32)

test('every snapshot carries its own stamp, written into the bytes it returns', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const a = await buildSnapshot(store, null)
  const b = await buildSnapshot(store, null)
  expect(a.stamp.writeId).toMatch(/^[0-9a-f]{32}$/)
  expect(a.stamp.writeId).not.toBe(b.stamp.writeId)
  expect(parsePlainWithVersion(a.bytes)!.stamp).toEqual(a.stamp)
})

test('the revision is the one before serialization began, not after', async () => {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('T1', 'T', '', 'en-US')
  team.generalNotes = `![x](img:${IMG})`
  doc.teams.push(team)
  doc.images[IMG] = { mime: 'image/webp', w: 1, h: 1, bytes: 1 }
  const inner = createImageStore(null)
  inner.putPlain(IMG, new Uint8Array([1]))
  const ref: { store?: ReturnType<typeof createStore> } = {}
  // An edit lands while the bytes are being built (serialization awaits the image store).
  const images: ImageStore = { ...inner, getStored: async (id) => { ref.store!.update((d) => { d.nav.split = true }); return inner.getStored(id) } }
  const store = (ref.store = createStore(doc, images))
  const before = store.rev
  const snap = await buildSnapshot(store, null)
  expect(snap.revAtSnapshot).toBe(before)
  expect(store.rev).toBeGreaterThan(before)
})

test('a document the writer would refuse fails the snapshot instead of producing unreadable bytes', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  ;(store.doc as unknown as { teams: unknown }).teams = 'broken'
  await expect(buildSnapshot(store, null)).rejects.toThrow()
})

describe('commitSnapshot', () => {
  const stamp = { writeId: 'f'.repeat(32), savedAt: 7 }

  test('tells the persister which write and which revision the file holds', async () => {
    const markFileWritten = vi.fn(async () => {})
    await commitSnapshot({ markFileWritten } as unknown as LivePersister, stamp, 12)
    expect(markFileWritten).toHaveBeenCalledWith(stamp, 12)
  })

  test('without a persister (browser storage unavailable) it does nothing', async () => {
    await expect(commitSnapshot(null, stamp, 1)).resolves.toBeUndefined()
  })

  test('a persister that throws never turns a successful file write into a failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const markFileWritten = vi.fn(async () => { throw new Error('idb gone') })
    await expect(commitSnapshot({ markFileWritten } as unknown as LivePersister, stamp, 1)).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
