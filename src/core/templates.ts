import type { Template } from './types'
import type { Locale } from './i18n'
import { formatDate } from './i18n'

export interface TemplateCtx {
  dateIso: string
  time: string
  personName?: string
  teamName?: string
  locale: Locale
}

interface TemplateSeed {
  name: { 'pt-BR': string; 'en-US': string }
  scope: Template['scope']
  body: { 'pt-BR': string; 'en-US': string }
}

const SEEDS: TemplateSeed[] = [
  {
    name: { 'pt-BR': '1:1', 'en-US': '1:1' },
    scope: 'personal',
    body: {
      'pt-BR': '## 1:1 — {data}\n### Como está / energia\n- \n### Tópicos dela(e)\n- \n### Meus tópicos\n- \n### Feedback\n- \n### Ações combinadas\n- ',
      'en-US': '## 1:1 — {data}\n### How are they / energy\n- \n### Their topics\n- \n### My topics\n- \n### Feedback\n- \n### Agreed actions\n- ',
    },
  },
  {
    name: { 'pt-BR': 'Feedback (SBI)', 'en-US': 'Feedback (SBI)' },
    scope: 'personal',
    body: {
      'pt-BR': '## Feedback — {data}\n**Situação:** \n**Comportamento:** \n**Impacto:** \n**Combinado:** ',
      'en-US': '## Feedback — {data}\n**Situation:** \n**Behavior:** \n**Impact:** \n**Agreed:** ',
    },
  },
  {
    name: { 'pt-BR': 'Reunião', 'en-US': 'Meeting' },
    scope: 'daily',
    body: {
      'pt-BR': '## Reunião — {hora}\n**Participantes:** \n### Pauta\n- \n### Decisões\n- \n### Ações (quem → o quê → quando)\n- ',
      'en-US': '## Meeting — {hora}\n**Attendees:** \n### Agenda\n- \n### Decisions\n- \n### Actions (who → what → when)\n- ',
    },
  },
  {
    name: { 'pt-BR': 'Decisão (mini-ADR)', 'en-US': 'Decision (mini-ADR)' },
    scope: 'any',
    body: {
      'pt-BR': '## Decisão — {data}\n**Contexto:** \n**Opções consideradas:** \n**Decisão:** \n**Consequências / follow-up:** ',
      'en-US': '## Decision — {data}\n**Context:** \n**Options considered:** \n**Decision:** \n**Consequences / follow-up:** ',
    },
  },
  {
    name: { 'pt-BR': 'Status semanal', 'en-US': 'Weekly status' },
    scope: 'daily',
    body: {
      'pt-BR': '## Status semanal — {data}\n### Highlights\n- \n### Lowlights\n- \n### Riscos novos\n- \n### Próxima semana\n- ',
      'en-US': '## Weekly status — {data}\n### Highlights\n- \n### Lowlights\n- \n### New risks\n- \n### Next week\n- ',
    },
  },
]

export function builtinTemplates(locale: Locale): Template[] {
  return SEEDS.map(seed => ({
    id: crypto.randomUUID(),
    name: seed.name[locale],
    scope: seed.scope,
    body: seed.body[locale],
  }))
}

function replaceAllOccurrences(s: string, search: string, value: string): string {
  return s.split(search).join(value)
}

export function resolveTemplate(body: string, ctx: TemplateCtx): string {
  let out = body
  out = replaceAllOccurrences(out, '{data}', formatDate(ctx.dateIso, ctx.locale))
  out = replaceAllOccurrences(out, '{hora}', ctx.time)
  out = replaceAllOccurrences(out, '{pessoa}', ctx.personName ?? '')
  out = replaceAllOccurrences(out, '{time}', ctx.teamName ?? '')
  return out
}
