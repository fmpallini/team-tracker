// src/ui/atref.ts — `@` mention autocomplete: a dropdown, anchored at the
// caret, for inserting person/day reference chips into the editor; plus the
// app-level ref-click navigation handler every module renderer (Tasks 18/19)
// wires into EditorHooks.onRefClick.
import { AT_TRIGGER_EVENT, type Editor } from './editor'
import type { RefInfo, LabelResolver } from '../core/markdown'
import { t, formatDate, parseLocaleDate, type Locale, type MsgKey } from '../core/i18n'
import { normalize, KIND_ICON, type TeamRefCandidates } from '../core/search'
import type { Store } from '../core/store'
import type { PaneManager } from './panes'
import { el } from './dom'

export type { AtPerson } from '../core/search'

export type AtItem =
  | { kind: 'person'; id: string; name: string }
  // `relativeWord` is set only for the hoje/ontem/amanhã (today/yesterday/
  // tomorrow) matches — lets the dropdown show "@hoje · 19/07/2026" so the
  // trigger word is discoverable, vs. a typed-exact-date match or the
  // format-hint item below, which stay unlabeled and just read as a normal
  // "go to day" result.
  | { kind: 'day'; date: string; relativeWord?: string }
  | { kind: 'action' | 'milestone' | 'risk'; id: string; title: string }

const RELATIVE_DAYS: Record<Locale, [string, number][]> = {
  'pt-BR': [['hoje', 0], ['ontem', -1], ['amanhã', 1]],
  'en-US': [['today', 0], ['yesterday', -1], ['tomorrow', 1]],
}

function isoWithOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const GROUP_CAP = 5

/**
 * Pure, unit-testable filter over a team's candidates, grouped by type
 * (people, dates, action items, milestones, risks — in that order) and
 * capped at GROUP_CAP per group. Substring match (accent/case-insensitive,
 * via core/search's normalize). Relative-day words (hoje/ontem/amanhã,
 * today/yesterday/tomorrow) always show, even on an empty query — that's
 * what makes '@today' discoverable from a bare '@'. A "go to day" item is
 * additionally appended when `typed` parses as a *complete* date in the
 * locale's format.
 */
export function filterAtItems(candidates: TeamRefCandidates, typed: string, locale: Locale): AtItem[] {
  const trimmed = typed.trim()
  const q = normalize(trimmed)

  const people: AtItem[] = candidates.people
    .filter((p) => normalize(p.name).includes(q))
    .slice(0, GROUP_CAP)
    .map((p): AtItem => ({ kind: 'person', id: p.id, name: p.name }))

  const days: AtItem[] = []
  for (const [word, offset] of RELATIVE_DAYS[locale]) {
    if (normalize(word).startsWith(q)) days.push({ kind: 'day', date: isoWithOffset(offset), relativeWord: word })
  }
  const iso = parseLocaleDate(trimmed, locale)
  if (iso) days.push({ kind: 'day', date: iso })
  // Format-hint: on a bare '@' (alongside the 3 relative words), a 4th real,
  // selectable day item using today+2 — its label (a plain "go to day"
  // result showing a dd/mm/yyyy-shaped date) doubles as a worked example of
  // the exact-date format users can type directly, without any new copy.
  if (trimmed === '') days.push({ kind: 'day', date: isoWithOffset(2) })

  const actions: AtItem[] = candidates.actionItems
    .filter((c) => normalize(c.title).includes(q))
    .slice(0, GROUP_CAP)
    .map((c): AtItem => ({ kind: 'action', id: c.id, title: c.title }))

  const milestones: AtItem[] = candidates.milestones
    .filter((c) => normalize(c.title).includes(q))
    .slice(0, GROUP_CAP)
    .map((c): AtItem => ({ kind: 'milestone', id: c.id, title: c.title }))

  const risks: AtItem[] = candidates.risks
    .filter((c) => normalize(c.title).includes(q))
    .slice(0, GROUP_CAP)
    .map((c): AtItem => ({ kind: 'risk', id: c.id, title: c.title }))

  return [...people, ...days, ...actions, ...milestones, ...risks]
}

interface AtLoc { block: HTMLElement; atOffset: number; caretOffset: number; typed: string }

export interface AtAutocompleteHandle {
  /** Closes any open dropdown and removes all document/element listeners this instance attached. Idempotent. */
  dispose(): void
}

