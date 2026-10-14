// test/search-fixture.ts — a deliberately rich synthetic document for the search
// index tests (search-incremental.test.ts, search-differential.test.ts). Unlike
// the single-purpose fixtures in the older search-*.test.ts files it exercises
// every searchable surface at once: accented pt-BR text, markdown, @[..](kind:id)
// mentions of every ref kind, people in both groups, items in every module,
// a few fields above the eager-strip threshold, and several teams — so a cache
// bug confined to one field kind or one team cannot hide.
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Doc, Team } from '../src/core/types'

export interface RichDocShape {
  teams: number
  dailyNotes: number
  people: number
  actions: number
  milestones: number
  risks: number
}

export const DEFAULT_SHAPE: RichDocShape = { teams: 12, dailyNotes: 80, people: 10, actions: 100, milestones: 60, risks: 60 }

/** Seeded LCG — the same sequence on every run, so a failure is reproducible from its seed alone. */
export function makeRng(seed: number): () => number {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
}

export const WORDS = ('rollout release blocker standup vendor contrato migração incidente orçamento previsão reunião '
  + 'decisão auditoria pendência handover escalonamento dependência entrega Ação Ângelo café').split(' ')

export function sentence(rnd: () => number, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]!)
  return out.join(' ')
}

/** Daily-note dates for the Nth note — distinct for every N so no two notes share a key. */
export const dateKey = (n: number): string => `2026-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 27) + 1).padStart(2, '0')}-${n}`

function noteBody(rnd: () => number, team: Team, shape: RichDocShape, big: boolean): string {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!
  const mention = (): string => {
    switch (Math.floor(rnd() * 5)) {
      case 0: return `@[${pick(team.actionItems).summary}](action:${pick(team.actionItems).id})`
      case 1: return `@[${pick(team.milestones).title}](milestone:${pick(team.milestones).id})`
      case 2: return `@[${pick(team.risks).title}](risk:${pick(team.risks).id})`
      case 3: return `@[${pick(team.members).name}](person:${pick(team.members).id})`
      default: return `@[Dia](day:${dateKey(Math.floor(rnd() * shape.dailyNotes))})`
    }
  }
  const lines = [
    `# ${sentence(rnd, 3)}`,
    `${sentence(rnd, 25)} ${mention()} ${sentence(rnd, 10)}`,
    `- **${sentence(rnd, 2)}** ${sentence(rnd, 8)}`,
    `1. *${sentence(rnd, 2)}* ~~${sentence(rnd, 2)}~~ ${mention()}`,
  ]
  if (big) for (let i = 0; i < 400; i++) lines.push(sentence(rnd, 14))
  return lines.join('\n')
}

export function buildRichTeam(rnd: () => number, index: number, shape: RichDocShape = DEFAULT_SHAPE): Team {
  const team = createEmptyTeam(`t${index}`, `Equipe ${index}`, '🚀', 'pt-BR')
  for (let p = 0; p < shape.people; p++) {
    const person = { id: `t${index}-p${p}`, name: `Pessoa ${p} Çelina`, role: 'Eng', parentId: null, order: p, notes: '' }
    ;(p % 3 === 0 ? team.stakeholders : team.members).push(person)
  }
  // `members` must be non-empty for the mention picker below.
  if (team.members.length === 0) team.members.push({ id: `t${index}-pm`, name: 'Membro', role: '', parentId: null, order: 99, notes: '' })
  for (let i = 0; i < shape.actions; i++) {
    team.actionItems.push({
      id: `t${index}-a${i}`, summary: `Ação ${i} ${sentence(rnd, 3)}`, status: 'todo', color: 'ledger',
      dueDate: null, assignee: `Pessoa ${i % 7}`, order: i, notes: sentence(rnd, 20),
    })
  }
  for (let i = 0; i < shape.milestones; i++) {
    team.milestones.push({ id: `t${index}-m${i}`, date: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`, title: `Marco ${i} ${sentence(rnd, 2)}`, done: false, followup: sentence(rnd, 12) })
  }
  for (let i = 0; i < shape.risks; i++) {
    team.risks.push({ id: `t${index}-r${i}`, title: `Risco ${i} ${sentence(rnd, 2)}`, chance: 1, impact: 2, plan: 'mitigate', followup: sentence(rnd, 12), order: i, closed: false })
  }
  // Bodies are written once every pickable target exists, so mentions resolve.
  for (const person of [...team.stakeholders, ...team.members]) person.notes = noteBody(rnd, team, shape, false)
  for (let d = 0; d < shape.dailyNotes; d++) team.dailyNotes[dateKey(d)] = noteBody(rnd, team, shape, d % 40 === 0)
  team.generalNotes = noteBody(rnd, team, shape, true)
  return team
}

export function buildRichDoc(shape: RichDocShape = DEFAULT_SHAPE, seed = 20261013): Doc {
  const rnd = makeRng(seed)
  const doc = createEmptyDocument('pt-BR')
  for (let i = 0; i < shape.teams; i++) doc.teams.push(buildRichTeam(rnd, i, shape))
  doc.nav.activeTeamId = doc.teams[0]!.id
  return doc
}
