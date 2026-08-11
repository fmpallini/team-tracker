// src/core/types.ts — completo, copiar literalmente
export type PaletteId = 'ledger' | 'signal' | 'blueprint' | 'forest' | 'desert' | 'cosmic' | 'synthwave' | 'verdant' | 'ember'
export interface Prefs {
  theme: 'light' | 'dark' | 'system'
  locale: 'pt-BR' | 'en-US'
  font: 'system' | 'serif' | 'mono' | 'classic' | 'rounded'
  // Five evenly-spaced steps, 12px → 18px in 1.5px increments (styles.css
  // html[data-size=…]). No schema bump / migration: the union only widened,
  // so the S/M/L a pre-existing document persisted is still a valid value.
  // Those three do land on new px values (S 14→13.5, M 16→15, L 18→16.5) —
  // an even scale over a range that now starts at 12 can't also keep the old
  // trio pinned. Accepted deliberately: everyone stays within one step of
  // where they were, and re-picking is one click in prefs.
  fontSize: 'XS' | 'S' | 'M' | 'L' | 'XL'
  autoSaveMin: number
  palette: PaletteId
  dueSoonDays: number
  openRefsInSecondaryPane: boolean
  dailyBackupEnabled: boolean
  backupHandleId: string | null
  backupFrequency: 'daily' | 'hourly'
}
export interface Person {
  id: string; name: string; role: string
  parentId: string | null; order: number; notes: string
}
export type ActionItemColor = 'slate' | 'brass' | 'sage' | 'rust' | 'plum' | 'ledger'
export interface ActionItem {
  id: string; summary: string; notes: string
  status: 'todo' | 'wip' | 'done' | 'cancelled'
  dueDate: string | null; assignee: string
  // No default: a new card starts uncategorized until the user explicitly
  // picks a color, and an existing one can be unset back to null (see
  // src/modules/action-items.ts's openEditModal color-chip toggle).
  color: ActionItemColor | null
  order: number
}
export interface Milestone { id: string; date: string; title: string; done: boolean; followup: string }
export type RiskPlan = 'mitigate' | 'transfer' | 'eliminate' | 'accept'
export interface Risk {
  id: string; title: string; chance: 1 | 2 | 3; impact: 1 | 2 | 3
  plan: RiskPlan; followup: string; order: number
  closed: boolean
}
export interface Team {
  id: string; name: string; emoji: string
  stakeholders: Person[]; members: Person[]
  actionItems: ActionItem[]; milestones: Milestone[]; risks: Risk[]
  dailyNotes: Record<string, string>
  actionTagNames?: Partial<Record<ActionItemColor, string>>
  generalNotes?: string
}
export interface Template {
  id: string; name: string
  scope: 'personal' | 'daily' | 'any'; body: string
}
export type ModuleRef =
  | { kind: 'daily'; date: string }
  | { kind: 'general' }
  | { kind: 'person'; personId: string; group: 'stakeholders' | 'members' }
  | { kind: 'stakeholders' } | { kind: 'members' }
  | { kind: 'actions'; itemId?: string } | { kind: 'milestones'; itemId?: string } | { kind: 'risks'; itemId?: string }
export interface Loc { teamId: string; ref: ModuleRef }
export interface PaneState { history: Loc[]; index: number } // current = history[index]; index -1 = vazio
export interface NavState {
  activeTeamId: string | null; split: boolean
  panes: [PaneState, PaneState]; focusedPane: 0 | 1
  /** Remembers, per team, whether its last session used split view — restored on switching back to that team. */
  teamSplit: Record<string, boolean>
  /** Manual sidebar collapse — a global layout choice (not per-team), toggled from the sidebar's own collapse button. */
  sidebarCollapsed: boolean
}
export interface Doc {
  schemaVersion: number; prefs: Prefs; templates: Template[]
  nav: NavState; teams: Team[]
}
