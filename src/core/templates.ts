import type { Template } from './types'
import type { Locale } from './i18n'
import { formatDateWithWeekday } from './i18n'

export interface TemplateCtx {
  dateIso: string
  time: string
  personName?: string
  teamName?: string
  locale: Locale
  /** Markdown that fills `{carryover}`: the open checklist items carried from the person note (every one, not only the last 1:1's). Empty or absent drops the section. */
  carryover?: string
}

/**
 * Whether a template can start a person's 1:1: only one scoped to person notes — a Shared ('any') template (Meeting,
 * Decision, Retro) is not a 1:1. One rule for the Preferences select (which lists only these) and for New 1:1 (which ignores a
 * chosen template that no longer qualifies, so the select's "None" is never a lie).
 */
export function isOneOnOneCandidate(tpl: Template): boolean {
  return tpl.scope === 'personal'
}

/** Name of the built-in 1:1 template, the one the 1:1 flow looks up. */
export const ONE_ON_ONE_SEED_NAME = '1:1'

type Localized = { 'pt-BR': string; 'en-US': string }

interface TemplateSeed {
  name: Localized
  scope: Template['scope']
  body: Localized
  /**
   * Every body this seed shipped with before its current one, oldest first. A template still holding one word for
   * word (under the seed's name) is an untouched built-in, so a locale switch (`reseedBuiltinTemplates`) moves it to
   * the current body. Nothing else rewrites a template on its own; Restore defaults does on request.
   */
  previousBodies?: Localized[]
}

/** The 1:1 seed before `{carryover}` (up to schema 19): the one body schema 20's migration upgrades on open. */
const ONE_ON_ONE_BEFORE_CARRYOVER: Localized = {
  'pt-BR': '## 1:1 — {date}\n### Como está / energia\n- \n### Tópicos dela(e)\n- \n### Meus tópicos\n- \n### Feedback\n- \n### Ações combinadas\n- ',
  'en-US': '## 1:1 — {date}\n### How are they / energy\n- \n### Their topics\n- \n### My topics\n- \n### Feedback\n- \n### Agreed actions\n- ',
}

