// src/core/card-transfer.ts — pure duplicate/copy/move helpers for action
// items, milestones and risks, backing the cards' right-click context menu
// (src/modules/action-items.ts, risks.ts, milestones.ts). Same-team
// duplicate keeps @ref mentions live (they still resolve); cross-team
// transfer strips them to plain text via stripAllRefs, since a mention's id
// only means something inside the team it was written in.
import type { Team } from './types'
import { stripAllRefs } from './refs'

export function duplicateActionItem(team: Team, itemId: string): void {
  const src = team.actionItems.find((i) => i.id === itemId)
  if (!src) return
  team.actionItems.push({ ...src, id: crypto.randomUUID(), order: team.actionItems.length })
}

export function duplicateMilestone(team: Team, itemId: string): void {
  const src = team.milestones.find((i) => i.id === itemId)
  if (!src) return
  team.milestones.push({ ...src, id: crypto.randomUUID() })
}

export function duplicateRisk(team: Team, itemId: string): void {
  const src = team.risks.find((i) => i.id === itemId)
  if (!src) return
  team.risks.push({ ...src, id: crypto.randomUUID(), order: team.risks.length })
}

export function transferActionItem(
  teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'
): void {
  const from = teams.find((t) => t.id === fromTeamId)
  const to = teams.find((t) => t.id === toTeamId)
  if (!from || !to) return
  const src = from.actionItems.find((i) => i.id === itemId)
  if (!src) return
  to.actionItems.push({ ...src, id: crypto.randomUUID(), order: to.actionItems.length, notes: stripAllRefs(src.notes) })
  if (mode === 'move') from.actionItems = from.actionItems.filter((i) => i.id !== itemId)
}

export function transferMilestone(
  teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'
): void {
  const from = teams.find((t) => t.id === fromTeamId)
  const to = teams.find((t) => t.id === toTeamId)
  if (!from || !to) return
  const src = from.milestones.find((i) => i.id === itemId)
  if (!src) return
  to.milestones.push({ ...src, id: crypto.randomUUID(), followup: stripAllRefs(src.followup) })
  if (mode === 'move') from.milestones = from.milestones.filter((i) => i.id !== itemId)
}

export function transferRisk(
  teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'
): void {
  const from = teams.find((t) => t.id === fromTeamId)
  const to = teams.find((t) => t.id === toTeamId)
  if (!from || !to) return
  const src = from.risks.find((i) => i.id === itemId)
  if (!src) return
  to.risks.push({ ...src, id: crypto.randomUUID(), order: to.risks.length, followup: stripAllRefs(src.followup) })
  if (mode === 'move') from.risks = from.risks.filter((i) => i.id !== itemId)
}
