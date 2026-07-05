// src/ui/atref.ts — `@` mention autocomplete: a dropdown, anchored at the
// caret, for inserting person/day reference chips into the editor; plus the
// app-level ref-click navigation handler every module renderer (Tasks 18/19)
// wires into EditorHooks.onRefClick.
import { AT_TRIGGER_EVENT, type Editor } from './editor'
import type { RefInfo } from '../core/markdown'
import { t, formatDate, parseLocaleDate, type Locale } from '../core/i18n'
import { normalize } from '../core/search'
import type { Store } from '../core/store'
import type { PaneManager } from './panes'
import { toast } from './modal'
import { el } from './dom'

export interface AtPerson { id: string; name: string; group: 'stakeholders' | 'members' }

export type AtItem =
  | { kind: 'person'; id: string; name: string }
  | { kind: 'day'; date: string }

/**
 * Pure, unit-testable filter: substring match (accent/case-insensitive, via
 * core/search's normalize) on people names, plus a "go to day" item appended
 * when `typed` parses as a *complete* date in the locale's format.
 */
export function filterAtItems(people: AtPerson[], typed: string, locale: Locale): AtItem[] {
  const trimmed = typed.trim()
  const q = normalize(trimmed)
  const items: AtItem[] = people
    .filter((p) => normalize(p.name).includes(q))
    .map((p): AtItem => ({ kind: 'person', id: p.id, name: p.name }))
  const iso = parseLocaleDate(trimmed, locale)
  if (iso) items.push({ kind: 'day', date: iso })
  return items
}

interface AtLoc { block: HTMLElement; atOffset: number; caretOffset: number; typed: string }

export interface AtAutocompleteHandle {
  /** Closes any open dropdown and removes all document/element listeners this instance attached. Idempotent. */
  dispose(): void
}

