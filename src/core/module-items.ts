// src/core/module-items.ts — the "jump to" row list shared by the pane module
// dropdown (ui/panes.ts) and the fast switch (core/switcher.ts), plus the
// title a Loc shows in a pane bar or favorite row. Lives in core/ (not
// ui/panes.ts) so the switcher can build rows for every team without core/
// importing from ui/. No DOM.
import type { Doc, Loc, ModuleRef, Team } from './types'
import { findTeam } from './document'
import { t, todayIso, formatDateWithWeekday, type Locale, type MsgKey } from './i18n'
import { KIND_ICON, normalize, teamRefCandidates } from './search'

/** Same item list feeds both the pane module dropdown and the Ctrl+Shift+K fast switch. */
export interface ModuleItem {
  label: string
  ref: ModuleRef
}

export const FIXED_MODULE_KEYS: { kind: 'stakeholders' | 'members' | 'actions' | 'milestones' | 'risks'; key: MsgKey }[] = [
  { kind: 'stakeholders', key: 'module_stakeholders' },
  { kind: 'members', key: 'module_members' },
  { kind: 'actions', key: 'module_actions' },
  { kind: 'milestones', key: 'module_milestones' },
  { kind: 'risks', key: 'module_risks' },
]

/** Pure and exported so it can be unit-tested without touching the DOM. */
export function filterModuleItems<T extends { label: string }>(items: T[], query: string): T[] {
  const q = normalize(query.trim())
  if (!q) return items
  return items.filter((item) => normalize(item.label).includes(q))
}

export function buildModuleItems(team: Team | null, locale: Locale): ModuleItem[] {
  const items: ModuleItem[] = [
    { label: `${KIND_ICON.daily} ${t(locale, 'module_daily')}`, ref: { kind: 'daily', date: todayIso() } },
    { label: `${KIND_ICON.general} ${t(locale, 'module_general_notes')}`, ref: { kind: 'general' } },
  ]
  if (team) {
    for (const group of ['stakeholders', 'members'] as const) {
      for (const person of team[group]) {
        items.push({ label: `${KIND_ICON.person} ${person.name}`, ref: { kind: 'person', personId: person.id, group } })
      }
    }
  }
  const cands = team ? teamRefCandidates(team) : null
  for (const { kind, key } of FIXED_MODULE_KEYS) {
    items.push({ label: `${KIND_ICON[kind]} ${t(locale, key)}`, ref: { kind } })
    if (!cands || kind === 'stakeholders' || kind === 'members') continue
    const list = { actions: cands.actionItems, milestones: cands.milestones, risks: cands.risks }[kind]
    for (const c of list) items.push({ label: `${KIND_ICON[kind]} ${c.title}`, ref: { kind, itemId: c.id } })
  }
  return items
}

export function titleFor(doc: Doc, loc: Loc, locale: Locale): string {
  switch (loc.ref.kind) {
    case 'daily':
      return `${t(locale, 'module_daily')} · ${formatDateWithWeekday(loc.ref.date, locale)}`
    case 'general':
      return t(locale, 'module_general_notes')
    case 'person': {
      // `loc.ref` is narrowed to the 'person' variant here by the switch, but
      // that narrowing does not survive into the .find() callback below (TS
      // can't prove the property access is stable across a closure) — so we
      // capture the narrowed ref in a local const first.
      const ref = loc.ref
      const team = findTeam(doc, loc.teamId)
      const person = team?.[ref.group].find((p) => p.id === ref.personId)
      return person ? person.name : t(locale, 'module_person')
    }
    case 'stakeholders':
      return t(locale, 'module_stakeholders')
    case 'members':
      return t(locale, 'module_members')
    case 'actions':
      return t(locale, 'module_actions')
    case 'milestones':
      return t(locale, 'module_milestones')
    case 'risks':
      return t(locale, 'module_risks')
  }
}
