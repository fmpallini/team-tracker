import { t, formatDate, parseLocaleDate, dicts } from '../src/core/i18n'
import type { MsgKey } from '../src/core/i18n'

test('t interpolates', () => {
  expect(t('pt-BR', 'app_name')).toBe('Team Tracker')
})

test('t substitutes a named {param}', () => {
  expect(t('pt-BR', 'backlinks_badge_title', { count: '5' })).toBe('5 referências')
})

test('t substitutes every distinct placeholder in one message', () => {
  expect(
    t('pt-BR', 'data_cleanup_confirm_body', { actions: '1', milestones: '2', risks: '3', dailyNotes: '4' })
  ).toContain('1 tarefas, 2 marcos, 3 riscos e 4 notas diárias')
})

test('t leaves placeholder-shaped text alone when no params are given', () => {
  // This hint string literally describes the template placeholders, so its
  // own "{data}" etc. must survive verbatim.
  expect(t('pt-BR', 'prefs_templates_placeholders_hint')).toContain('{data}')
})

test('t ignores an unused param and a message with no placeholders', () => {
  expect(t('pt-BR', 'app_name', { foo: 'bar' })).toBe('Team Tracker')
})

test('t leaves an unmatched placeholder untouched', () => {
  // 'milestone_delete_confirm' is "Excluir \"{title}\"?" — passing only an
  // unrelated param must not disturb {title}.
  expect(t('pt-BR', 'milestone_delete_confirm', { name: 'x' })).toBe('Excluir "{title}"?')
})
test('editor quote/hr/link keys exist in both locales', () => {
  for (const loc of ['pt-BR', 'en-US'] as const) {
    for (const k of ['editor_quote_title', 'editor_hr_title', 'editor_link_title', 'editor_link_prompt', 'help_shortcut_quote', 'help_shortcut_link', 'help_shortcut_open_link', 'help_md_quote', 'help_md_link'] as const) {
      expect(t(loc, k).length).toBeGreaterThan(0)
    }
  }
})
test('strike title now names both chords', () => {
  expect(t('en-US', 'editor_strike_title')).toContain('Ctrl+Shift+X')
  expect(t('en-US', 'editor_strike_title')).toContain('Ctrl+Shift+5')
})
test('formatDate per locale', () => {
  expect(formatDate('2026-07-02', 'pt-BR')).toBe('02/07/2026')
  expect(formatDate('2026-07-02', 'en-US')).toBe('07/02/2026')
})
test('parseLocaleDate valid and invalid', () => {
  expect(parseLocaleDate('02/07/2026', 'pt-BR')).toBe('2026-07-02')
  expect(parseLocaleDate('07/02/2026', 'en-US')).toBe('2026-07-02')
  expect(parseLocaleDate('31/02/2026', 'pt-BR')).toBeNull()
  expect(parseLocaleDate('junk', 'pt-BR')).toBeNull()
})

describe('locale dictionary parity', () => {
  // The `\w+` inside `{...}` — same shape t()'s substitution regex matches.
  const placeholders = (msg: string): Set<string> => {
    const out = new Set<string>()
    for (const m of msg.matchAll(/\{(\w+)\}/g)) out.add(m[1]!)
    return out
  }
  const ptKeys = Object.keys(dicts['pt-BR']) as MsgKey[]
  const enKeys = Object.keys(dicts['en-US']) as MsgKey[]

  test('both locales expose exactly the same set of keys', () => {
    // `en: Record<MsgKey, string>` already makes a missing key a typecheck
    // error; this catches a stray *extra* key in en, or a rename that only
    // half-landed, at runtime too.
    expect(new Set(enKeys)).toEqual(new Set(ptKeys))
    expect(enKeys).toHaveLength(ptKeys.length)
  })

  test('every message carries the same {param} placeholders in both locales', () => {
    const mismatches: string[] = []
    for (const key of ptKeys) {
      const ptP = placeholders(dicts['pt-BR'][key])
      const enP = placeholders(dicts['en-US'][key])
      if (ptP.size !== enP.size || [...ptP].some((p) => !enP.has(p))) {
        mismatches.push(`${key}: pt={${[...ptP].sort().join(',')}} en={${[...enP].sort().join(',')}}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  test('no message left an unmatched placeholder that t() would leak to the UI', () => {
    // A `{param}` only pays off if some call site passes it. We can't see call
    // sites here, but we can catch the typo class: a placeholder whose name is
    // not a plausible identifier (already guaranteed by \w+) is fine; a lone
    // `{` or `}` with no partner usually means a broken template.
    const broken: string[] = []
    for (const loc of ['pt-BR', 'en-US'] as const) {
      for (const key of ptKeys) {
        const msg = dicts[loc][key]
        const opens = (msg.match(/\{/g) ?? []).length
        const closes = (msg.match(/\}/g) ?? []).length
        if (opens !== closes) broken.push(`${loc}/${key}: ${JSON.stringify(msg)}`)
      }
    }
    expect(broken).toEqual([])
  })
})
