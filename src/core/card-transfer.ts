// src/core/card-transfer.ts — pure duplicate/copy/move helpers for action
// items, milestones and risks, backing the cards' right-click context menu
// (src/modules/action-items.ts, risks.ts, milestones.ts). Same-team
// duplicate keeps @ref mentions live (they still resolve); cross-team
// transfer strips them to plain text via stripAllRefs, since a mention's id
// only means something inside the team it was written in.
import type { Team } from './types'
import { stripAllRefs, unlinkRefsInTeam, type IdRefKind } from './refs'

function duplicateInList<T extends { id: string }>(list: T[], itemId: string): T | null {
  const src = list.find((i) => i.id === itemId)
  if (!src) return null
  const copy: T = { ...src, id: crypto.randomUUID() }
  list.push(copy)
  return copy
}

export function duplicateActionItem(team: Team, itemId: string): void {
  const copy = duplicateInList(team.actionItems, itemId)
  if (copy) copy.order = team.actionItems.length - 1
}

export function duplicateMilestone(team: Team, itemId: string): void {
  duplicateInList(team.milestones, itemId)
}

export function duplicateRisk(team: Team, itemId: string): void {
  const copy = duplicateInList(team.risks, itemId)
  if (copy) copy.order = team.risks.length - 1
}

function transferInList<T extends { id: string }>(
  from: Team,
  to: Team,
  itemId: string,
  mode: 'copy' | 'move',
  getList: (t: Team) => T[],
  setList: (t: Team, list: T[]) => void
): T | null {
  const list = getList(from)
  const src = list.find((i) => i.id === itemId)
  if (!src) return null
  const copy: T = { ...src, id: crypto.randomUUID() }
  getList(to).push(copy)
  if (mode === 'move') setList(from, list.filter((i) => i.id !== itemId))
  return copy
}

function transferBetweenTeams<T extends { id: string }>(
  teams: Team[],
  itemId: string,
  fromTeamId: string,
  toTeamId: string,
  mode: 'copy' | 'move',
  kind: IdRefKind,
  getList: (t: Team) => T[],
  setList: (t: Team, list: T[]) => void,
  finish: (to: Team, copy: T) => void
): void {
  const from = teams.find((t) => t.id === fromTeamId)
  const to = teams.find((t) => t.id === toTeamId)
  if (!from || !to) return
  const copy = transferInList(from, to, itemId, mode, getList, setList)
  if (!copy) return
  finish(to, copy)
  if (mode === 'move') unlinkRefsInTeam(from, kind, [itemId])
}

export function transferActionItem(
  teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'
): void {
  transferBetweenTeams(
    teams, itemId, fromTeamId, toTeamId, mode, 'action',
    (t) => t.actionItems, (t, list) => { t.actionItems = list },
    (to, copy) => {
      copy.notes = stripAllRefs(copy.notes)
      copy.order = to.actionItems.length - 1
    }
  )
}

export function transferMilestone(
  teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'
): void {
  transferBetweenTeams(
    teams, itemId, fromTeamId, toTeamId, mode, 'milestone',
    (t) => t.milestones, (t, list) => { t.milestones = list },
    (_to, copy) => {
      copy.followup = stripAllRefs(copy.followup)
    }
  )
}

export function transferRisk(
  teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move'
): void {
  transferBetweenTeams(
    teams, itemId, fromTeamId, toTeamId, mode, 'risk',
    (t) => t.risks, (t, list) => { t.risks = list },
    (to, copy) => {
      copy.followup = stripAllRefs(copy.followup)
      copy.order = to.risks.length - 1
    }
  )
}
