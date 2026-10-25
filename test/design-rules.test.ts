import css from '../styles.css?raw'
import { readdirSync, readFileSync } from 'node:fs'

// The design rules the app's screens agree on, as failing tests, so a new rule
// or screen that drifts is caught in pre-push and CI instead of in a review.
// The rules themselves are written down in CLAUDE.md (Conventions) and the
// ui-consistency skill; this file is their executable half. Each allowlist
// entry below says why it is allowed — extend one only with a reason.

// --- a small stylesheet reader --------------------------------------------

interface Rule { selector: string; decls: Map<string, string> }

const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
const rules: Rule[] = []
for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const decls = new Map<string, string>()
  for (const d of m[2]!.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) decls.set(d[1]!, d[2]!.trim())
  rules.push({ selector: m[1]!.trim(), decls })
}

/** `:root`, `[data-theme=…]` and `[data-palette=…]` blocks: where colors are defined, so literals belong there. */
const isTokenBlock = (selector: string): boolean =>
  /^(:root,\s*)?(\[data-(theme|palette)[^\]]*\])+$/.test(selector) || selector === ':root'

const offenders = (found: string[]): string[] => found.sort()

// --- stylesheet rules -----------------------------------------------------

describe('stylesheet: motion', () => {
  /** One-off attention flashes with their own lengths (pane title, promo, milestone done, the save spinner). */
  const OWN_TIMING = ['tt-save-pill-spin', 'tt-promo-flash', 'tt-pane-title-flash', 'tt-done-flash', 'tt-done-pop']

  test('transitions take their duration and easing from the motion tokens', () => {
    const bad: string[] = []
    for (const { selector, decls } of rules) {
      const v = decls.get('transition')
      if (!v || v.startsWith('none')) continue
      for (const part of v.split(/,(?![^(]*\))/)) if (!part.includes('var(--dur-')) bad.push(`${selector} { transition: ${v} }`)
    }
    expect(offenders(bad)).toEqual([])
  })

  test('animations use the motion tokens, except the named one-off flashes', () => {
    const bad: string[] = []
    for (const { selector, decls } of rules) {
      const v = decls.get('animation')
      if (!v || v.startsWith('none')) continue
      if (v.includes('var(--dur-') || OWN_TIMING.some((n) => v.startsWith(n))) continue
      bad.push(`${selector} { animation: ${v} }`)
    }
    expect(offenders(bad)).toEqual([])
  })

  test('no transition-duration or animation-duration literals', () => {
    const bad = rules.filter((r) => ['transition-duration', 'animation-duration'].some((p) => r.decls.has(p) && !r.decls.get(p)!.includes('var(--dur-')))
    expect(bad.map((r) => r.selector)).toEqual([])
  })

  test('reduced motion is one block at the end, and no later rule adds motion', () => {
    expect([...css.matchAll(/@media \(prefers-reduced-motion/g)]).toHaveLength(1)
    const tail = css.slice(css.indexOf('@media (prefers-reduced-motion'))
    expect(tail).toContain('transition: none !important')
    expect(tail).toContain('animation: none !important')
    // Its own two declarations are the only motion after it.
    expect(tail.match(/transition:/g)).toHaveLength(1)
    expect(tail.match(/animation:/g)).toHaveLength(1)
  })
})

describe('stylesheet: highlights', () => {
  test('hover, selected and active washes use the highlight tokens, not raw accent mixes', () => {
    const bad: string[] = []
    for (const { selector, decls } of rules) {
      if (!/:hover|\.selected|\.active/.test(selector)) continue
      if (selector.includes('scrollbar')) continue // the scrollbar thumb is chrome, not a surface
      for (const p of ['background', 'background-color']) {
        const v = decls.get(p)
        if (v && /rgba\(var\(--accent-rgb\)|color-mix\([^)]*var\(--accent\)/.test(v)) bad.push(`${selector} { ${p}: ${v} }`)
      }
    }
    expect(offenders(bad)).toEqual([])
  })

  test('a keyboard-selected entry reads stronger than a hovered one', () => {
    const bad = rules
      .filter(({ selector, decls }) => /\.selected(?![\w-])/.test(selector) && ['var(--hover)', 'var(--hover-soft)'].includes(decls.get('background') ?? ''))
      .map((r) => r.selector)
    expect(offenders(bad)).toEqual([])
  })
})

describe('stylesheet: surfaces', () => {
  const CARD_CLASSES = ['.tt-kanban-card', '.tt-org-box', '.tt-risk-row', '.tt-milestone-row']

  test('card-like items get fill, shadow and radius from the shared card recipe, not their own rule', () => {
    const bad: string[] = []
    for (const { selector, decls } of rules) {
      if (!CARD_CLASSES.includes(selector)) continue
      for (const p of ['background', 'border-radius', 'box-shadow']) if (decls.has(p)) bad.push(`${selector} { ${p} }`)
    }
    expect(bad).toEqual([])
  })

  test('the shared card recipe covers every card class and the .tt-card helper', () => {
    const recipe = rules.find((r) => r.selector.startsWith('.tt-card,'))
    expect(recipe).toBeDefined()
    for (const c of ['.tt-card', ...CARD_CLASSES]) expect(recipe!.selector).toContain(c)
    expect(rules.some((r) => r.selector.includes('.tt-card:hover') && r.decls.get('background') === 'var(--card-hover)')).toBe(true)
  })

  test('corner radii are tokens, pills, circles, or a hairline of 3px or less', () => {
    const bad: string[] = []
    for (const { selector, decls } of rules) {
      const v = decls.get('border-radius')
      if (!v || selector.includes('::picker')) continue // the native select dropdown, drawn by the browser
      for (const part of v.split(/\s+/)) {
        const ok = part === '0' || part === '50%' || part === '999px' || part.startsWith('var(--r-') || (/^\d+(\.\d+)?px$/.test(part) && parseFloat(part) <= 3)
        if (!ok) bad.push(`${selector} { border-radius: ${v} }`)
      }
    }
    expect(offenders(bad)).toEqual([])
  })

  test('colors are defined in the palette blocks; components use tokens (white, black and the read-only banner excepted)', () => {
    // The read-only banner is a fixed dark orange with white text on every palette, so it is not a token.
    const ALLOWED = new Set(['#fff', '#ffffff', '#000', '#000000', '#7c2d12'])
    const bad: string[] = []
    for (const { selector, decls } of rules) {
      if (isTokenBlock(selector)) continue
      for (const [p, v] of decls) for (const hex of v.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []) if (!ALLOWED.has(hex.toLowerCase())) bad.push(`${selector} { ${p}: ${v} }`)
    }
    expect(offenders(bad)).toEqual([])
  })

  test('the Milestones, Risks and Tasks panes pad with the same step', () => {
    for (const sel of ['.tt-milestones', '.tt-risks', '.tt-kanban']) {
      const rule = rules.find((r) => r.selector === sel)
      expect(rule?.decls.get('padding'), sel).toBe('var(--sp-2)')
    }
  })
})

describe('stylesheet: focus', () => {
  test('removing the outline on :focus-visible comes with an inset ring', () => {
    const bad: string[] = []
    for (const { selector, decls } of rules) {
      if (!selector.includes(':focus-visible') || decls.get('outline') !== 'none') continue
      if (!/inset/.test(decls.get('box-shadow') ?? '')) bad.push(selector)
    }
    expect(offenders(bad)).toEqual([])
  })
})

// --- source rules ---------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...sourceFiles(path))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(path)
  }
  return out
}
const sources = sourceFiles('src').map((path) => ({ path, text: readFileSync(path, 'utf-8') }))

