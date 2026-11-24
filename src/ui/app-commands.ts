// src/ui/app-commands.ts — what the fast switch can do besides go somewhere:
// the app's actions (some have no other mouse route: fullscreen, print) plus
// "add" for each list module. The list is data; main.ts wires each action to
// the real thing.
//
// Order is by what an action does, with no headings: create (the adds in
// pane-menu module order, then New team), go to (Due dates), this page
// (favorite, print), view (split, team list, fullscreen), app (settings,
// help, close file).
import { t, type Locale } from '../core/i18n'
import type { ModuleRef } from '../core/types'
import type { IconName } from './icons'

export interface PaletteCommand {
  id: string
  label: string
  icon: IconName
  /** The action's own key, shown at the row's right edge (not matched by the query). */
  hint?: string
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
  toggleFullscreen(): void
  toggleFavorite(): void
  print(): void
  closeFile(): void
}

export function appCommands(lc: Locale, a: AppCommandActions): PaletteCommand[] {
  return [
    { id: 'add-stakeholder', label: t(lc, 'command_add_stakeholder'), icon: 'plus', run: () => a.addItem('stakeholders') },
    { id: 'add-member', label: t(lc, 'command_add_member'), icon: 'plus', run: () => a.addItem('members') },
    { id: 'add-task', label: t(lc, 'command_add_task'), icon: 'plus', run: () => a.addItem('actions') },
    { id: 'add-milestone', label: t(lc, 'command_add_milestone'), icon: 'plus', run: () => a.addItem('milestones') },
    { id: 'add-risk', label: t(lc, 'command_add_risk'), icon: 'plus', run: () => a.addItem('risks') },
    { id: 'new-team', label: t(lc, 'team_add_title'), icon: 'plus', run: () => a.newTeam() },
    { id: 'due', label: t(lc, 'switcher_due'), icon: 'clock', run: () => a.dueDates() },
    { id: 'favorite', label: t(lc, 'command_toggle_favorite'), icon: 'star', run: () => a.toggleFavorite() },
    { id: 'print', label: t(lc, 'pane_print_title'), icon: 'print', hint: 'Ctrl+P', run: () => a.print() },
    { id: 'split', label: t(lc, 'command_toggle_split'), icon: 'split', hint: 'Alt+↑', run: () => a.toggleSplit() },
    { id: 'sidebar', label: t(lc, 'command_toggle_sidebar'), icon: 'folder', run: () => a.toggleSidebar() },
    { id: 'fullscreen', label: t(lc, 'command_toggle_fullscreen'), icon: 'fullscreen', hint: 'F11', run: () => a.toggleFullscreen() },
    { id: 'settings', label: t(lc, 'settings'), icon: 'gear', run: () => a.settings() },
    { id: 'help', label: t(lc, 'help_global_title'), icon: 'help', hint: 'F1', run: () => a.help() },
    { id: 'close-file', label: t(lc, 'command_close_file'), icon: 'lock', hint: 'Ctrl+Alt+L', run: () => a.closeFile() },
  ]
}
