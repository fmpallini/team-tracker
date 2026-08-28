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
import { openPersonModal } from '../ui/person-modal'

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
  const headerNameEl = el('span', { class: 'tt-person-header-name' })
  const headerTitleEl = el('span', { class: 'tt-person-header-title' })
  const groupLabel = t(lc, group === 'members' ? 'person_group_member' : 'person_group_stakeholder')
  // Muted second line: the person's role first (when they have one), then
  // their classification (team member / stakeholder) after a "·".
  function renderIdentity(p: Person): void {
    headerNameEl.textContent = p.name
    headerTitleEl.textContent = p.role.trim() ? `${p.role} · ${groupLabel}` : groupLabel
  }
  renderIdentity(person)

  const headerBadgeSlot = el('div', {})
  const initialChip = createBacklinksChip(initialBacklinks, lc, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
  if (initialChip) headerBadgeSlot.appendChild(initialChip)

  const editBtn = el(
    'button',
    {
      class: 'tt-btn tt-person-header-btn tt-person-header-edit-btn', type: 'button',
      title: t(lc, 'person_edit_title'),
      onclick: () => {
        const p = findPerson()
        if (!p) return
        openPersonModal(lc, {
          title: t(lc, 'person_edit_title'),
          initialName: p.name,
          initialRole: p.role,
          onSubmit: (name, role) => {
            ctx.store.update((d) => {
              const tm = d.teams.find((t2) => t2.id === teamId)
              const pp = tm?.[group].find((x) => x.id === personId)
              if (!pp) return
              pp.name = name
              pp.role = role
              // Unscoped beyond the team, exactly as people-tree.ts's rename
              // site: `name`/`role` are the label every @[…](person:id)
              // mention in this team resolves through live, so a pane showing
              // a mention of this person in another section must be free to
              // re-render.
            }, { teamId })
          },
        })
      },
    },
    '✎'
  )

  const gotoOrgBtn = el(
    'button',
    {
      class: 'tt-btn tt-person-header-btn tt-person-header-goto-org-btn', type: 'button',
      title: t(lc, 'person_notes_goto_org_title'),
      onclick: () => navigateToLoc(
        ctx.store, ctx.pm, ctx.paneIdx,
        { teamId, ref: group === 'members' ? { kind: 'members' } : { kind: 'stakeholders' } },
        { secondary: false, focusItemId: personId }
      ),
    },
    '🗺️'
  )

  const headerEl = el(
    'div',
    { class: 'tt-person-header' },
    el('div', { class: 'tt-person-header-id' }, headerNameEl, headerTitleEl),
    el('div', { class: 'tt-person-header-right' }, headerBadgeSlot, editBtn, gotoOrgBtn)
  )

  const bundle = createRichEditorBundle({
    store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
    initialMd: person.notes,
    onChange: (md) => {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        const p = tm?.[group].find((pp) => pp.id === personId)
        if (!p) return
        p.notes = md.trim() === '' ? '' : md
        // 'notes', not 'people': a person's notes are note content, same
        // bucket as daily/general notes. people-tree watches 'people' and
        // renders only name/role/hierarchy — none of it derived from notes —
        // so scoping this 'people' rebuilt the whole org tree on every
        // debounced keystroke. Backlinks to this person still refresh: every
        // chip-bearing surface watches 'notes' too.
      }, { teamId, sections: ['notes'] })
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
    // 'people' is in WATCHED, and a rename/re-title is the one edit to this
    // same record that can land from a pane other than this one (the
    // people-tree edit modal, or — now — this header's own edit button
    // committing its unscoped update) — the label has to stay live the same
    // way every @mention of this person elsewhere already does.
    renderIdentity(currentPerson)
    headerBadgeSlot.innerHTML = ''
    const chip = createBacklinksChip(ctx.searchIndex.backlinks(teamId, 'person', personId), lc, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
    if (chip) headerBadgeSlot.appendChild(chip)
    // Patches this note's own @mention chips in place — safe even mid-typing
    // (see Editor.refreshRefLabels' doc comment), unlike rebuilding the
    // editor content outright.
    editor.refreshRefLabels()
  })

  container.appendChild(el('div', { class: 'tt-person-notes' }, headerEl, editor.root))

  return () => {
    unsubscribe()
    bundle.dispose()
  }
})
