// src/modules/person-notes.ts — Task 19: notes editor for a single person
// (stakeholder or member). Mirrors src/modules/daily-notes.ts's editor +
// atref + template-picker wiring, but persists into `person.notes` and
// additionally has to cope with the person being deleted (from the people
// tree, possibly in the *other* pane) while this module is mounted.
import type { Loc, Person, Team } from '../core/types'
import { t, todayIso } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { createRichEditorBundle } from '../ui/rich-editor'
import { nowHHMM } from '../core/date'
import { findTeam as docFindTeam } from '../core/document'
import { scopeAffects, type Section } from '../core/scope'
import { el } from '../ui/dom'
import { withDisposal } from './lifecycle'
import { BACKLINK_SECTIONS } from '../core/search'
import { createBacklinksChip } from '../ui/backlinks-panel'
import { navigateToLoc } from '../ui/atref'

function personLabel(p: Person): string {
  return p.role ? `${p.name} — ${p.role}` : p.name
}

export const renderPersonNotes = withDisposal((container: HTMLElement, loc: Loc, ctx: ModuleCtx) => {
  if (loc.ref.kind !== 'person') return // registered only for 'person'; defensive
  const { personId, group } = loc.ref
  const teamId = loc.teamId
  const lc = ctx.locale

  function findTeam(): Team | undefined {
    return docFindTeam(ctx.store.doc, teamId)
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
    return
  }

  const initialBacklinks = ctx.searchIndex.backlinks(teamId, 'person', personId)
  const headerLabelEl = el('span', {}, personLabel(person))
  const headerBadgeSlot = el('div', {})
  const initialChip = createBacklinksChip(initialBacklinks, lc, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
  if (initialChip) headerBadgeSlot.appendChild(initialChip)
  const headerEl = el('div', { class: 'tt-person-header' }, headerLabelEl, headerBadgeSlot)

  const bundle = createRichEditorBundle({
    store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
    initialMd: person.notes,
    onChange: (md) => {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        const p = tm?.[group].find((pp) => pp.id === personId)
        if (!p) return
        p.notes = md.trim() === '' ? '' : md
      }, { teamId, sections: ['people', 'notes'] })
    },
    getTeam: () => findTeam(),
    getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'personal' || tpl.scope === 'any'),
    getTemplateCtx: () => ({ dateIso: todayIso(), time: nowHHMM(lc), personName: person.name, teamName: findTeam()?.name, locale: lc }),
  })
  const editor = bundle.editor

  // Unlike src/modules/daily-notes.ts's calendar-marks refresh, the notes
  // editor's *content* is deliberately never rebuilt from a live store
  // subscription (that would clobber the user's caret on every unrelated
  // change elsewhere in the doc) — the one exception is the person being
  // deleted out from under this pane (e.g. from the people tree in the other
  // split), which this module must detect and degrade to a placeholder
  // rather than keep showing/editing a ghost record.
  let torn = false
  // This person's backlinks chip must react to a mention of them
  // appearing/disappearing anywhere BACKLINK_SECTIONS covers — a daily
  // note, another person's notes, an action item, milestone or risk
  // follow-up — not just edits to people themselves, so the watch list is
  // that full set (plus 'teams', for the person-deleted-out-from-under-us
  // check above).
  const WATCHED: readonly Section[] = ['teams', ...BACKLINK_SECTIONS]
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    if (torn) return
    const currentPerson = findPerson()
    if (!currentPerson) {
      torn = true
      unsubscribe()
      bundle.dispose()
      showNotFound()
      return
    }
    // 'people' is in WATCHED, and a rename is the one edit to this same
    // record that can land from a pane other than this one (the people-tree
    // edit modal) — the label has to stay live the same way every @mention
    // of this person elsewhere already does.
    headerLabelEl.textContent = personLabel(currentPerson)
    headerBadgeSlot.innerHTML = ''
    const chip = createBacklinksChip(ctx.searchIndex.backlinks(teamId, 'person', personId), lc, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
    if (chip) headerBadgeSlot.appendChild(chip)
  })

  container.appendChild(el('div', { class: 'tt-person-notes' }, headerEl, editor.root))

  return () => {
    unsubscribe()
    bundle.dispose()
  }
})
