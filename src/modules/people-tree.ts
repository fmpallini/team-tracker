// src/modules/people-tree.ts — Task 19: one parameterized renderer for both
// the 'stakeholders' and 'members' modules. Each renders the group's people
// as a drag-and-droppable hierarchy (parentId/order), mirroring the
// disposal/store.subscribe discipline established by src/modules/daily-notes.ts.
import type { Loc, Person, Team } from '../core/types'
import { t, type Locale } from '../core/i18n'
import type { ModuleCtx, ModuleRenderer } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { el } from '../ui/dom'

/** Per-container disposers — see the extensive comment on the same pattern in src/modules/daily-notes.ts. */
const disposers = new WeakMap<HTMLElement, () => void>()

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
  return function renderTree(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void {
    disposers.get(container)?.()
    disposers.delete(container)

    if (loc.ref.kind !== group) return // registered only for this group's kind; defensive
    const teamId = loc.teamId
    const lc = ctx.locale

    function findTeam(): Team | undefined {
      return ctx.store.doc.teams.find((tm) => tm.id === teamId)
    }
    function people(): Person[] {
      return findTeam()?.[group] ?? []
    }

    let draggedId: string | null = null

    function clearDropClasses(): void {
      treeEl.querySelectorAll('.tt-people-row').forEach((n) => {
        n.classList.remove('tt-people-drop-before', 'tt-people-drop-after', 'tt-people-drop-child')
      })
    }

    function openPersonModal(opts: { title: string; initialName: string; initialRole: string; onSubmit: (name: string, role: string) => void }): void {
      const nameInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-person-name' })
      nameInput.value = opts.initialName
      const roleInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-person-role' })
      roleInput.value = opts.initialRole
      const errorEl = el('div', { class: 'tt-field-error' })
      const body = el(
        'div',
        { class: 'tt-person-form' },
        el('label', { class: 'tt-field' }, t(lc, 'person_name_label'), nameInput),
        el('label', { class: 'tt-field' }, t(lc, 'person_role_label'), roleInput),
        errorEl
      )
      let handle: ModalHandle
      const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
      const okBtn: ModalButton = {
        label: t(lc, 'ok'),
        primary: true,
        onClick: () => {
          const name = nameInput.value.trim()
          if (!name) {
            errorEl.textContent = t(lc, 'person_name_required')
            return
          }
          opts.onSubmit(name, roleInput.value.trim())
          handle.close()
        },
      }
      handle = showModal({ title: opts.title, body, buttons: [cancelBtn, okBtn] })
      nameInput.focus()
    }

    function openAddModal(parentId: string | null): void {
      openPersonModal({
        title: t(lc, 'person_add_title'),
        initialName: '',
        initialRole: '',
        onSubmit: (name, role) => {
          ctx.store.update((d) => {
            const tm = d.teams.find((t2) => t2.id === teamId)
            if (!tm) return
            const siblings = tm[group].filter((p) => p.parentId === parentId)
            const order = siblings.length === 0 ? 0 : Math.max(...siblings.map((p) => p.order)) + 1
            tm[group].push({ id: crypto.randomUUID(), name, role, parentId, order, notes: '' })
          })
        },
      })
    }

    function openEditModal(person: Person): void {
      openPersonModal({
        title: t(lc, 'person_edit_title'),
        initialName: person.name,
        initialRole: person.role,
        onSubmit: (name, role) => {
          ctx.store.update((d) => {
            const tm = d.teams.find((t2) => t2.id === teamId)
            const p = tm?.[group].find((pp) => pp.id === person.id)
            if (!p) return
            p.name = name
            p.role = role
          })
        },
      })
    }

    function openDeleteConfirm(person: Person): void {
      const message = t(lc, 'person_delete_confirm', { name: person.name })
      const body = el('p', { class: 'tt-modal-message' }, message)
      let handle: ModalHandle
      const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
      const confirmBtn: ModalButton = {
        label: t(lc, 'person_delete_btn'),
        primary: true,
        onClick: () => {
          ctx.store.update((d) => {
            const tm = d.teams.find((t2) => t2.id === teamId)
            if (!tm) return
            tm[group] = deletePerson(tm[group], person.id)
          })
          handle.close()
        },
      }
      handle = showModal({ title: t(lc, 'person_delete_title'), body, buttons: [cancelBtn, confirmBtn] })
    }

    function renderRow(person: Person, depth: number): HTMLElement {
      const label = person.role ? `${person.name} — ${person.role}` : person.name
      const notesBtn = el(
        'button',
        {
          class: 'tt-btn tt-people-notes-btn', type: 'button', title: t(lc, 'person_notes_title'),
          onclick: (e: Event) => { e.stopPropagation(); ctx.pm.openInFocused({ teamId, ref: { kind: 'person', personId: person.id, group } }) },
        },
        '📝'
      )
      const editBtn = el(
        'button',
        { class: 'tt-btn tt-people-edit-btn', type: 'button', title: t(lc, 'person_edit_title'), onclick: (e: Event) => { e.stopPropagation(); openEditModal(person) } },
        '✎'
      )
      const addChildBtn = el(
        'button',
        { class: 'tt-btn tt-people-add-child-btn', type: 'button', title: t(lc, 'person_add_child_title'), onclick: (e: Event) => { e.stopPropagation(); openAddModal(person.id) } },
        '+'
      )
      const deleteBtn = el(
        'button',
        { class: 'tt-btn tt-people-delete-btn', type: 'button', title: t(lc, 'person_delete_title'), onclick: (e: Event) => { e.stopPropagation(); openDeleteConfirm(person) } },
        '🗑'
      )
      const actions = el('div', { class: 'tt-people-actions' }, notesBtn, editBtn, addChildBtn, deleteBtn)

      const row = el(
        'div',
        {
          class: 'tt-people-row', style: `padding-left: ${depth * 1.25}rem`, draggable: 'true', 'data-person-id': person.id,
        },
        el('span', { class: 'tt-people-label' }, label),
        actions
      )

      row.addEventListener('dragstart', (e) => {
        e.stopPropagation()
        draggedId = person.id
        const dt = (e as DragEvent).dataTransfer
        if (dt) {
          dt.setData('text/plain', person.id)
          dt.effectAllowed = 'move'
        }
      })
      row.addEventListener('dragover', (e) => {
        if (draggedId === null || draggedId === person.id) return
        if (isDescendant(people(), person.id, draggedId)) return // would create a cycle — leave default (disallow drop)
        e.preventDefault()
        const rect = row.getBoundingClientRect()
        const offsetY = (e as MouseEvent).clientY - rect.top
        const pos = computeDropPosition(offsetY, rect.height)
        clearDropClasses()
        row.classList.add(`tt-people-drop-${pos}`)
      })
      row.addEventListener('dragleave', () => {
        row.classList.remove('tt-people-drop-before', 'tt-people-drop-after', 'tt-people-drop-child')
      })
      row.addEventListener('drop', (e) => {
        e.preventDefault()
        clearDropClasses()
        const srcId = draggedId
        draggedId = null
        if (srcId === null || srcId === person.id) return
        if (isDescendant(people(), person.id, srcId)) return
        const rect = row.getBoundingClientRect()
        const offsetY = (e as MouseEvent).clientY - rect.top
        const pos = computeDropPosition(offsetY, rect.height)
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          if (!tm) return
          moveInTree(tm[group], srcId, person.id, pos)
        })
      })
      row.addEventListener('dragend', () => {
        draggedId = null
        clearDropClasses()
      })

      return row
    }

    function renderNode(person: Person, depth: number): HTMLElement {
      const kids = childrenOf(people(), person.id)
      const wrap = el('div', { class: 'tt-people-node' }, renderRow(person, depth))
      if (kids.length > 0) {
        const kidsWrap = el('div', { class: 'tt-people-children' }, ...kids.map((k) => renderNode(k, depth + 1)))
        wrap.appendChild(kidsWrap)
      }
      return wrap
    }

    const treeEl = el('div', { class: 'tt-people-tree' })
    function renderAll(): void {
      treeEl.innerHTML = ''
      const roots = childrenOf(people(), null)
      if (roots.length === 0) {
        treeEl.appendChild(el('div', { class: 'tt-people-empty' }, t(lc, 'pane_empty')))
        return
      }
      roots.forEach((r) => treeEl.appendChild(renderNode(r, 0)))
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
    const unsubscribe = ctx.store.subscribe(() => {
      renderAll()
    })

    container.appendChild(el('div', { class: 'tt-people' }, toolbar, treeEl))

    disposers.set(container, () => {
      unsubscribe()
    })
  }
}
