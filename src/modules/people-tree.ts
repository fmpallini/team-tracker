// src/modules/people-tree.ts — one parameterized renderer for both
// the 'stakeholders' and 'members' modules. Each renders the group's people
// as a drag-and-droppable hierarchy (parentId/order), following the
// disposal/store.subscribe discipline documented in src/modules/lifecycle.ts.
import type { Loc, Person, Team } from '../core/types'
import { t } from '../core/i18n'
import { installArrowFallbackFocus, NEW_ITEM_EVENT, type ModuleCtx, type ModuleRenderer } from '../ui/panes'
import { openPersonModal } from '../ui/person-modal'
import { emptyState } from '../ui/empty-state'
import { el, wheelScrollsHorizontally, clearClasses, keepRowFocus, rovingRows } from '../ui/dom'
import { dragAutoscroll } from '../ui/drag-autoscroll'
import { isMoveChord, isPlainKey } from '../ui/hotkeys'
import { jumpIndex } from '../ui/select-list'
import { unlinkRefsInTeam } from '../core/refs'
import { findTeam as docFindTeam } from '../core/document'
import { scopeAffects, type Section } from '../core/scope'
import { withDisposal } from './lifecycle'
import { deleteInTeamWithUndo } from '../core/undo-delete'
import { offerUndoToast } from '../ui/undo-toast'
import { icon, iconButton } from '../ui/icons'
import { showContextMenu } from '../ui/context-menu'

// --- pure, unit-testable helpers -------------------------------------------

/** Direct children of `parentId`, sorted by `order` (root list when `parentId` is null). */
export function childrenOf(people: Person[], parentId: string | null): Person[] {
  return people.filter((p) => p.parentId === parentId).sort((a, b) => a.order - b.order)
}

/** True when `nodeId` *is* `ancestorId` or is nested anywhere under it (walks parentId up from `nodeId`). */
export function isDescendant(people: Person[], nodeId: string, ancestorId: string): boolean {
  const byId = new Map(people.map((p) => [p.id, p]))
  let cur: Person | undefined = byId.get(nodeId)
  while (cur) {
    if (cur.id === ancestorId) return true
    cur = cur.parentId !== null ? byId.get(cur.parentId) : undefined
  }
  return false
}

/**
 * Maps a drop's vertical offset within the target row to a drop intent:
 * top quarter = insert as previous sibling, bottom quarter = insert as next
 * sibling, middle half = become a child of the target. A non-positive
 * `height` (rows not yet laid out, e.g. in a test without real layout)
 * degrades to 'child' rather than dividing by zero.
 */
export function computeDropPosition(offsetY: number, height: number): 'before' | 'after' | 'child' {
  if (height <= 0) return 'child'
  const ratio = offsetY / height
  if (ratio < 0.25) return 'before'
  if (ratio > 0.75) return 'after'
  return 'child'
}

/**
 * Moves `draggedId` to become a sibling (before/after `targetId`) or a child
 * of `targetId`, renumbering `order` within every affected sibling group so
 * it stays a dense 0..n-1 sequence. Mutates the Person objects in place (the
 * array itself is not replaced) so it can run directly inside a
 * `store.update` callback. No-ops (leaves `people` untouched) when the move
 * is a no-op or would create a cycle (dropping a node onto itself or onto
 * one of its own descendants) — this cycle guard lives here (rather than
 * only at the DOM dragover layer) so this function is safe to call
 * unconditionally and independently unit-testable.
 */
export function moveInTree(people: Person[], draggedId: string, targetId: string, position: 'before' | 'after' | 'child'): void {
  if (draggedId === targetId) return
  if (isDescendant(people, targetId, draggedId)) return
  const dragged = people.find((p) => p.id === draggedId)
  const target = people.find((p) => p.id === targetId)
  if (!dragged || !target) return

  const oldParentId = dragged.parentId
  const newParentId = position === 'child' ? target.id : target.parentId

  const newSiblings = people.filter((p) => p.parentId === newParentId && p.id !== draggedId).sort((a, b) => a.order - b.order)
  if (position === 'child') {
    newSiblings.push(dragged)
  } else {
    const targetIndex = newSiblings.findIndex((p) => p.id === targetId)
    const insertAt = position === 'before' ? targetIndex : targetIndex + 1
    newSiblings.splice(insertAt, 0, dragged)
  }
  dragged.parentId = newParentId
  newSiblings.forEach((p, i) => { p.order = i })

  // The old sibling group (if it differs from the new one) lost `dragged` —
  // close the order gap it left behind.
  if (oldParentId !== newParentId) {
    const oldSiblings = people.filter((p) => p.parentId === oldParentId && p.id !== draggedId).sort((a, b) => a.order - b.order)
    oldSiblings.forEach((p, i) => { p.order = i })
  }
}

