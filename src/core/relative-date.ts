// src/core/relative-date.ts — "next tuesday" / "last monday" style date phrases
// for the `@` mention dropdown (src/ui/atref.ts). Pure: `today` is passed in.
//
// Semantics are deliberately the *directly adjacent* occurrence: "next X" is
// the first X strictly after today, "last X" the most recent X strictly before
// today — so on a Tuesday, "next tuesday" is +7 days, never today. The
// dropdown shows the resolved date next to the phrase, which is what makes the
// (inherently ambiguous) English "next <weekday>" safe to offer.
import { normalize } from './search'
import { addDaysIso } from './date'
import type { Locale } from './i18n'

export interface RelativeWeekday {
  date: string
  /** The full phrase that matched, for display ("next tuesday"). */
  word: string
}

type Direction = 'next' | 'last'

interface LocaleSpec {
  /** Per weekday (0 = Sunday), accepted names; the first is canonical. */
  aliases: string[][]
  /** Full phrases for a weekday in a direction; the first is canonical. */
  phrases(dir: Direction, dow: number): string[]
}

const EN_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const PT_DAYS: { aliases: string[]; feminine: boolean }[] = [
  { aliases: ['domingo'], feminine: false },
  { aliases: ['segunda', 'segunda-feira'], feminine: true },
  { aliases: ['terça', 'terça-feira'], feminine: true },
  { aliases: ['quarta', 'quarta-feira'], feminine: true },
  { aliases: ['quinta', 'quinta-feira'], feminine: true },
  { aliases: ['sexta', 'sexta-feira'], feminine: true },
  { aliases: ['sábado'], feminine: false },
]

const SPECS: Record<Locale, LocaleSpec> = {
  'en-US': {
    aliases: EN_DAYS.map((d) => [d]),
    phrases: (dir, dow) => (dir === 'next' ? ['next'] : ['last', 'previous', 'past']).map((w) => `${w} ${EN_DAYS[dow]!}`),
  },
  'pt-BR': {
    aliases: PT_DAYS.map((d) => d.aliases),
    phrases(dir, dow) {
      const { aliases, feminine } = PT_DAYS[dow]!
      return aliases.flatMap((name) => dir === 'next'
        ? [`${feminine ? 'próxima' : 'próximo'} ${name}`, `${name} que vem`]
        : [`${name} ${feminine ? 'passada' : 'passado'}`, `${feminine ? 'última' : 'último'} ${name}`, `${name} anterior`])
    },
  },
}

function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d).getDay()
}

/**
 * Weekday phrases whose text starts with `typed` (accent/case/whitespace-
 * insensitive), resolved against `today`. A bare weekday prefix ("tue") offers
 * both directions. Empty text matches nothing, so a bare `@` stays uncluttered.
 * Within a direction results run nearest-first; "next" results precede "last".
 */
export function matchRelativeWeekdays(typed: string, today: string, locale: Locale): RelativeWeekday[] {
  const q = normalize(typed.trim()).replace(/\s+/g, ' ')
  if (q === '') return []

  const spec = SPECS[locale]
  const todayDow = weekdayOf(today)
  const out: RelativeWeekday[] = []
  for (const dir of ['next', 'last'] as const) {
    const sign = dir === 'next' ? 1 : -1
    for (let k = 1; k <= 7; k++) {
      const dow = (((todayDow + sign * k) % 7) + 7) % 7
      const phrases = spec.phrases(dir, dow)
      // Bare-name match first: it must resolve to the canonical phrase, not
      // to whichever alternative phrase ("terça que vem") also starts with it.
      const word = spec.aliases[dow]!.some((a) => normalize(a).startsWith(q))
        ? phrases[0]
        : phrases.find((p) => normalize(p).startsWith(q))
      if (word) out.push({ date: addDaysIso(today, sign * k), word })
    }
  }
  return out
}
