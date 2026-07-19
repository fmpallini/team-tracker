// src/modules/person-notes.ts — Task 19: notes editor for a single person
// (stakeholder or member). Mirrors src/modules/daily-notes.ts's editor +
// atref + template-picker wiring, but persists into `person.notes` and
// additionally has to cope with the person being deleted (from the people
// tree, possibly in the *other* pane) while this module is mounted.
import type { Loc, Person, Team } from '../core/types'
import { t, todayIso } from '../core/i18n'
import { teamRefCandidates } from '../core/search'
import type { ModuleCtx } from '../ui/panes'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver } from '../ui/atref'
import { attachTemplatePicker } from '../ui/template-picker'
import { nowHHMM } from '../core/date'
import { el } from '../ui/dom'

const disposers = new WeakMap<HTMLElement, () => void>()

function personLabel(p: Person): string {
  return p.role ? `${p.name} — ${p.role}` : p.name
}

export function renderPersonNotes(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void {
  disposers.get(container)?.()
  disposers.delete(container)

  if (loc.ref.kind !== 'person') return // registered only for 'person'; defensive
  const { personId, group } = loc.ref
  const teamId = loc.teamId
  const lc = ctx.locale

  function findTeam(): Team | undefined {
    return ctx.store.doc.teams.find((tm) => tm.id === teamId)
  }
  function findPerson(): Person | undefined {
    return findTeam()?.[group].find((p) => p.id === personId)
  }

  function showNotFound(): void {
    container.innerHTML = ''
    container.appendChild(el('div', { class: 'tt-pane-placeholder' }, t(lc, 'toast_person_not_found')))
  }

  const person = findPerson()
  if (!person) {
    showNotFound()
    disposers.set(container, () => {})
    return
  }

  const headerEl = el('div', { class: 'tt-person-header' }, personLabel(person))

  const editor: Editor = createEditor(
    {
      onChange() {
        const md = editor.getMd()
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          const p = tm?.[group].find((pp) => pp.id === personId)
          if (!p) return
          p.notes = md.trim() === '' ? '' : md
        })
      },
      onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId),
      onAtTrigger() {},
      onSlashTrigger() {},
      resolveRefLabel: makeRefLabelResolver(ctx.store, teamId),
    },
    lc
  )
  editor.setMd(person.notes)

  const atHandle = attachAtAutocomplete(editor, { getRefCandidates: () => teamRefCandidates(findTeam()), locale: lc, onPick: () => {} })

  const tplHandle = attachTemplatePicker(editor, {
    getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'personal' || tpl.scope === 'any'),
    getCtx: () => ({
      dateIso: todayIso(),
      time: nowHHMM(),
      personName: person.name,
      teamName: findTeam()?.name,
      locale: lc,
    }),
    locale: lc,
  })

  // Unlike src/modules/daily-notes.ts's calendar-marks refresh, the notes
  // editor's *content* is deliberately never rebuilt from a live store
  // subscription (that would clobber the user's caret on every unrelated
  // change elsewhere in the doc) — the one exception is the person being
  // deleted out from under this pane (e.g. from the people tree in the other
  // split), which this module must detect and degrade to a placeholder
  // rather than keep showing/editing a ghost record.
  let torn = false
  const unsubscribe = ctx.store.subscribe(() => {
    if (torn) return
    if (findPerson()) return
    torn = true
    unsubscribe()
    atHandle.dispose()
    tplHandle.dispose()
    editor.destroy()
    showNotFound()
  })

  container.appendChild(el('div', { class: 'tt-person-notes' }, headerEl, editor.root))

  disposers.set(container, () => {
    unsubscribe()
    atHandle.dispose()
    tplHandle.dispose()
    editor.destroy()
  })
}