/** Ctrl+Up on a box: `id` steps out to sit right after its manager, one level up. No-op at the root. */
export function moveUpALevel(people: Person[], id: string): void {
  const parentId = people.find((p) => p.id === id)?.parentId
  if (parentId) moveInTree(people, id, parentId, 'after')
}

/** The sibling just before `id`, the one Ctrl+Down files it under, if any. */
export function previousSibling(people: Person[], id: string): Person | undefined {
  const me = people.find((p) => p.id === id)
  if (!me) return undefined
  const sibs = childrenOf(people, me.parentId)
  return sibs[sibs.findIndex((p) => p.id === id) - 1]
}

/**
 * Swaps `id` with its previous (`delta` -1) or next (+1) sibling under the same parent, renumbering that group
 * to a dense 0..n-1 sequence. No-op at either end of the group or for an unknown id. Mutates in place, like `moveInTree`.
 */
export function moveAmongSiblings(people: Person[], id: string, delta: -1 | 1): void {
  const me = people.find((p) => p.id === id)
  if (!me) return
  const group = childrenOf(people, me.parentId)
  const i = group.indexOf(me)
  const j = i + delta
  if (j < 0 || j >= group.length) return
  group.splice(j, 0, ...group.splice(i, 1))
  group.forEach((p, k) => { p.order = k })
}

/**
 * Promotes `draggedId` to the root level (parentId null), appended after the
 * existing roots, renumbering both affected sibling groups. No-op when the
 * person is already a root or the id is unknown. Mutates the Person objects
 * in place — the same `store.update`-friendly contract as `moveInTree`.
 */
export function moveToRoot(people: Person[], draggedId: string): void {
  const dragged = people.find((p) => p.id === draggedId)
  if (!dragged || dragged.parentId === null) return
  const oldParentId = dragged.parentId
  const roots = people.filter((p) => p.parentId === null).sort((a, b) => a.order - b.order)
  roots.push(dragged)
  dragged.parentId = null
  roots.forEach((p, i) => { p.order = i })
  const oldSiblings = people.filter((p) => p.parentId === oldParentId).sort((a, b) => a.order - b.order)
  oldSiblings.forEach((p, i) => { p.order = i })
}

/**
 * Removes `id` from `people`, promoting its direct children to its own
 * `parentId`. Design choice: the promoted children are spliced into the
 * former sibling group *at the deleted node's original slot* (preserving
 * their own relative order among themselves) rather than appended at the
 * end of the group — this keeps the tree's visual position stable for
 * anyone scanning the list right after the delete, instead of the promoted
 * subtree jumping to the bottom. Returns a new array; does not mutate `people`.
 */
export function deletePerson(people: Person[], id: string): Person[] {
  const target = people.find((p) => p.id === id)
  if (!target) return people
  const parentId = target.parentId
  const promoted = people.filter((p) => p.parentId === id).sort((a, b) => a.order - b.order)
  const siblings = people.filter((p) => p.parentId === parentId).sort((a, b) => a.order - b.order)
  const idx = siblings.findIndex((p) => p.id === id)
  const merged = [...siblings.slice(0, idx), ...promoted, ...siblings.slice(idx + 1)]
  merged.forEach((p, i) => { p.order = i })
  promoted.forEach((p) => { p.parentId = parentId })
  return people.filter((p) => p.id !== id)
}

// --- renderer ---------------------------------------------------------------

