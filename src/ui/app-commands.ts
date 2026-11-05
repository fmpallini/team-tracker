// src/ui/app-commands.ts — what the fast switch can do besides go somewhere:
// the app's actions that have no hotkey of their own (F1 is a module, so Help
// and Settings have none) plus "add" for each list module. The list is data;
// main.ts wires each action to the real thing.
import { t, type Locale } from '../core/i18n'
import type { ModuleRef } from '../core/types'
import type { IconName } from './icons'

export interface PaletteCommand {
  id: string
  label: string
  icon: IconName
  run(): void
}

export type AddItemKind = Extract<ModuleRef['kind'], 'actions' | 'risks' | 'milestones' | 'members' | 'stakeholders'>

export interface AppCommandActions {
  settings(): void
  help(): void
  dueDates(): void
  newTeam(): void
  /** Opens `kind` in the focused pane and adds an item to it. */
  addItem(kind: AddItemKind): void
  toggleSidebar(): void
  toggleSplit(): void
  toggleFavorite(): void
  print(): void
  closeFile(): void
}

export function appCommands(lc: Locale, a: AppCommandActions): PaletteCommand[] {
  return [
    { id: 'add-task', label: t(lc, 'command_add_task'), icon: 'plus', run: () => a.addItem('actions') },
    { id: 'add-risk', label: t(lc, 'command_add_risk'), icon: 'plus', run: () => a.addItem('risks') },
    { id: 'add-milestone', label: t(lc, 'command_add_milestone'), icon: 'plus', run: () => a.addItem('milestones') },
    { id: 'add-member', label: t(lc, 'command_add_member'), icon: 'plus', run: () => a.addItem('members') },
    { id: 'add-stakeholder', label: t(lc, 'command_add_stakeholder'), icon: 'plus', run: () => a.addItem('stakeholders') },
    { id: 'new-team', label: t(lc, 'team_add_title'), icon: 'plus', run: () => a.newTeam() },
    { id: 'due', label: t(lc, 'due_panel_title'), icon: 'clock', run: () => a.dueDates() },
    { id: 'favorite', label: t(lc, 'command_toggle_favorite'), icon: 'star', run: () => a.toggleFavorite() },
    { id: 'split', label: t(lc, 'command_toggle_split'), icon: 'split', run: () => a.toggleSplit() },
    { id: 'sidebar', label: t(lc, 'command_toggle_sidebar'), icon: 'folder', run: () => a.toggleSidebar() },
    { id: 'print', label: t(lc, 'pane_print_title'), icon: 'print', run: () => a.print() },
    { id: 'settings', label: t(lc, 'settings'), icon: 'gear', run: () => a.settings() },
    { id: 'help', label: t(lc, 'help_global_title'), icon: 'help', run: () => a.help() },
    { id: 'close-file', label: t(lc, 'close_file_title'), icon: 'lock', run: () => a.closeFile() },
  ]
}