export function attachAtAutocomplete(editor: Editor, opts: {
  getRefCandidates(): TeamRefCandidates
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

  const GROUP_HEADER_KEY: Record<AtItem['kind'], MsgKey> = {
    person: 'atref_group_people',
    day: 'atref_group_dates',
    action: 'module_actions',
    milestone: 'module_milestones',
    risk: 'module_risks',
  }
  const GROUP_ICON: Record<AtItem['kind'], string> = {
    person: KIND_ICON.person,
    day: KIND_ICON.daily,
    action: KIND_ICON.actions,
    milestone: KIND_ICON.milestones,
    risk: KIND_ICON.risks,
  }

  function renderList(): void {
    if (!listEl) return
    listEl.innerHTML = ''
    let lastKind: AtItem['kind'] | null = null
    items.forEach((item, i) => {
      if (item.kind !== lastKind) {
        listEl!.appendChild(
          el('div', { class: 'tt-atref-group-header' }, `${GROUP_ICON[item.kind]} ${t(opts.locale, GROUP_HEADER_KEY[item.kind])}`)
        )
        lastKind = item.kind
      }
      const label = item.kind === 'person'
        ? item.name
        : item.kind === 'day'
          ? item.relativeWord
            ? `@${item.relativeWord} · ${formatDate(item.date, opts.locale)}`
            : t(opts.locale, 'atref_goto_day', { date: formatDate(item.date, opts.locale) })
          : item.title
      const row = el(
        'div',
        {
          class: 'tt-atref-item' + (i === selected ? ' selected' : ''),
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: () => commit(item),
          // See template-picker.ts's identical fix: rebuilding the row on
          // hover (via renderList()) made real Chrome re-fire mouseenter on
          // the replacement node under a stationary pointer, looping
          // forever and leaving mousedown/mouseup on two different elements
          // — so no click event ever fired.
          onmouseenter: () => { selected = i; updateSelectedClass() },
        },
        label
      )
      listEl!.appendChild(row)
    })
  }

  /** Only .tt-atref-item rows are selectable — group headers are interspersed in the DOM but not in `items`/`selected`, so this must query past them rather than index into listEl.children directly. */
  function updateSelectedClass(): void {
    if (!listEl) return
    const rows = Array.from(listEl.querySelectorAll<HTMLElement>('.tt-atref-item'))
    rows.forEach((row, i) => row.classList.toggle('selected', i === selected))
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
    items = filterAtItems(opts.getRefCandidates(), loc.typed, opts.locale)
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

    const label = item.kind === 'person'
      ? item.name
      : item.kind === 'day'
        ? formatDate(item.date, opts.locale)
        : item.title
    const safeLabel = label.replace(/[[\]()]/g, '')
    const chip = document.createElement('a')
    chip.className = 'ref'
    chip.setAttribute('contenteditable', 'false')
    // Chip *text content* stays exactly `@${safeLabel}` — the per-kind icon
    // is CSS-only (styles.css, keyed off this same data-ref prefix), never
    // baked into textContent. inlineMd (core/markdown.ts) derives the
    // persisted markdown label straight from textContent, so an icon inside
    // it would round-trip into storage as part of the label forever.
    chip.dataset.ref = item.kind === 'person' ? `person:${item.id}` : item.kind === 'day' ? `day:${item.date}` : `${item.kind}:${item.id}`
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

    if (target.kind === 'action' || target.kind === 'milestone' || target.kind === 'risk') {
      const moduleKind = target.kind === 'action' ? 'actions' : target.kind === 'milestone' ? 'milestones' : 'risks'
      pm.openInPane(paneIdx, { teamId, ref: { kind: moduleKind, itemId: target.id } })
      // Best-effort scroll to the specific card, mirroring search-ui.ts's
      // commit() — no toast if the item was deleted (decision 7: with
      // auto-unlink-on-delete this is a defensive fallback for edge cases
      // outside the app's own control, e.g. a hand-edited .tmv or an import
      // merge, not the common path).
      requestAnimationFrame(() => {
        const paneEl = document.querySelectorAll('.tt-pane-body')[paneIdx] as HTMLElement | undefined
        paneEl?.querySelector(`[data-item-id="${target.id}"]`)?.scrollIntoView({ block: 'center' })
      })
      return
    }

    const team = store.doc.teams.find((tm) => tm.id === teamId)
    const group = team?.stakeholders.some((p) => p.id === target.id)
      ? 'stakeholders'
      : team?.members.some((p) => p.id === target.id)
        ? 'members'
        : null
    // No toast on a dangling person ref either — same reasoning as above,
    // and consistent with the other 3 kinds instead of the other way around.
    if (!group) return
    pm.openInPane(paneIdx, { teamId, ref: { kind: 'person', personId: target.id, group } })
  }
}

/**
 * Live label resolution for core/markdown.ts's mdToHtml: given a ref target,
 * returns the item's *current* name/title (so a chip shows the up-to-date
 * label even if the item was renamed after the mention was typed), or null
 * if resolveLabel has nothing to offer (day is always resolvable; the other
 * 4 fall back to null only if the id genuinely isn't found, which per
 * decision 7 shouldn't normally happen once auto-unlink-on-delete is wired
 * up in Task 7).
 */
export function makeRefLabelResolver(store: Store, teamId: string): LabelResolver {
  return (target) => {
    if (target.kind === 'day') return formatDate(target.date, store.doc.prefs.locale)
    const team = store.doc.teams.find((tm) => tm.id === teamId)
    if (!team) return null
    switch (target.kind) {
      case 'person': {
        const p = team.stakeholders.find((pp) => pp.id === target.id) ?? team.members.find((pp) => pp.id === target.id)
        return p ? p.name : null
      }
      case 'action': {
        const a = team.actionItems.find((i) => i.id === target.id)
        return a ? a.summary : null
      }
      case 'milestone': {
        const m = team.milestones.find((i) => i.id === target.id)
        return m ? m.title : null
      }
      case 'risk': {
        const r = team.risks.find((i) => i.id === target.id)
        return r ? r.title : null
      }
    }
  }
}
