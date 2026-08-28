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
import { withDisposal } from './lifecycle'

export const renderGeneralNotes = withDisposal((container: HTMLElement, loc: Loc, ctx: ModuleCtx) => {
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
      }, { teamId, sections: ['notes'] })
    },
    getTeam: () => findTeam(),
    getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
    getTemplateCtx: () => ({ dateIso: todayIso(), time: nowHHMM(lc), teamName: findTeam()?.name, locale: lc }),
  })
  const editor = bundle.editor

  container.appendChild(editor.root)
  // Only for the pane the user is actually in — a team switch remounts both
  // panes together, and without this guard whichever pane mounts second
  // would silently steal focus from the other (same guard action-items.ts's
  // kanban-card mount focus uses).
  if (ctx.paneIdx === ctx.store.doc.nav.focusedPane) {
    editor.focus()
  }

  return () => {
    bundle.dispose()
  }
})
