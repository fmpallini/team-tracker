// src/ui/rich-editor.ts — the editor + @ref autocomplete + '/' template picker
// bundle every module that hosts free-text notes wires up identically
// (daily notes, person notes, action-item notes, milestone/risk follow-ups).
// Each caller differs only in where onChange persists and which templates/
// context apply — everything else (ref-click nav, ref-label resolution,
// dropdown wiring, teardown order) is exactly the same across all five.
// Module renderers use `createModuleEditor`; `createRichEditorBundle` is the
// low-level primitive it wraps.
import { todayIso, type Locale } from '../core/i18n'
import type { Store } from '../core/store'
import type { PaneManager, ModuleCtx } from './panes'
import type { Team, Template } from '../core/types'
import type { TemplateCtx } from '../core/templates'
import { findTeam } from '../core/document'
import { nowHHMM } from '../core/date'
import { teamRefCandidates } from '../core/search'
import { createEditor, type Editor } from './editor'
import { attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver } from './atref'
import { attachTemplatePicker } from './template-picker'

export interface RichEditorBundle {
  editor: Editor
  /** Tears down the @ref dropdown, template-picker dropdown, and the editor itself, in that order. Idempotent-safe to call once per bundle. */
  dispose(): void
}

export function createRichEditorBundle(opts: {
  store: Store
  pm: PaneManager
  paneIdx: 0 | 1
  locale: Locale
  teamId: string
  initialMd: string
  onChange(md: string): void
  getTeam(): Team | undefined
  getTemplates(): Template[]
  getTemplateCtx(): TemplateCtx
}): RichEditorBundle {
  const editor: Editor = createEditor(
    {
      onChange() {
        opts.onChange(editor.getMd())
      },
      onRefClick: makeRefClickHandler(opts.store, opts.pm, opts.paneIdx, opts.locale, opts.teamId),
      onAtTrigger() {},
      onSlashTrigger() {},
      resolveRefLabel: makeRefLabelResolver(opts.store, opts.teamId),
    },
    opts.locale
  )
  editor.setMd(opts.initialMd)

  const atHandle = attachAtAutocomplete(editor, {
    getRefCandidates: () => teamRefCandidates(opts.getTeam()),
    locale: opts.locale,
    onPick: () => {},
  })
  const tplHandle = attachTemplatePicker(editor, {
    getTemplates: () => opts.getTemplates(),
    getCtx: () => opts.getTemplateCtx(),
    locale: opts.locale,
  })

  return {
    editor,
    dispose(): void {
      atHandle.dispose()
      tplHandle.dispose()
      editor.destroy()
    },
  }
}

/**
 * createRichEditorBundle the way every module renderer wants it: wired from
 * its ModuleCtx, offering `templateScopes`, filling the template context live
 * (team name, person, today or the note's own day), and collapsing a
 * whitespace-only body to '' (how every note field stores "empty").
 */
export function createModuleEditor(ctx: ModuleCtx, teamId: string, opts: {
  initialMd: string
  /** Receives the markdown with a whitespace-only body collapsed to ''. */
  onChange(md: string): void
  templateScopes: readonly Template['scope'][]
  /** The template `{date}`; defaults to today. Daily notes pass the note's own day. */
  templateDate?: () => string
  /** The template `{person}`; read live, so a rename is picked up. */
  personName?: () => string | undefined
}): RichEditorBundle {
  const team = (): Team | undefined => findTeam(ctx.store.doc, teamId)
  return createRichEditorBundle({
    store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: ctx.locale, teamId,
    initialMd: opts.initialMd,
    onChange: (md) => opts.onChange(md.trim() === '' ? '' : md),
    getTeam: team,
    getTemplates: () => ctx.store.doc.templates.filter((tpl) => opts.templateScopes.includes(tpl.scope)),
    getTemplateCtx: () => ({
      dateIso: opts.templateDate?.() ?? todayIso(),
      time: nowHHMM(ctx.locale),
      teamName: team()?.name,
      ...(opts.personName ? { personName: opts.personName() } : {}),
      locale: ctx.locale,
    }),
  })
}
