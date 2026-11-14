import { TASK_PREFIX, fencedLines } from './markdown'
import { resolveTemplate, type TemplateCtx } from './templates'
import { t } from './i18n'

export interface OneOnOneResult {
  /** The whole new note. */
  md: string
  /** How many `---` rule lines the appended block itself contains; the block starts right after the (n+1)-th rule from the end. null = the note was empty, so the block is the whole note. */
  blockHrFromEnd: number | null
}

/** The block's body when the 1:1 template is missing. */
const FALLBACK_BODY = '## 1:1 — {date}'

const BULLET = /^( *)- (.*)$/
const LIST_ITEM = /^( *)(- |\d+\. )/
/** A horizontal rule, as `mdToHtml` reads one. */
const RULE = /^-{3,}$/

/** An open task's indent and whether its text is blank, or null when `line` is not an open task (only a `- ` bullet can be a task, never `1. `). */
function openTask(line: string): { indent: number; blank: boolean } | null {
  const b = BULLET.exec(line)
  if (!b) return null
  const m = TASK_PREFIX.exec(b[2]!)
  if (!m || m[1] !== ' ') return null
  return { indent: b[1]!.length, blank: !m[2]?.trim() }
}

/**
 * The note after a New 1:1: every open task of `noteMd` (outside code fences)
 * whose text is not blank is carried — copied, with its subtree, into the new
 * block's `{carryover}` — and marked `[>]` in place. The block is the resolved
 * template (`body`, or a bare heading when the template is missing), joined to
 * the note after a `---` rule.
 *
 * A task's subtree is the run of following list lines indented deeper than it.
 * A list item is exactly one line in this dialect (a `<br>` continuation
 * reloads as a plain line outside the list), so the first line that is not a
 * deeper list item ends it. The copy is dedented by the task's own indent, so a
 * task nested under a plain bullet is lifted to the top level, and keeps its
 * open children open; in the original, every open task inside the subtree is
 * marked carried along with the root. Otherwise the next 1:1 would carry a
 * child a second time, on its own, while it also travels inside its parent's
 * copy. The walk skips past a carried subtree for the same reason.
 *
 * A blank open task (`- [ ] ` with nothing typed) is an empty slot, not an
 * item: at the top of the walk it is neither carried nor marked.
 */
export function buildOneOnOne(noteMd: string, body: string | null, ctx: TemplateCtx): OneOnOneResult {
  const lines = noteMd.split('\n')
  const { fenced, unclosed } = fencedLines(lines)
  const marked = lines.slice()
  const items: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue
    const task = openTask(lines[i]!)
    if (!task || task.blank) continue
    let end = i + 1
    while (end < lines.length && !fenced[end] && (LIST_ITEM.exec(lines[end]!)?.[1]!.length ?? -1) > task.indent) end++
    // Every subtree line is indented deeper than the task, so the slice only removes spaces.
    items.push(lines.slice(i, end).map(l => l.slice(task.indent)).join('\n'))
    for (let j = i; j < end; j++) {
      const open = openTask(lines[j]!)
      // `- [ ]` is 5 characters from the indent on; only its marker changes.
      if (open) marked[j] = `${lines[j]!.slice(0, open.indent)}- [>]${lines[j]!.slice(open.indent + 5)}`
    }
    i = end - 1
  }

  // Exactly '' when nothing is carried: resolveTemplate drops the section only for an empty carryover.
  const carryover = items.join('\n')
  const template = body ?? FALLBACK_BODY
  let block = resolveTemplate(template, { ...ctx, carryover })
  if (!template.includes('{carryover}') && items.length) {
    // No place for the items in the template (edited away, or the fallback):
    // they go under their own heading right after the block's first line.
    const nl = block.indexOf('\n')
    const [first, rest] = nl < 0 ? [block, ''] : [block.slice(0, nl), block.slice(nl)]
    block = `${first}\n### ${t(ctx.locale, 'one_on_one_carried_heading')}\n${carryover}${rest}`
  }

  const markedNote = marked.join('\n')
  if (markedNote.trim() === '') return { md: block, blockHrFromEnd: null }
  // A fence left open at the end of the note (only a hand-edited file can hold
  // one; the editor always writes the closer) would swallow the rule and the
  // whole block as code, so it is closed first — which is how it rendered anyway.
  const head = markedNote.trimEnd() + (unclosed ? '\n```' : '')
  const blockLines = block.split('\n')
  const blockFenced = fencedLines(blockLines).fenced
  const blockHrFromEnd = blockLines.filter((l, i) => !blockFenced[i] && RULE.test(l)).length
  return { md: `${head}\n---\n${block}`, blockHrFromEnd }
}
