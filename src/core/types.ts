// src/core/types.ts — completo, copiar literalmente
export interface Prefs {
  theme: 'light' | 'dark' | 'system'
  locale: 'pt-BR' | 'en-US'
  font: 'system' | 'serif' | 'mono'
  fontSize: 'S' | 'M' | 'L'
  autoSaveMin: number
}
export interface Person {
  id: string; name: string; role: string
  parentId: string | null; order: number; notes: string
}
export interface ActionItem {
  id: string; text: string; done: boolean
  dueDate: string | null; assignee: string; order: number
  notes: string
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
}
export interface Template {
  id: string; name: string
  scope: 'personal' | 'daily' | 'any'; body: string
}
export type ModuleRef =
  | { kind: 'daily'; date: string }
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
}
export interface Doc {
  schemaVersion: number; prefs: Prefs; templates: Template[]
  nav: NavState; teams: Team[]
}
