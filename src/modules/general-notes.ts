// src/modules/general-notes.ts — free-text notes for the team as a whole,
// not tied to any date or person. Simplest of the note-bearing modules:
// unlike src/modules/person-notes.ts, there's no underlying record that can
// be deleted out from under an open pane (a team itself disappearing is
// handled upstream by navigation away, the same as action-items.ts/
// milestones.ts/risks.ts rely on for team deletion), so no "not found"
// placeholder or live-deletion guard is needed here.
import type { Loc, Team } from '../core/types'
import type { ModuleCtx } from '../ui/panes'
import { createModuleEditor } from '../ui/rich-editor'
import { findTeam as docFindTeam } from '../core/document'
import { withDisposal } from './lifecycle'

export const renderGeneralNotes = withDisposal((container: HTMLElement, loc: Loc, ctx: ModuleCtx) => {
  if (loc.ref.kind !== 'general') return // registered only for 'general'; defensive
  const teamId = loc.teamId

  function findTeam(): Team | undefined {
    return docFindTeam(ctx.store.doc, teamId)
  }

  const bundle = createModuleEditor(ctx, teamId, {
    initialMd: findTeam()?.generalNotes ?? '',
    templateScopes: ['any'],
    onChange: (md) => {
      ctx.store.update((d) => {
        const tm = docFindTeam(d, teamId)
        if (tm) tm.generalNotes = md
      }, { teamId, sections: ['notes'] })
    },
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
