import type { Template } from './types'
import type { Locale } from './i18n'
import { formatDate } from './i18n'

export interface TemplateCtx {
  dateIso: string
  time: string
  personName?: string
  teamName?: string
  locale: Locale
  /** Markdown that fills `{carryover}`: the open items carried from the last 1:1. Empty or absent drops the section. */
  carryover?: string
}

/** Name of the built-in 1:1 template, the one the 1:1 flow looks up. */
export const ONE_ON_ONE_SEED_NAME = '1:1'

interface TemplateSeed {
  name: { 'pt-BR': string; 'en-US': string }
  scope: Template['scope']
  body: { 'pt-BR': string; 'en-US': string }
  /** Bodies this seed shipped with before its current one. Reseed and `upgradeLegacySeedBodies` treat them as untouched. */
  legacyBody?: { 'pt-BR': string; 'en-US': string }
}

const SEEDS: TemplateSeed[] = [
  {
    name: { 'pt-BR': ONE_ON_ONE_SEED_NAME, 'en-US': ONE_ON_ONE_SEED_NAME },
    scope: 'personal',
    body: {
      'pt-BR': '## 1:1 — {date}\n### Pendências anteriores\n{carryover}\n### Como está / energia\n- \n### Tópicos dela(e)\n- \n### Meus tópicos\n- \n### Feedback\n- \n### Ações combinadas\n- [ ] ',
      'en-US': '## 1:1 — {date}\n### Carried over\n{carryover}\n### How are they / energy\n- \n### Their topics\n- \n### My topics\n- \n### Feedback\n- \n### Agreed actions\n- [ ] ',
    },
    legacyBody: {
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
    const seed = SEEDS.find((s) => s.name[oldLocale] === tpl.name
      && (s.body[oldLocale] === tpl.body || s.legacyBody?.[oldLocale] === tpl.body))
    if (!seed) return tpl
    return { ...tpl, name: seed.name[newLocale], body: seed.body[newLocale] }
  })
}

/**
 * Brings a template still holding an earlier built-in body (`legacyBody`) up to
 * the current one, in the locale it was written in. Only an exact match moves:
 * an edited body is the user's and stays as is.
 */
export function upgradeLegacySeedBodies(templates: Template[]): Template[] {
  return templates.map((tpl) => {
    for (const seed of SEEDS) {
      if (!seed.legacyBody) continue
      for (const locale of ['pt-BR', 'en-US'] as const) {
        if (seed.legacyBody[locale] === tpl.body) return { ...tpl, body: seed.body[locale] }
      }
    }
    return tpl
  })
}

function replaceAllOccurrences(s: string, search: string, value: string): string {
  return s.split(search).join(value)
}

/**
 * The placeholders a template body may use, English in every locale:
 * `{date}` (formatted for the document's locale), `{time}` (wall-clock),
 * `{person}` (the person whose notes page it is), `{team}` and `{carryover}`
 * (the open items carried from the last 1:1; when there are none, a line that
 * is only `{carryover}` is dropped together with the `#`–`###` heading right
 * above it, unless that heading is the first line). Documented for
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
  // Last, so the carried text is never itself scanned for the other placeholders.
  const carryover = ctx.carryover ?? ''
  if (carryover) return replaceAllOccurrences(out, '{carryover}', carryover)
  const lines = out.split('\n')
  const dropped = new Set<number>()
  lines.forEach((line, i) => {
    if (line !== '{carryover}') return
    dropped.add(i)
    // Index 0 is the template's title, never a section heading to sweep away.
    if (i > 1 && /^#{1,3} /.test(lines[i - 1]!)) dropped.add(i - 1)
  })
  return lines.filter((_, i) => !dropped.has(i)).join('\n').split('{carryover}').join('')
}