// Light structure: one small title heading, then bold labels — alone on their line over a bullet list, or inline
// with the text following on the same line. Follow-ups are `- [ ]` checkboxes: open ones in a person's notes are
// what New 1:1 carries forward, so an agreed item written here reaches the next 1:1 on its own. A blank line sets the
// title off from the body (`withoutTitleGap` recognizes each seed's body from before that).
// Documents seeded before this keep their headed bodies: built-ins already in a file are never rewritten.
const SEEDS: TemplateSeed[] = [
  {
    name: { 'pt-BR': 'Primeiro 1:1', 'en-US': 'First 1:1' },
    scope: 'personal',
    body: {
      'pt-BR': '### Primeiro 1:1 — {date}\n\n**Como gosta de trabalhar / se comunicar**\n- \n**O que motiva**\n- \n**Objetivos de carreira**\n- \n**O que precisa de mim**\n- \n**Algo que eu deva saber**\n- \n**Ações combinadas**\n- [ ] ',
      'en-US': '### First 1:1 — {date}\n\n**How they like to work / communicate**\n- \n**What motivates them**\n- \n**Career goals**\n- \n**What they need from me**\n- \n**Anything I should know**\n- \n**Agreed actions**\n- [ ] ',
    },
  },
  {
    name: { 'pt-BR': ONE_ON_ONE_SEED_NAME, 'en-US': ONE_ON_ONE_SEED_NAME },
    scope: 'personal',
    body: {
      'pt-BR': '### 1:1 — {date}\n\n**Pendências anteriores**\n{carryover}\n**Como está / energia**\n- \n**Tópicos dela(e)**\n- \n**Meus tópicos**\n- \n**Feedback (dado / recebido)**\n- \n**Ações combinadas**\n- [ ] ',
      'en-US': '### 1:1 — {date}\n\n**Carried over**\n{carryover}\n**How are they / energy**\n- \n**Their topics**\n- \n**My topics**\n- \n**Feedback (given / received)**\n- \n**Agreed actions**\n- [ ] ',
    },
    previousBodies: [
      ONE_ON_ONE_BEFORE_CARRYOVER,
      {
        'pt-BR': '## 1:1 — {date}\n### Pendências anteriores\n{carryover}\n### Como está / energia\n- \n### Tópicos dela(e)\n- \n### Meus tópicos\n- \n### Feedback\n- \n### Ações combinadas\n- [ ] ',
        'en-US': '## 1:1 — {date}\n### Carried over\n{carryover}\n### How are they / energy\n- \n### Their topics\n- \n### My topics\n- \n### Feedback\n- \n### Agreed actions\n- [ ] ',
      },
    ],
  },
  {
    name: { 'pt-BR': 'Feedback (SBI)', 'en-US': 'Feedback (SBI)' },
    scope: 'personal',
    body: {
      'pt-BR': '### Feedback — {date}\n\n**Situação:** \n**Comportamento:** \n**Impacto:** \n**Combinado**\n- [ ] ',
      'en-US': '### Feedback — {date}\n\n**Situation:** \n**Behavior:** \n**Impact:** \n**Agreed**\n- [ ] ',
    },
    previousBodies: [{
      'pt-BR': '## Feedback — {date}\n**Situação:** \n**Comportamento:** \n**Impacto:** \n**Combinado:** ',
      'en-US': '## Feedback — {date}\n**Situation:** \n**Behavior:** \n**Impact:** \n**Agreed:** ',
    }],
  },
  {
    name: { 'pt-BR': 'Conversa de carreira', 'en-US': 'Career conversation' },
    scope: 'personal',
    body: {
      'pt-BR': '### Conversa de carreira — {date}\n\n**Onde quer estar em 1–2 anos**\n- \n**Pontos fortes**\n- \n**Pontos a desenvolver**\n- \n**Oportunidades**\n- \n**Próximos passos**\n- [ ] ',
      'en-US': '### Career conversation — {date}\n\n**Where they want to be in 1–2 years**\n- \n**Strengths**\n- \n**Growth areas**\n- \n**Opportunities**\n- \n**Next steps**\n- [ ] ',
    },
  },
  {
    name: { 'pt-BR': 'Reunião', 'en-US': 'Meeting' },
    scope: 'any',
    body: {
      'pt-BR': '### Reunião — {time}\n\n**Participantes:** \n**Pauta**\n- \n**Decisões**\n- \n**Ações (quem → o quê → quando)**\n- [ ] ',
      'en-US': '### Meeting — {time}\n\n**Attendees:** \n**Agenda**\n- \n**Decisions**\n- \n**Actions (who → what → when)**\n- [ ] ',
    },
    previousBodies: [{
      'pt-BR': '## Reunião — {time}\n**Participantes:** \n### Pauta\n- \n### Decisões\n- \n### Ações (quem → o quê → quando)\n- ',
      'en-US': '## Meeting — {time}\n**Attendees:** \n### Agenda\n- \n### Decisions\n- \n### Actions (who → what → when)\n- ',
    }],
  },
  {
    name: { 'pt-BR': 'Status semanal', 'en-US': 'Weekly status' },
    scope: 'any',
    body: {
      'pt-BR': '### Status semanal — {date}\n\n**Highlights**\n- \n**Lowlights**\n- \n**Milestones**\n- \n**Riscos novos**\n- \n**Próxima semana**\n- ',
      'en-US': '### Weekly status — {date}\n\n**Highlights**\n- \n**Lowlights**\n- \n**Milestones**\n- \n**New risks**\n- \n**Next week**\n- ',
    },
    previousBodies: [{
      'pt-BR': '## Status semanal — {date}\n### Highlights\n- \n### Lowlights\n- \n### Riscos novos\n- \n### Próxima semana\n- ',
      'en-US': '## Weekly status — {date}\n### Highlights\n- \n### Lowlights\n- \n### New risks\n- \n### Next week\n- ',
    }],
  },
  {
    name: { 'pt-BR': 'Decisão', 'en-US': 'Decision' },
    scope: 'any',
    body: {
      'pt-BR': '### Decisão — {date}\n\n**Contexto:** \n**Opções consideradas:** \n**Decisão:** \n**Decidido por:** \n**Revisar em:** \n**Consequências / follow-up**\n- [ ] ',
      'en-US': '### Decision — {date}\n\n**Context:** \n**Options considered:** \n**Decision:** \n**Decided by:** \n**Revisit on:** \n**Consequences / follow-up**\n- [ ] ',
    },
    previousBodies: [{
      'pt-BR': '## Decisão — {date}\n**Contexto:** \n**Opções consideradas:** \n**Decisão:** \n**Consequências / follow-up:** ',
      'en-US': '## Decision — {date}\n**Context:** \n**Options considered:** \n**Decision:** \n**Consequences / follow-up:** ',
    }],
  },
  {
    name: { 'pt-BR': 'Retro / Incidente', 'en-US': 'Retro / Incident' },
    scope: 'any',
    body: {
      'pt-BR': '### Retro — {date}\n\n**O que aconteceu / linha do tempo**\n- \n**Impacto**\n- \n**O que foi bem**\n- \n**O que melhorar**\n- \n**Ações**\n- [ ] ',
      'en-US': '### Retro — {date}\n\n**What happened / timeline**\n- \n**Impact**\n- \n**What went well**\n- \n**What to improve**\n- \n**Actions**\n- [ ] ',
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

/** A seed body as it shipped before the blank line under its title (3.9.4 and earlier): the same text with that line gone. */
function withoutTitleGap(body: string): string {
  return body.replace('\n\n', '\n')
}

export function reseedBuiltinTemplates(templates: Template[], oldLocale: Locale, newLocale: Locale): Template[] {
  return templates.map((tpl) => {
    const seed = SEEDS.find((s) => s.name[oldLocale] === tpl.name
      && (s.body[oldLocale] === tpl.body || withoutTitleGap(s.body[oldLocale]) === tpl.body
        || !!s.previousBodies?.some((b) => b[oldLocale] === tpl.body)))
    if (!seed) return tpl
    return { ...tpl, name: seed.name[newLocale], body: seed.body[newLocale] }
  })
}

/**
 * Schema 20's migration: a 1:1 seed still holding its body from before `{carryover}` moves to the current 1:1 body,
 * in the locale it was written in. Only that exact body moves; later built-in changes reach a file only through
 * Restore defaults, which replaces the whole set with `builtinTemplates`.
 */
export function upgradeLegacySeedBodies(templates: Template[]): Template[] {
  const oneOnOne = SEEDS.find((s) => s.name['en-US'] === ONE_ON_ONE_SEED_NAME)!
  return templates.map((tpl) => {
    for (const locale of ['pt-BR', 'en-US'] as const) {
      if (ONE_ON_ONE_BEFORE_CARRYOVER[locale] === tpl.body) return { ...tpl, body: oneOnOne.body[locale] }
    }
    return tpl
  })
}


/** A line that only labels the section below it: a `#`–`###` heading, or a bold run alone on its line (`**Carried over**`). */
const SECTION_LABEL = /^(#{1,3} |\*\*[^*]+\*\*:?\s*$)/

function replaceAllOccurrences(s: string, search: string, value: string): string {
  return s.split(search).join(value)
}

/**
 * The placeholders a template body may use, English in every locale:
 * `{date}` (weekday and date, formatted for the document's locale), `{time}` (wall-clock),
 * `{person}` (the person whose notes page it is), `{team}` and `{carryover}`
 * (every open checklist item carried from the person note; when there are none, a line that
 * is only `{carryover}` is dropped together with the `#`–`###` heading or
 * lone bold label right above it, unless that heading is the first line; New 1:1 fills only the first
 * such line outside a code fence and clears every other `{carryover}`, see
 * `buildOneOnOne`). Documented for
 * users in `prefs_templates_placeholders_hint` and `help_templates_text`
 * (core/i18n.ts) — keep all three in step. Files saved before schema 16 used
 * `{data}`/`{hora}`/`{pessoa}` and `{time}` for the team; `MIGRATIONS[15]`
 * (core/document.ts) rewrites those on open.
 */
export function resolveTemplate(body: string, ctx: TemplateCtx): string {
  let out = body
  out = replaceAllOccurrences(out, '{date}', formatDateWithWeekday(ctx.dateIso, ctx.locale))
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
    // Index 0 is the template's title, never a section label to sweep away.
    if (i > 1 && SECTION_LABEL.test(lines[i - 1]!)) dropped.add(i - 1)
  })
  return lines.filter((_, i) => !dropped.has(i)).join('\n').split('{carryover}').join('')
}
