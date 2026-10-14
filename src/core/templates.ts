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
      'pt-BR': '## 1:1 — {date}\n### Como está / energia\n- \n### Tópicos dela(e)\n- \n### Meus tópicos\n- \n### Feedback\n- \n### Ações combinadas\n- ',
      'en-US': '## 1:1 — {date}\n### How are they / energy\n- \n### Their topics\n- \n### My topics\n- \n### Feedback\n- \n### Agreed actions\n- ',
    },
  },
  {
    name: { 'pt-BR': 'Feedback (SBI)', 'en-US': 'Feedback (SBI)' },
    scope: 'personal',
    body: {
      'pt-BR': '## Feedback — {date}\n**Situação:** \n**Comportamento:** \n**Impacto:** \n**Combinado:** ',
      'en-US': '## Feedback — {date}\n**Situation:** \n**Behavior:** \n**Impact:** \n**Agreed:** ',
    },
  },
  {
    name: { 'pt-BR': 'Reunião', 'en-US': 'Meeting' },
    scope: 'daily',
    body: {
      'pt-BR': '## Reunião — {time}\n**Participantes:** \n### Pauta\n- \n### Decisões\n- \n### Ações (quem → o quê → quando)\n- ',
      'en-US': '## Meeting — {time}\n**Attendees:** \n### Agenda\n- \n### Decisions\n- \n### Actions (who → what → when)\n- ',
    },
  },
  {
    name: { 'pt-BR': 'Decisão', 'en-US': 'Decision' },
    scope: 'any',
    body: {
      'pt-BR': '## Decisão — {date}\n**Contexto:** \n**Opções consideradas:** \n**Decisão:** \n**Consequências / follow-up:** ',
      'en-US': '## Decision — {date}\n**Context:** \n**Options considered:** \n**Decision:** \n**Consequences / follow-up:** ',
    },
  },
  {
    name: { 'pt-BR': 'Status semanal', 'en-US': 'Weekly status' },
    scope: 'daily',
    body: {
      'pt-BR': '## Status semanal — {date}\n### Highlights\n- \n### Lowlights\n- \n### Riscos novos\n- \n### Próxima semana\n- ',
      'en-US': '## Weekly status — {date}\n### Highlights\n- \n### Lowlights\n- \n### New risks\n- \n### Next week\n- ',
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

export function reseedBuiltinTemplates(templates: Template[], oldLocale: Locale, newLocale: Locale): Template[] {
  return templates.map((tpl) => {
    const seed = SEEDS.find((s) => s.name[oldLocale] === tpl.name && s.body[oldLocale] === tpl.body)
    if (!seed) return tpl
    return { ...tpl, name: seed.name[newLocale], body: seed.body[newLocale] }
  })
}

function replaceAllOccurrences(s: string, search: string, value: string): string {
  return s.split(search).join(value)
}

/**
 * The placeholders a template body may use, English in every locale:
 * `{date}` (formatted for the document's locale), `{time}` (wall-clock),
 * `{person}` (the person whose notes page it is) and `{team}`. Documented for
 * users in `prefs_templates_placeholders_hint` and `help_templates_text`
 * (core/i18n.ts) — keep all three in step. Files saved before schema 16 used
 * `{data}`/`{hora}`/`{pessoa}` and `{time}` for the team; `MIGRATIONS[15]`
 * (core/document.ts) rewrites those on open.
 */
export function resolveTemplate(body: string, ctx: TemplateCtx): string {
  let out = body
  out = replaceAllOccurrences(out, '{date}', formatDate(ctx.dateIso, ctx.locale))
  out = replaceAllOccurrences(out, '{time}', ctx.time)
  out = replaceAllOccurrences(out, '{person}', ctx.personName ?? '')
  out = replaceAllOccurrences(out, '{team}', ctx.teamName ?? '')
  return out
}