export function renderPeopleTree(group: 'stakeholders' | 'members'): ModuleRenderer {
  return withDisposal(function renderTree(container: HTMLElement, loc: Loc, ctx: ModuleCtx) {
    if (loc.ref.kind !== group) return // registered only for this group's kind; defensive
    const teamId = loc.teamId
    const lc = ctx.locale

    function findTeam(): Team | undefined {
      return docFindTeam(ctx.store.doc, teamId)
    }
    function people(): Person[] {
      return findTeam()?.[group] ?? []
    }

    let draggedId: string | null = null

    function clearDropClasses(): void {
      clearClasses(treeEl, '.tt-org-box', 'tt-people-drop-before', 'tt-people-drop-after', 'tt-people-drop-child')
    }

    function openAddModal(parentId: string | null): void {
      openPersonModal(lc, {
        title: t(lc, 'person_add_title'),
        initialName: '',
        initialRole: '',
        onSubmit: (name, role) => {
          ctx.store.update((d) => {
            const tm = docFindTeam(d, teamId)
            if (!tm) return
            const siblings = tm[group].filter((p) => p.parentId === parentId)
            const order = siblings.length === 0 ? 0 : Math.max(...siblings.map((p) => p.order)) + 1
            tm[group].push({ id: crypto.randomUUID(), name, role, parentId, order, notes: '' })
          }, { teamId, sections: ['people'] })
        },
      })
    }

    function openEditModal(person: Person): void {
      openPersonModal(lc, {
        title: t(lc, 'person_edit_title'),
        initialName: person.name,
        initialRole: person.role,
        onSubmit: (name, role) => {
          ctx.store.update((d) => {
            const tm = docFindTeam(d, teamId)
            const p = tm?.[group].find((pp) => pp.id === person.id)
            if (!p) return
            p.name = name
            p.role = role
            // Deliberately unscoped beyond the team: `name` is the label every
            // @[…](person:id) mention in this team resolves through at render
            // time (ui/atref.ts's makeRefLabelResolver reads the store live, so
            // the label in the stored markdown is never authoritative). A pane
            // showing a mention of this person in a *different* section would
            // otherwise keep painting the old name until something else forced
            // it to re-render. Enumerating the mention-bearing sections here
            // would need hand-syncing with refs.ts forever.
          }, { teamId })
        },
      })
    }

    function renderBox(person: Person): HTMLElement {
      const openNotes = (): void => {
        ctx.pm.openInPane(ctx.paneIdx, { teamId, ref: { kind: 'person', personId: person.id, group } })
      }

      function deleteThisPerson(): void {
        // Deep copy (taken by deleteInTeamWithUndo), for two reasons:
        // unlinkRefsInTeam rewrites @mentions in place across the whole
        // team, and deletePerson() re-parents this node's children and
        // renumbers their siblings' `order` in place. A shallow capture
        // of tm[group] would share those very objects and restore none
        // of it.
        //
        // No `sections`: unlinkRefsInTeam rewrites @mentions across
        // every content-bearing section of this team (notes, actions,
        // milestones, risks — see refs.ts), not just 'people'.
        // Team-only scoping is the narrowest scope that's still
        // correct, and it won't rot if unlinkRefsInTeam's reach changes
        // later — refs never cross teams (see refs.ts's own header
        // comment), so `{ teamId }` alone is safe.
        const offer = deleteInTeamWithUndo(ctx.store, teamId,
          (tm) => tm[group].some((p) => p.id === person.id),
          (tm) => {
            unlinkRefsInTeam(tm, 'person', new Map([[person.id, person.name]]))
            tm[group] = deletePerson(tm[group], person.id)
          },
          { teamId })
        offerUndoToast(ctx.store, lc, t(lc, 'person_deleted_toast', { name: person.name }), offer)
      }

      // The box carries no action buttons of its own: the ⋯ button, a right-click and Space all open this one menu.
      const moveAmongSiblingsBy = (delta: -1 | 1): void => {
        ctx.store.update((d) => {
          const tm = docFindTeam(d, teamId)
          if (tm) moveAmongSiblings(tm[group], person.id, delta)
        }, { teamId, sections: ['people'] })
      }
      const moveLevel = (dir: 'up' | 'down'): void => {
        ctx.store.update((d) => {
          const list = docFindTeam(d, teamId)?.[group]
          if (!list) return
          if (dir === 'up') { moveUpALevel(list, person.id); return }
          const prev = previousSibling(list, person.id)
          if (prev) moveInTree(list, person.id, prev.id, 'child')
        }, { teamId, sections: ['people'] })
      }
      const openMenu = (x: number, y: number): void => {
        const sibs = childrenOf(people(), person.parentId)
        const at = sibs.findIndex((p) => p.id === person.id)
        const prev = previousSibling(people(), person.id)
        showContextMenu(x, y, [
          { label: t(lc, 'person_notes_title'), icon: icon('note'), onClick: openNotes },
          { label: t(lc, 'person_edit_title'), icon: icon('edit'), onClick: () => openEditModal(person) },
          { label: t(lc, 'person_add_child_title'), icon: icon('plus'), onClick: () => openAddModal(person.id) },
          // Left/right in the chart: an end of the sibling group has no further to go, so that item is left out.
          ...(at > 0 ? [{ label: t(lc, 'person_move_earlier_title'), icon: icon('back'), onClick: () => moveAmongSiblingsBy(-1) }] : []),
          ...(at >= 0 && at < sibs.length - 1 ? [{ label: t(lc, 'person_move_later_title'), icon: icon('next'), onClick: () => moveAmongSiblingsBy(1) }] : []),
          ...(person.parentId !== null ? [{ label: t(lc, 'person_move_up_level_title'), icon: icon('chevUp'), onClick: () => moveLevel('up') }] : []),
          ...(prev ? [{ label: t(lc, 'person_move_under_title', { name: prev.name }), icon: icon('chevDown'), onClick: () => moveLevel('down') }] : []),
          { label: t(lc, 'person_delete_title'), icon: icon('trash'), danger: true, onClick: deleteThisPerson },
        ])
      }

      const moreBtn = iconButton({
        class: 'tt-people-more-btn', title: t(lc, 'person_more_title'), icon: 'more', tabindex: '-1',
        onclick: (e) => {
          e.stopPropagation()
          const r = moreBtn.getBoundingClientRect()
          openMenu(r.left, r.bottom + 2)
        },
      })
      moreBtn.setAttribute('aria-haspopup', 'menu')
      // A double-click on the button must not fall through to the box's open-notes handler.
      moreBtn.addEventListener('dblclick', (e) => e.stopPropagation())

      const box = el(
        'div',
        // data-item-id (alongside data-person-id) is the anchor navigateToLoc's
        // highlight pass scrolls to and flash-rings — e.g. the person-notes
        // header's "show in org chart" jump. Same attribute the kanban/
        // milestone/risk rows carry for the identical search/@ref highlight.
        { class: 'tt-org-box', draggable: 'true', tabindex: '0', 'data-person-id': person.id, 'data-item-id': person.id, title: t(lc, 'person_box_hint') },
        el('div', { class: 'tt-org-name' }, person.name),
        el('div', { class: 'tt-org-role' }, person.role),
        moreBtn
      )

      box.addEventListener('dblclick', openNotes)
      box.addEventListener('contextmenu', (ev) => {
        ev.preventDefault()
        openMenu(ev.clientX, ev.clientY)
      })
      // The same row keys the task, risk and milestone rows answer to: Enter opens the full view (the
      // person's notes), Space the context menu, and the arrows walk the chart — Left/Right between siblings,
      // Up to the manager, Down to the first report. Guarded on the box itself so a keypress on its button is left alone.
      box.addEventListener('keydown', (ev) => {
        if (ev.target !== box) return
        // Ctrl+Left/Right reorders among siblings, Ctrl+Up/Down changes level; renderAll re-focuses the box by person id afterwards.
        if (isMoveChord(ev)) {
          const move = { ArrowLeft: () => moveAmongSiblingsBy(-1), ArrowRight: () => moveAmongSiblingsBy(1), ArrowUp: () => moveLevel('up'), ArrowDown: () => moveLevel('down') }[ev.key]
          if (!move) return
          ev.preventDefault()
          move()
          return
        }
        if (!isPlainKey(ev)) return
        const all = Array.from(treeEl.querySelectorAll<HTMLElement>('.tt-org-box'))
        const jump = jumpIndex(all.indexOf(box), ev.key, all.length)
        if (jump !== null) {
          ev.preventDefault()
          all[jump]?.focus()
          return
        }
        if (ev.key === 'Delete') {
          ev.preventDefault()
          deleteThisPerson()
          return
        }
        if (ev.key === 'Enter') {
          ev.preventDefault()
          openNotes()
          return
        }
        if (ev.key === ' ') {
          ev.preventDefault()
          const rect = box.getBoundingClientRect()
          openMenu(rect.left + 16, rect.bottom)
          return
        }
        const next = adjacentBox(box, ev.key)
        if (!next) return
        ev.preventDefault()
        next.focus()
      })

      box.addEventListener('dragstart', (e) => {
        e.stopPropagation()
        draggedId = person.id
        // The root drop zone only helps someone nested — a root person has
        // nowhere higher to go, so don't flash an inert target at them.
        if (person.parentId !== null) rootDropEl.classList.add('active')
        // Marks the tree so every *other* card shows it can be dropped onto
        // (styles.css). Nothing previously said the tree was a tree: the
        // drop bands only appeared once you were already dragging over one
        // specific card, so the whole nesting affordance was invisible to
        // anyone who didn't already know it existed. Toggling a class on an
        // ancestor is safe here — unlike revealing rootDropEl, it changes no
        // layout, so Chrome won't cancel the drag.
        treeEl.classList.add('tt-people-dragging')
        box.classList.add('tt-org-box-dragging')
        const dt = (e as DragEvent).dataTransfer
        if (dt) {
          dt.setData('text/plain', person.id)
          dt.effectAllowed = 'move'
        }
      })
      box.addEventListener('dragover', (e) => {
        if (draggedId === null || draggedId === person.id) return
        if (isDescendant(people(), person.id, draggedId)) return // would create a cycle — leave default (disallow drop)
        e.preventDefault()
        const rect = box.getBoundingClientRect()
        const offsetY = (e as MouseEvent).clientY - rect.top
        const pos = computeDropPosition(offsetY, rect.height)
        clearDropClasses()
        box.classList.add(`tt-people-drop-${pos}`)
      })
      box.addEventListener('dragleave', () => {
        box.classList.remove('tt-people-drop-before', 'tt-people-drop-after', 'tt-people-drop-child')
      })
      box.addEventListener('drop', (e) => {
        e.preventDefault()
        clearDropClasses()
        // Cleared eagerly, not left to dragend: the store update below
        // rebuilds the tree and can detach the drag source before its own
        // dragend fires, which would leave the tree stuck in drag styling.
        // treeEl itself survives the rebuild (only its innerHTML is wiped),
        // so its class would persist.
        treeEl.classList.remove('tt-people-dragging')
        const srcId = draggedId
        draggedId = null
        if (srcId === null || srcId === person.id) return
        if (isDescendant(people(), person.id, srcId)) return
        const rect = box.getBoundingClientRect()
        const offsetY = (e as MouseEvent).clientY - rect.top
        const pos = computeDropPosition(offsetY, rect.height)
        ctx.store.update((d) => {
          const tm = docFindTeam(d, teamId)
          if (!tm) return
          moveInTree(tm[group], srcId, person.id, pos)
        }, { teamId, sections: ['people'] })
      })
      box.addEventListener('dragend', () => {
        draggedId = null
        clearDropClasses()
        rootDropEl.classList.remove('active', 'drag-over')
        treeEl.classList.remove('tt-people-dragging')
        box.classList.remove('tt-org-box-dragging')
      })

      return box
    }

    function boxOf(node: Element | null | undefined): HTMLElement | null {
      return node?.querySelector<HTMLElement>(':scope > .tt-org-box') ?? null
    }
    /** The box an arrow key moves to from `box`, or null at the edge of the chart. */
    function adjacentBox(box: HTMLElement, key: string): HTMLElement | null {
      const node = box.parentElement
      if (key === 'ArrowDown') return boxOf(node?.querySelector(':scope > .tt-org-children > .tt-org-node'))
      if (key === 'ArrowUp') return boxOf(node?.parentElement?.closest('.tt-org-node'))
      if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
      const siblings = Array.from(node?.parentElement?.children ?? []).filter((c) => c.classList.contains('tt-org-node'))
      return boxOf(siblings[siblings.indexOf(node!) + (key === 'ArrowRight' ? 1 : -1)])
    }

    function renderNode(person: Person): HTMLElement {
      const kids = childrenOf(people(), person.id)
      const box = renderBox(person)
      const childrenEl = kids.length > 0 ? el('div', { class: 'tt-org-children' }, ...kids.map((k) => renderNode(k))) : null
      return el('div', { class: 'tt-org-node' }, box, childrenEl)
    }

    // Drop target for promoting a person to the root level. Lives outside
    // `treeEl` so the full rebuild in `renderAll()` never recreates it
    // mid-drag; shown only while dragging a nested person (see `dragstart`).
    // Styled as an absolute overlay (styles.css): revealing it while
    // dragstart is being processed must not reflow the tree, because Chrome
    // cancels a drag whose source element moves during dragstart — an
    // in-flow zone here silently killed dragging altogether.
    const rootDropEl = el('div', { class: 'tt-people-root-drop' }, t(lc, 'person_root_drop_hint'))
    rootDropEl.addEventListener('dragover', (e) => {
      if (draggedId === null) return
      e.preventDefault()
      rootDropEl.classList.add('drag-over')
    })
    rootDropEl.addEventListener('dragleave', () => {
      rootDropEl.classList.remove('drag-over')
    })
    rootDropEl.addEventListener('drop', (e) => {
      e.preventDefault()
      // Hide eagerly: the store update rebuilds the tree, which can detach
      // the drag source before its `dragend` (the usual hider) ever fires.
      rootDropEl.classList.remove('active', 'drag-over')
      treeEl.classList.remove('tt-people-dragging')
      const srcId = draggedId
      draggedId = null
      if (srcId === null) return
      ctx.store.update((d) => {
        const tm = docFindTeam(d, teamId)
        if (!tm) return
        moveToRoot(tm[group], srcId)
      }, { teamId, sections: ['people'] })
    })

    const treeEl = el('div', { class: 'tt-people-tree tt-org-root' })
    const boxStops = rovingRows(treeEl, '.tt-org-box')
    function renderAll(): void {
      keepRowFocus(treeEl, '.tt-org-box', rebuildTree)
      boxStops.refresh()
    }
    function rebuildTree(): void {
      treeEl.innerHTML = ''
      const roots = childrenOf(people(), null)
      if (roots.length === 0) {
        // Group-specific invitation, not `pane_empty` — that string means "no
        // module is open", which is actively false here: the module is open,
        // it just has nothing in it yet.
        const emptyKey = group === 'members' ? 'people_empty_members' : 'people_empty_stakeholders'
        treeEl.appendChild(emptyState({ icon: 'orgchart', text: t(lc, emptyKey), className: 'tt-people-empty', action: { label: t(lc, 'person_add_btn'), onClick: () => openAddModal(null) } }))
        return
      }
      roots.forEach((r) => treeEl.appendChild(renderNode(r)))
    }
    renderAll()

    const addRootBtn = el(
      'button',
      { class: 'tt-btn tt-people-add-btn', type: 'button', onclick: () => openAddModal(null) },
      t(lc, 'person_add_btn')
    )
    const toolbar = el('div', { class: 'tt-people-toolbar' }, addRootBtn)

    // The tree has no caret/focus state worth preserving (unlike the
    // daily-notes editor) — a full rebuild on every store change is simplest
    // and correct.
    const WATCHED: readonly Section[] = ['people', 'teams']
    const unsubscribe = ctx.store.subscribe((scope) => {
      if (!scopeAffects(scope, teamId, WATCHED)) return
      renderAll()
    })
    // A wide chart scrolls sideways under the plain wheel, as the kanban board does.
    const unbindWheel = wheelScrollsHorizontally(treeEl)
    // A person held at the chart's or pane's edge scrolls it (the wheel is silent during a native drag).
    const unbindDragScroll = dragAutoscroll(treeEl)
    const onNewItem = (): void => openAddModal(null)
    container.addEventListener(NEW_ITEM_EVENT, onNewItem)

    // With nothing focused an arrow key starts the walk at the root, as it does on the task, risk and
    // milestone lists.
    const disposeArrowFallback = installArrowFallbackFocus(ctx, treeEl, '.tt-org-box', ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'])

    container.appendChild(el('div', { class: 'tt-people' }, toolbar, rootDropEl, treeEl))
    // Lands focus on the root the moment the module opens, so the arrows work without a preceding Tab. Only
    // for the pane the user is in: a team switch remounts both panes, and the second would steal the first's focus.
    if (ctx.paneIdx === ctx.store.doc.nav.focusedPane) treeEl.querySelector<HTMLElement>('.tt-org-box')?.focus()

    return () => {
      unsubscribe()
      unbindWheel()
      unbindDragScroll()
      disposeArrowFallback()
      container.removeEventListener(NEW_ITEM_EVENT, onNewItem)
    }
  })
}