export function attachAtAutocomplete(editor: Editor, opts: {
  getPeople(): AtPerson[]
  locale: Locale
  onPick(item: AtItem): void
}): AtAutocompleteHandle {
  const editorEl = editor.root.querySelector<HTMLElement>('.editor')
  if (!editorEl) return { dispose() {} }

  let overlay: HTMLElement | null = null
  let listEl: HTMLElement | null = null
  let anchorRange: Range | null = null
  let items: AtItem[] = []
  let selected = 0
  let lastLoc: AtLoc | null = null

  // --- caret/block helpers (mirrors src/ui/editor.ts's private helpers;
  // duplicated rather than exported from there to keep this module fully
  // decoupled from the editor's internals — it only depends on `.editor`
  // being the contenteditable root and on the AT_TRIGGER_EVENT contract). ---

  function blockAndCaret(): { block: HTMLElement; text: string; caretOffset: number } | null {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    if (!editorEl!.contains(range.startContainer)) return null
    let block: HTMLElement | null = null
    let n: Node | null = range.startContainer
    while (n && n !== editorEl) {
      if (n instanceof HTMLElement && (n.parentElement === editorEl || n.tagName === 'LI')) {
        block = n
        break
      }
      n = n.parentElement
    }
    if (!block) return null
    const preRange = document.createRange()
    preRange.selectNodeContents(block)
    preRange.setEnd(range.startContainer, range.startOffset)
    const caretOffset = preRange.toString().length
    return { block, text: block.textContent ?? '', caretOffset }
  }

  function rangeForOffsets(block: HTMLElement, start: number, end: number): Range {
    const range = document.createRange()
    let remainingStart = start
    let remainingEnd = end
    let startSet = false
    let endSet = false
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const len = node.textContent?.length ?? 0
      if (!startSet && remainingStart <= len) { range.setStart(node, remainingStart); startSet = true }
      if (!endSet && remainingEnd <= len) { range.setEnd(node, remainingEnd); endSet = true; break }
      remainingStart -= len
      remainingEnd -= len
    }
    if (!startSet) range.setStart(block, block.childNodes.length)
    if (!endSet) range.setEnd(block, block.childNodes.length)
    return range
  }

  /** Finds the `@` nearest before the caret and the text typed since it. Null once the `@` itself has been deleted (or the caret left the block). */
  function locateAt(): AtLoc | null {
    const ctx = blockAndCaret()
    if (!ctx || ctx.caretOffset === 0) return null
    const at = ctx.text.lastIndexOf('@', ctx.caretOffset - 1)
    if (at < 0) return null
    return { block: ctx.block, atOffset: at, caretOffset: ctx.caretOffset, typed: ctx.text.slice(at + 1, ctx.caretOffset) }
  }

  // --- dropdown rendering ---------------------------------------------------

  function renderList(): void {
    if (!listEl) return
    listEl.innerHTML = ''
    items.forEach((item, i) => {
      const label = item.kind === 'person'
        ? item.name
        : t(opts.locale, 'atref_goto_day', { date: formatDate(item.date, opts.locale) })
      const row = el(
        'div',
        {
          class: 'tt-atref-item' + (i === selected ? ' selected' : ''),
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: () => commit(item),
          onmouseenter: () => { selected = i; renderList() },
        },
        label
      )
      listEl!.appendChild(row)
    })
  }

  function positionOverlay(): void {
    if (!overlay || !anchorRange) return
    // jsdom's Range does not implement getBoundingClientRect (real browsers
    // always do) — guard so tests can exercise the rest of the dropdown
    // lifecycle without a layout-capable DOM.
    if (typeof anchorRange.getBoundingClientRect !== 'function') return
    const rect = anchorRange.getBoundingClientRect()
    overlay.style.left = `${rect.left}px`
    overlay.style.top = `${rect.bottom}px`
  }

  function refresh(): void {
    const loc = locateAt()
    if (!loc) { close(); return }
    lastLoc = loc
    items = filterAtItems(opts.getPeople(), loc.typed, opts.locale)
    selected = items.length === 0 ? 0 : Math.min(selected, items.length - 1)
    renderList()
  }

  // --- lifecycle: open on AT_TRIGGER_EVENT, track typing while active ------

  function onDocMousedown(e: MouseEvent): void {
    if (overlay?.contains(e.target as Node)) return
    close()
  }

  function onTypingInput(): void {
    refresh()
  }

  function onTypingKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selected = items.length ? Math.min(selected + 1, items.length - 1) : 0
      renderList()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selected = Math.max(selected - 1, 0)
      renderList()
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      commit(items[selected])
    }
  }

  function commit(item: AtItem | undefined): void {
    if (!item || !lastLoc) return
    const { block, atOffset, caretOffset } = lastLoc
    const range = rangeForOffsets(block, atOffset, caretOffset)
    range.deleteContents()

    const label = item.kind === 'person' ? item.name : formatDate(item.date, opts.locale)
    const safeLabel = label.replace(/[\[\]()]/g, '')
    const chip = document.createElement('a')
    chip.className = 'ref'
    chip.setAttribute('contenteditable', 'false')
    chip.dataset.ref = item.kind === 'person' ? `person:${item.id}` : `day:${item.date}`
    chip.textContent = `@${safeLabel}`
    range.insertNode(chip)
    // A trailing space after the chip lets the user keep typing immediately
    // without first tapping space themselves (mirrors Slack/GitHub/Notion
    // mention-insert UX).
    const space = document.createTextNode(' ')
    chip.after(space)

    const sel = window.getSelection()
    if (sel) {
      const after = document.createRange()
      after.setStartAfter(space)
      after.collapse(true)
      sel.removeAllRanges()
      sel.addRange(after)
    }

    // Close (and detach the typing listeners) before notifying the editor of
    // the change: the chip's own text starts with "@", so if onTypingInput
    // were still attached it would immediately re-locate that "@" as a new,
    // bogus trigger.
    close()
    editorEl!.dispatchEvent(new Event('input', { bubbles: true }))
    opts.onPick(item)
  }

  function close(): void {
    if (!overlay) return
    overlay.remove()
    overlay = null
    listEl = null
    anchorRange = null
    lastLoc = null
    editorEl!.removeEventListener('input', onTypingInput)
    editorEl!.removeEventListener('keydown', onTypingKeydown, true)
    document.removeEventListener('mousedown', onDocMousedown, true)
  }

  function open(range: Range): void {
    close()
    anchorRange = range
    listEl = el('div', { class: 'tt-atref-list' })
    overlay = el('div', { class: 'tt-atref-dropdown' }, listEl)
    document.body.appendChild(overlay)
    positionOverlay()
    editorEl!.addEventListener('input', onTypingInput)
    editorEl!.addEventListener('keydown', onTypingKeydown, true)
    document.addEventListener('mousedown', onDocMousedown, true)
    selected = 0
    refresh()
  }

  const onAtTriggerEvent = ((e: Event) => {
    open((e as CustomEvent<Range>).detail)
  }) as EventListener
  editorEl.addEventListener(AT_TRIGGER_EVENT, onAtTriggerEvent)

  return {
    dispose(): void {
      close()
      editorEl!.removeEventListener(AT_TRIGGER_EVENT, onAtTriggerEvent)
    },
  }
}

/**
 * App-level `EditorHooks.onRefClick` handler shared by every module renderer
 * that mounts an editor (Tasks 18/19): navigates to the referenced person
 * (searched in the owning team's stakeholders/members) or day, in the pane
 * that hosts the editor the click came from (`paneIdx`, taken from that
 * module's `ModuleCtx` at mount time) — *not* whatever pane currently holds
 * focus. This matters because the click bubbles from the `<a class="ref">`
 * chip up through the editor's `onRefClick` hook before it reaches the outer
 * `.tt-pane` div's own click handler (the one that calls `setFocusedPane`),
 * so `store.doc.nav.focusedPane` can still be the *other*, previously
 * focused pane at the moment this handler runs. Using the editor's own
 * `paneIdx` keeps "chip navigates within the same pane" correct regardless
 * of which pane had focus before the click. Duplicate-open handling (focus
 * the other pane instead) is inherited for free from `PaneManager.openInPane`
 * -> `openLoc`.
 */
export function makeRefClickHandler(store: Store, pm: PaneManager, paneIdx: 0 | 1, locale: Locale, teamId: string): (target: RefInfo['target']) => void {
  return (target) => {
    if (target.kind === 'day') {
      pm.openInPane(paneIdx, { teamId, ref: { kind: 'daily', date: target.date } })
      return
    }

    const team = store.doc.teams.find((tm) => tm.id === teamId)
    const group = team?.stakeholders.some((p) => p.id === target.id)
      ? 'stakeholders'
      : team?.members.some((p) => p.id === target.id)
        ? 'members'
        : null
    if (!group) {
      toast(t(locale, 'toast_person_not_found'))
      return
    }
    pm.openInPane(paneIdx, { teamId, ref: { kind: 'person', personId: target.id, group } })
  }
}
