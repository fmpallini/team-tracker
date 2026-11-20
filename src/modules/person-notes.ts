// src/modules/person-notes.ts — notes editor for a single person
// (stakeholder or member). Mirrors src/modules/daily-notes.ts's editor +
// atref + template-picker wiring, but persists into `person.notes` and
// additionally has to cope with the person being deleted (from the people
// tree, possibly in the *other* pane) while this module is mounted.
import type { Loc, Person, Team } from '../core/types'
import { t, todayIso } from '../core/i18n'
import { focusPaneBar, NEW_ONE_ON_ONE_EVENT, type ModuleCtx } from '../ui/panes'
import { createModuleEditor } from '../ui/rich-editor'
import { findTeam as docFindTeam } from '../core/document'
import { scopeAffects, type Section } from '../core/scope'
import { el } from '../ui/dom'
import { withDisposal } from './lifecycle'
import { BACKLINK_SECTIONS } from '../core/search'
import { createModuleBacklinksChip } from '../ui/backlinks-panel'
import { navigateToLoc } from '../ui/atref'
import { applyCadence, openPersonModal, personOneOnOne } from '../ui/person-modal'
import { iconButton } from '../ui/icons'
import { watchDayChange } from '../ui/day-change'
import { buildOneOnOne } from '../core/one-on-one'
import { effectiveCadenceDays, isIsoDate, oneOnOneOverdueDays } from '../core/cadence'
import { diffDays } from '../core/date'
import { isOneOnOneCandidate } from '../core/templates'

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

  const headerTitleEl = el('span', { class: 'tt-person-header-title' })
  const groupLabel = t(lc, group === 'members' ? 'person_group_member' : 'person_group_stakeholder')
  // The person's name is deliberately not repeated here: the pane bar above
  // already shows it (core/module-items.ts's titleFor) and keeps it live on rename.
  // This line is the role first (when they have one), then their
  // classification (team member / stakeholder) after a "·".
  function renderIdentity(p: Person): void {
    headerTitleEl.textContent = p.role.trim() ? `${p.role} · ${groupLabel}` : groupLabel
  }
  renderIdentity(person)

  const headerBadgeSlot = el('div', {})
  const initialChip = createModuleBacklinksChip(ctx, teamId, 'person', personId)
  if (initialChip) headerBadgeSlot.appendChild(initialChip)

  // The header's edit button and the 1:1 status line both open this.
  function openEdit(): void {
    const p = findPerson()
    if (!p) return
    openPersonModal(lc, {
      title: t(lc, 'person_edit_title'),
      initialName: p.name,
      initialRole: p.role,
      oneOnOne: personOneOnOne(p, group, ctx.store.doc.prefs),
      onSubmit: (name, role, cadence) => {
        ctx.store.update((d) => {
          const tm = docFindTeam(d, teamId)
          const pp = tm?.[group].find((x) => x.id === personId)
          if (!pp) return
          pp.name = name
          pp.role = role
          applyCadence(pp, cadence)
          // Unscoped beyond the team, exactly as people-tree.ts's rename
          // site: `name`/`role` are the label every @[…](person:id)
          // mention in this team resolves through live, so a pane showing
          // a mention of this person in another section must be free to
          // re-render.
        }, { teamId })
      },
    })
  }

  const editBtn = iconButton({
    class: 'tt-person-header-btn tt-person-header-edit-btn',
    title: t(lc, 'person_edit_title'), icon: 'edit',
    onclick: openEdit,
  })

  // A labelled button, like "+ Person": the 1:1 is this page's main action.
  const oneOnOneBtn = el(
    'button',
    { class: 'tt-btn tt-person-header-one-on-one-btn', type: 'button', title: t(lc, 'person_new_one_on_one_title'), onclick: () => newOneOnOne() },
    t(lc, 'person_new_one_on_one_btn')
  )

  // "Last 1:1: 3 days ago" over "Every 14 days", red once the next one is late.
  // Plain text: the edit button beside it opens the same dialog.
  const cadenceEl = el('span', { class: 'tt-person-cadence' })
  function renderCadence(p: Person): void {
    const prefs = ctx.store.doc.prefs
    const today = todayIso()
    // An unreadable date (hand-edited plain file) reads as no 1:1, as core/cadence.ts treats it.
    const last = isIsoDate(p.lastOneOnOne) ? p.lastOneOnOne : null
    const ago = last === null ? 0 : diffDays(today, last)
    const lastText = last === null
      ? t(lc, 'person_no_one_on_one')
      : t(lc, 'person_last_one_on_one', {
        ago: ago <= 0 ? t(lc, 'person_ago_today') : t(lc, ago === 1 ? 'person_days_ago_one' : 'person_days_ago', { days: String(ago) }),
      })
    // Two lines: when the last 1:1 was, then the cadence (none set, no second line).
    const every = effectiveCadenceDays(p, group, prefs)
    cadenceEl.replaceChildren(
      el('span', {}, lastText),
      ...(every === null ? [] : [el('span', {}, t(lc, every === 1 ? 'person_cadence_every_one' : 'person_cadence_every', { days: String(every) }))])
    )
    cadenceEl.classList.toggle('overdue', oneOnOneOverdueDays(p, group, prefs, today) !== null)
  }
  renderCadence(person)

  const gotoOrgBtn = iconButton({
    class: 'tt-person-header-btn tt-person-header-goto-org-btn',
    title: t(lc, 'person_notes_goto_org_title'), icon: 'orgchart',
    onclick: () => navigateToLoc(
      ctx.store, ctx.pm, ctx.paneIdx,
      { teamId, ref: group === 'members' ? { kind: 'members' } : { kind: 'stakeholders' } },
      { secondary: false, focusItemId: personId }
    ),
  })

  const headerEl = el(
    'div',
    { class: 'tt-person-header' },
    el('div', { class: 'tt-person-header-id' }, headerTitleEl),
    // The 1:1 status and its button read as one group on the right.
    el('div', { class: 'tt-person-header-right' }, headerBadgeSlot, cadenceEl, oneOnOneBtn, editBtn, gotoOrgBtn)
  )

  const bundle = createModuleEditor(ctx, teamId, {
    initialMd: person.notes,
    // Person notes are for the person: Shared templates (scope 'any': Meeting, Decision, …) belong to the shared notes and items.
    templateScopes: ['personal'],
    personName: () => findPerson()?.name,
    onEscape: () => focusPaneBar(container),
    onChange: (md) => {
      ctx.store.update((d) => {
        const tm = docFindTeam(d, teamId)
        const p = tm?.[group].find((pp) => pp.id === personId)
        if (!p) return
        p.notes = md
        // 'notes', not 'people': a person's notes are note content, same
        // bucket as daily/general notes. people-tree watches 'people' and
        // renders only name/role/hierarchy — none of it derived from notes —
        // so scoping this 'people' rebuilt the whole org tree on every
        // debounced keystroke. Backlinks to this person still refresh: every
        // chip-bearing surface watches 'notes' too.
      }, { teamId, sections: ['notes'] })
    },
  })
  const editor = bundle.editor

  // Unlike src/modules/daily-notes.ts's calendar-marks refresh, the notes
  // editor's *content* is deliberately never rebuilt from a live store
  // subscription (that would clobber the user's caret on every unrelated
  // change elsewhere in the doc) — the one exception is the person being
  // deleted out from under this pane (e.g. from the people tree in the other
  // split), which this module must detect and degrade to a placeholder
  // rather than keep showing/editing a ghost record.
  // `torn` and `stopDayWatch` are declared ahead of the New 1:1 listener and
  // the store subscription that read them, so neither can hit them uninitialised.
  let torn = false
  // "3 days ago" and the overdue colour are relative to today, which moves
  // with no store change while the pane sits open overnight.
  const stopDayWatch = watchDayChange(() => {
    const p = findPerson()
    if (!torn && p) renderCadence(p)
  })

  /**
   * The New 1:1 (button, Alt+O): every open task is carried into a fresh block
   * appended after a rule, and marked carried where it was. The edit goes
   * through the open editor as one undo step (replaceMd), never by rewriting
   * `person.notes` under it, so the caret and the undo history survive; the
   * editor's own onChange persists the note. Only the date of the 1:1 is
   * written to the store directly, and an undo of the note leaves it: the
   * meeting still happened.
   */
  function newOneOnOne(): void {
    // A read-only tab (core/tab-lock.ts sets this together with setEditorsReadOnly): replaceMd would refuse anyway.
    if (torn || ctx.store.readOnly) return
    const doc = ctx.store.doc
    // A chosen template re-scoped to daily is treated as missing (heading only), as Preferences shows it.
    const body = doc.templates.find((tpl) => tpl.id === doc.prefs.oneOnOneTemplateId && isOneOnOneCandidate(tpl))?.body ?? null
    const r = buildOneOnOne(editor.getMd(), body, bundle.templateCtx())
    editor.replaceMd(r.md, (root) => oneOnOneCaret(root, r.blockHrFromEnd))
    ctx.store.update((d) => {
      const p = docFindTeam(d, teamId)?.[group].find((pp) => pp.id === personId)
      if (p) p.lastOneOnOne = todayIso()
    }, { teamId, sections: ['people'] })
  }
  container.addEventListener(NEW_ONE_ON_ONE_EVENT, newOneOnOne)

  // This person's backlinks chip must react to a mention of them
  // appearing/disappearing anywhere BACKLINK_SECTIONS covers — a daily
  // note, another person's notes, an action item, milestone or risk
  // follow-up — not just edits to people themselves, so the watch list is
  // that full set (plus 'teams', for the person-deleted-out-from-under-us
  // check above). 'prefs' too: the members' default 1:1 cadence lives there,
  // and the status line shows it.
  const WATCHED: readonly Section[] = ['teams', 'prefs', ...BACKLINK_SECTIONS]
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    if (torn) return
    const currentPerson = findPerson()
    if (!currentPerson) {
      torn = true
      unsubscribe()
      stopDayWatch()
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
    // 'people' also carries lastOneOnOne / oneOnOneEveryDays.
    renderCadence(currentPerson)
    headerBadgeSlot.innerHTML = ''
    const chip = createModuleBacklinksChip(ctx, teamId, 'person', personId)
    if (chip) headerBadgeSlot.appendChild(chip)
    // Patches this note's own @mention chips in place — safe even mid-typing
    // (see Editor.refreshRefLabels' doc comment), unlike rebuilding the
    // editor content outright.
    editor.refreshRefLabels()
  })

  container.appendChild(el('div', { class: 'tt-person-notes' }, headerEl, editor.root))
  // Only for the pane the user is actually in, same guard as daily-notes.ts.
  if (ctx.paneIdx === ctx.store.doc.nav.focusedPane) {
    editor.focus()
  }

  return () => {
    unsubscribe()
    stopDayWatch()
    container.removeEventListener(NEW_ONE_ON_ONE_EVENT, newOneOnOne)
    bundle.dispose()
  }
})

/**
 * Where the caret goes after a New 1:1: the first empty bullet of the new
 * block (the template's first "- " slot), else null, so replaceMd puts it at
 * the end of the note (typing then appends, never prepends to a carried item
 * or heading). The block starts right after the (blockHrFromEnd + 1)-th rule
 * from the end (the rule
 * buildOneOnOne put before it, counting past the block's own rules), or is the
 * whole note when that was empty (null). A carried item is never blank, but is
 * skipped by state as well: it is an earlier task, not a slot to type in.
 */
function oneOnOneCaret(root: HTMLElement, blockHrFromEnd: number | null): Node | null {
  const blocks = Array.from(root.children)
  let from = 0
  if (blockHrFromEnd !== null) {
    from = blocks.length // no such rule: no slot to look for
    let seen = 0
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]!.tagName === 'HR' && ++seen === blockHrFromEnd + 1) {
        from = i + 1
        break
      }
    }
  }
  for (const block of blocks.slice(from)) {
    const slot = Array.from(block.querySelectorAll('li')).find((li) => !li.textContent?.trim() && li.getAttribute('data-task') !== 'carried')
    if (slot) return slot
  }
  return null
}
