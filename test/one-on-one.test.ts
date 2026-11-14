import { buildOneOnOne } from '../src/core/one-on-one'
import { builtinTemplates, ONE_ON_ONE_SEED_NAME } from '../src/core/templates'
import { t } from '../src/core/i18n'

const seedBody = (locale: 'pt-BR' | 'en-US') => builtinTemplates(locale).find(tpl => tpl.name === ONE_ON_ONE_SEED_NAME)!.body
const SEED_EN = seedBody('en-US')
const ctx = { dateIso: '2026-11-13', time: '10:00', personName: 'Ana', locale: 'en-US' as const }

test('first 1:1 on an empty note: no rule, no carried section', () => {
  const r = buildOneOnOne('', SEED_EN, ctx)
  expect(r.md.startsWith('## 1:1 — ')).toBe(true); expect(r.md).not.toContain('Carried over'); expect(r.blockHrFromEnd).toBeNull()
})

test('a whitespace-only note counts as empty', () => {
  const r = buildOneOnOne('  \n\n', SEED_EN, ctx)
  expect(r.md.startsWith('## 1:1 — ')).toBe(true); expect(r.blockHrFromEnd).toBeNull()
})

test('carries open items with subtree, marks originals, skips done and blank', () => {
  const note = '## 1:1\n- [ ] a\n  - detail\n- [x] b\n- [ ] \n- [>] old'
  const r = buildOneOnOne(note, SEED_EN, ctx)
  expect(r.md).toContain('- [>] a\n  - detail\n- [x] b\n- [ ] \n- [>] old\n---\n## 1:1')
  expect(r.md).toContain('### Carried over\n- [ ] a\n  - detail\n### How are they')
  expect(r.blockHrFromEnd).toBe(0)
})

test('nested open task under a non-task bullet is lifted to top level', () => {
  expect(buildOneOnOne('- topic\n  - [ ] x\n    - y', SEED_EN, ctx).md).toContain('### Carried over\n- [ ] x\n  - y\n')
})

test('marks nested open tasks carried too', () => {
  const r = buildOneOnOne('- [ ] a\n  - [ ] b', SEED_EN, ctx)
  expect(r.md.split('---')[0]).toBe('- [>] a\n  - [>] b\n')
  expect(r.md).toContain('### Carried over\n- [ ] a\n  - [ ] b\n')          // b travels once, inside a
  expect(buildOneOnOne(r.md, SEED_EN, ctx).md.match(/- \[ \] b/g)!.length).toBe(1) // second 1:1: b is open only in its newest copy
})

test('the subtree keeps done, carried and ordered children as they are', () => {
  const r = buildOneOnOne('- [ ] a\n  - [x] done\n  - [>] old\n  1. [ ] step\n    - deep\n- next', SEED_EN, ctx)
  expect(r.md.split('\n---\n')[0]).toBe('- [>] a\n  - [x] done\n  - [>] old\n  1. [ ] step\n    - deep\n- next')
  expect(r.md).toContain('### Carried over\n- [ ] a\n  - [x] done\n  - [>] old\n  1. [ ] step\n    - deep\n### How')
})

test('the subtree ends at the first line that is not a deeper list item', () => {
  const r = buildOneOnOne('- [ ] a\ntext\n  - [ ] c\n- [ ] d\n  - e', SEED_EN, ctx)
  expect(r.md.split('\n---\n')[0]).toBe('- [>] a\ntext\n  - [>] c\n- [>] d\n  - e')
  expect(r.md).toContain('### Carried over\n- [ ] a\n- [ ] c\n- [ ] d\n  - e\n### How')
})

test('fenced and ordered task text is ignored', () => {
  const note = '```\n- [ ] fenced\n```\n1. [ ] ordered\n````\n- [ ] long\n```\n````\n- [ ] real'
  const r = buildOneOnOne(note, SEED_EN, ctx)
  expect(r.md.split('\n---\n')[0]).toBe(note.replace('- [ ] real', '- [>] real'))
  expect(r.md).toContain('### Carried over\n- [ ] real\n### How')
})

test('a fence left open at the end of the note is closed before the rule', () => {
  const r = buildOneOnOne('- [ ] a\n```\ncode', SEED_EN, ctx)
  expect(r.md).toContain('- [>] a\n```\ncode\n```\n---\n## 1:1')
  expect(r.blockHrFromEnd).toBe(0)
})

test('template without {carryover} still carries after the first line', () => {
  expect(buildOneOnOne('- [ ] a', '## Mine\n- x', ctx).md).toContain('---\n## Mine\n### Carried over\n- [ ] a\n- x')
})

test('template without {carryover} and nothing to carry is used as is', () => {
  expect(buildOneOnOne('- [x] a', '## Mine\n- x', ctx).md).toBe('- [x] a\n---\n## Mine\n- x')
})

test('missing template falls back to a bare heading plus carried items', () => {
  expect(buildOneOnOne('- [ ] a', null, ctx).md).toMatch(/---\n## 1:1 — .+\n### Carried over\n- \[ \] a$/)
})

test('the carried heading is localized and matches the seed heading', () => {
  const pt = { ...ctx, locale: 'pt-BR' as const }
  expect(buildOneOnOne('- [ ] a', null, pt).md).toContain(`\n### ${t('pt-BR', 'one_on_one_carried_heading')}\n- [ ] a`)
  expect(seedBody('pt-BR')).toContain(`\n### ${t('pt-BR', 'one_on_one_carried_heading')}\n{carryover}\n`)
  expect(SEED_EN).toContain(`\n### ${t('en-US', 'one_on_one_carried_heading')}\n{carryover}\n`)
})

test('a caller-supplied carryover is replaced by the collected items', () => {
  expect(buildOneOnOne('', SEED_EN, { ...ctx, carryover: '- [ ] stale' }).md).not.toContain('stale')
})

test('blockHrFromEnd counts rules inside the template body', () => {
  expect(buildOneOnOne('x', '## A\n---\n- ', ctx).blockHrFromEnd).toBe(1)
})

test('blockHrFromEnd ignores rule lines inside a fence', () => {
  expect(buildOneOnOne('x', '## A\n```\n---\n```\n---', ctx).blockHrFromEnd).toBe(1)
})

test('a blank open task inside a carried subtree travels with it and is marked too', () => {
  const r = buildOneOnOne('- [ ] a\n  - [ ] ', SEED_EN, ctx)
  expect(r.md.split('\n---\n')[0]).toBe('- [>] a\n  - [>]')
  expect(r.md).toContain('### Carried over\n- [ ] a\n  - [ ] \n### How')
})

test('a deeper task is carried dedented by its own indent, and the rest of the note is untouched', () => {
  const note = 'intro\n\n    - [ ] deep\n      - child\n\n## Later\ntext  '
  const r = buildOneOnOne(note, SEED_EN, ctx)
  expect(r.md.split('\n---\n')[0]).toBe('intro\n\n    - [>] deep\n      - child\n\n## Later\ntext')
  expect(r.md).toContain('### Carried over\n- [ ] deep\n  - child\n### How')
})
