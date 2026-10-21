import type { Doc } from './types'

/** Content id of an embedded image: first 32 hex chars of the SHA-256 of its stored bytes. */
export const IMAGE_ID_RE = /^[0-9a-f]{32}$/

const LINE_RE = /^!\[([^\]]*)\]\(img:([0-9a-f]{32})\)$/

/** The own-line markdown form of an image reference. Bracket and paren characters in `alt` would break the syntax, so they are dropped. */
export function imageRefLine(id: string, alt: string): string {
  return `![${alt.replace(/[[\]()\\r\n]/g, '')}](img:${id})`
}

/** Parses one markdown line as an image reference; anything else (prefix, suffix, other schemes) is null. */
export function parseImageLine(line: string): { id: string; alt: string } | null {
  const m = LINE_RE.exec(line)
  return m ? { id: m[2]!, alt: m[1]! } : null
}

/** Every free-text (markdown) field of the document, the places an image reference can live. */
export function* markdownFields(doc: Doc): Iterable<string> {
  for (const team of doc.teams) {
    yield* Object.values(team.dailyNotes)
    if (team.generalNotes) yield team.generalNotes
    for (const person of [...team.stakeholders, ...team.members]) yield person.notes
    for (const item of team.actionItems) { yield item.notes; yield item.summary }
    for (const m of team.milestones) yield m.followup
    for (const r of team.risks) yield r.followup
  }
  for (const tpl of doc.templates) yield tpl.body
}

/** Ids referenced from an image line anywhere in the document's markdown fields. */
export function collectImageRefs(doc: Doc): Set<string> {
  const ids = new Set<string>()
  for (const text of markdownFields(doc)) {
    if (!text.includes('](img:')) continue
    for (const line of text.split('\n')) {
      const ref = parseImageLine(line.trimEnd())
      if (ref) ids.add(ref.id)
    }
  }
  return ids
}

/** Total stored bytes of the images the document actually references (what a save would write). */
export function referencedBytes(doc: Doc): number {
  let total = 0
  for (const id of collectImageRefs(doc)) total += doc.images[id]?.bytes ?? 0
  return total
}