describe('source: dialogs, deletes and icon buttons', () => {
  test('nothing calls the browser confirm(): destructive actions use confirmDelete or an Undo toast', () => {
    const bad = sources.filter((s) => /\b(?:window\.)?confirm\s*\(/.test(s.text)).map((s) => s.path)
    expect(bad).toEqual([])
  })

  test('a dialog with a Cancel button confirms with Save (or its verb), not OK', () => {
    // The password prompt keeps OK: it unlocks or creates a file rather than saving a form.
    const ALLOWED = new Set(['src/ui/modal.ts'])
    const bad: string[] = []
    for (const { path, text } of sources) {
      if (ALLOWED.has(path)) continue
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        if (!/label:\s*t\([^)]*,\s*'ok'\)/.test(line)) return
        if (lines.slice(Math.max(0, i - 12), i + 12).some((l) => /'cancel'/.test(l))) bad.push(`${path}:${i + 1}`)
      })
    }
    expect(bad).toEqual([])
  })

  test('an icon-only button carries its accessible name: it goes through iconButton() or sets aria-label', () => {
    const iconOnly = /el\(\s*'button',\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*,\s*icon\(([^()]*)\)\s*\)/g
    const bad: string[] = []
    for (const { path, text } of sources) {
      if (path.endsWith('ui/icons.ts')) continue // the helper itself
      for (const m of text.matchAll(iconOnly)) {
        if (!m[1]!.includes('aria-label')) bad.push(`${path}:${text.slice(0, m.index).split('\n').length}`)
      }
    }
    expect(bad).toEqual([])
  })
})
