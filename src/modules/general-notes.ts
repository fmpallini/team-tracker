// src/modules/general-notes.ts — free-text notes for the team as a whole,
// not tied to any date or person. Simplest of the note-bearing modules:
// unlike src/modules/person-notes.ts, there's no underlying record that can
// be deleted out from under an open pane (a team itself disappearing is
// handled upstream by navigation away, the same as action-items.ts/
// milestones.ts/risks.ts rely on for team deletion), so no "not found"
// placeholder or live-deletion guard is needed here.
import type { Loc, Team } from '../core/types'
import { todayIso } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { createRichEditorBundle } from '../ui/rich-editor'
import { nowHHMM } from '../core/date'
import { findTeam as docFindTeam } from '../core/document'

const disposers = new WeakMap<HTMLElement, () => void>()

export function renderGeneralNotes(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void {
  disposers.get(container)?.()
  disposers.delete(container)

  if (loc.ref.kind !== 'general') return // registered only for 'general'; defensive
  const teamId = loc.teamId
  const lc = ctx.locale

  function findTeam(): Team | undefined {
    return docFindTeam(ctx.store.doc, teamId)
  }

  const bundle = createRichEditorBundle({
    store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
    initialMd: findTeam()?.generalNotes ?? '',
    onChange: (md) => {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm) return
        tm.generalNotes = md.trim() === '' ? '' : md
      })
    },
    getTeam: () => findTeam(),
    getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
    getTemplateCtx: () => ({ dateIso: todayIso(), time: nowHHMM(lc), teamName: findTeam()?.name, locale: lc }),
  })
  const editor = bundle.editor

  container.appendChild(editor.root)

  disposers.set(container, () => {
    bundle.dispose()
  })
}
