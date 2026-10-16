// src/ui/icons.ts
import { el } from './dom'
import type { SearchResult } from '../core/search'

// One home for the app's stroke icons. Each is drawn on a 16×16 grid with a
// `currentColor` stroke and round caps/joins (the style of the search glass),
// instead of an emoji or Unicode glyph: emoji metrics vary by platform font,
// never sit flush with the button's text, and ignore the button's color (hover,
// danger, disabled), while a stroke icon inherits it for free. Elements marked
// `class="f"` are filled (dots) rather than stroked.
const PATHS = {
  trash:
    '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2M6.75 7v4M9.25 7v4"/>',
  edit: '<path d="M2.75 13.25l.5-3L10.5 3 13 5.5l-7.25 7.25zM9 4.5L11.5 7"/>',
  fullscreen: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  gear:
    '<path d="M12.9 6.59L14.47 6.69L14.47 9.31L12.9 9.41L12.46 10.47L13.5 11.65L11.65 13.5L10.47 12.46L9.41 12.9L9.31 14.47L6.69 14.47L6.59 12.9L5.53 12.46L4.35 13.5L2.5 11.65L3.54 10.47L3.1 9.41L1.53 9.31L1.53 6.69L3.1 6.59L3.54 5.53L2.5 4.35L4.35 2.5L5.53 3.54L6.59 3.1L6.69 1.53L9.31 1.53L9.41 3.1L10.47 3.54L11.65 2.5L13.5 4.35L12.46 5.53z"/><circle cx="8" cy="8" r="2.1"/>',
  help:
    '<circle cx="8" cy="8" r="6.25"/><path d="M6.06 6.1a2 2 0 0 1 3.89.67c0 1.33-2 2-2 2"/><circle class="f" cx="8" cy="11.4" r=".8"/>',
  print: '<path d="M4.5 6V2.5h7V6M4.5 11.5h-2v-5h11v5h-2"/><rect x="4.5" y="9.5" width="7" height="4"/>',
  star: '<path d="M8 2l1.8 3.8 4.2.55-3.05 2.9.75 4.15L8 11.3 4.3 13.4l.75-4.15L2 6.35l4.2-.55z"/>',
  starFill:
    '<path class="f" d="M8 2l1.8 3.8 4.2.55-3.05 2.9.75 4.15L8 11.3 4.3 13.4l.75-4.15L2 6.35l4.2-.55z"/><path d="M8 2l1.8 3.8 4.2.55-3.05 2.9.75 4.15L8 11.3 4.3 13.4l.75-4.15L2 6.35l4.2-.55z"/>',
  back: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
  next: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  latest: '<path d="M4 3.5L8.5 8 4 12.5M12 3.5v9"/>',
  mouse: '<rect x="4.5" y="2" width="7" height="12" rx="3.5"/><path d="M8 2v4.5"/>',
  split: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M8 3v10"/>',
  chevDown: '<path d="M3.5 6L8 10.5L12.5 6"/>',
  chevRight: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  chevUp: '<path d="M3.5 10L8 5.5l4.5 4.5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  clock: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75V8.25L10.25 9.75"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  copy:
    '<rect x="2.6" y="5.4" width="7.4" height="7.4" rx="1.5"/><path d="M5.6 5.4V3.6A1.6 1.6 0 0 1 7.2 2H11.8A1.6 1.6 0 0 1 13.4 3.6V8.2A1.6 1.6 0 0 1 11.8 9.8H10.4"/>',
  up: '<path d="M4 10l4-4 4 4"/>',
  down: '<path d="M4 6l4 4 4-4"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  reopen: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/>',
  download: '<path d="M8 2.5v7M5 7l3 3 3-3M3 12.5h10"/>',
  globe: '<circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5"/><ellipse cx="8" cy="8" rx="2.75" ry="6.25"/>',
  grip:
    '<g class="f"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></g>',
  sort: '<path d="M5 6.5L8 3l3 3.5M5 9.5L8 13l3-3.5"/>',
  orgchart:
    '<rect x="5.5" y="2" width="5" height="3.5" rx="1"/><path d="M8 5.5V8M4 10.5V8h8v2.5"/><rect x="1.75" y="10.5" width="4.5" height="3.5" rx="1"/><rect x="9.75" y="10.5" width="4.5" height="3.5" rx="1"/>',
  flag: '<path d="M4 14V2.5M4 3h8l-2 3 2 3H4"/>',
  alert: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.75v3"/><circle class="f" cx="8" cy="11.4" r=".8"/>',
  resolve: '<path d="M8 2l5 1.75v4c0 3-2.1 5-5 6.25C5.1 13.25 3 11.25 3 8.25v-4z"/><path d="M5.75 8l1.75 1.75 3-3.25"/>',
  folder: '<path d="M2.5 4.5a1 1 0 0 1 1-1h3L8 5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
  note: '<path d="M4 2.5h5.5l3 3v8H4zM9.5 2.5v3h3M6 8.5h4M6 11h4"/>',
  link:
    '<path d="M6.67 8.67a3.33 3.33 0 0 0 5.03.36l2-2a3.33 3.33 0 0 0-4.71-4.71l-1.15 1.14M9.33 7.33a3.33 3.33 0 0 0-5.03-.36l-2 2a3.33 3.33 0 0 0 4.71 4.71l1.14-1.14"/>',
  clearFmt: '<path d="M2.5 3.5h7M6 3.5v9M4.5 12.5h3M10.5 9l3.5 4M14 9l-3.5 4"/>',
  template: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 6h11M6.5 6v7.5"/>',
  at: '<circle cx="8" cy="8" r="2.67"/><path d="M10.67 5.33v3.33a2 2 0 0 0 4 0V8a6.67 6.67 0 1 0-2.67 5.33"/>',
  paragraph: '<path d="M9 3v10M12 3v10M12 3H6.25a3.25 3.25 0 0 0 0 6.5H9"/>',
  codeBlock:
    '<path d="M6.5 2.5C5 2.5 4.75 3.25 4.75 4.5v1.25C4.75 7 4 8 2.75 8 4 8 4.75 9 4.75 10.25v1.25c0 1.25.25 2 1.75 2M9.5 2.5C11 2.5 11.25 3.25 11.25 4.5v1.25C11.25 7 12 8 13.25 8 12 8 11.25 9 11.25 10.25v1.25c0 1.25-.25 2-1.75 2"/>',
  hr: '<path d="M2.5 8h11"/>',
  olist: '<path d="M7.5 4h6M7.5 8h6M7.5 12h6M2.75 4.25L4 3.25V6.5M2.75 8.75h2.5L2.75 12h2.5"/>',
  quote: '<path d="M3 3v10M6.5 5h6.5M6.5 8h6.5M6.5 11h4"/>',
  list: '<path d="M6 4h7M6 8h7M6 12h7"/><g class="f"><circle cx="3" cy="4" r="1"/><circle cx="3" cy="8" r="1"/><circle cx="3" cy="12" r="1"/></g>',
  // The four risk-plan outlines, the same shapes the risk matrix draws (circle, diamond, square, triangle).
  shapeCircle: '<circle cx="8" cy="8" r="4.75"/>',
  shapeDiamond: '<path d="M8 2.5l5.5 5.5L8 13.5 2.5 8z"/>',
  shapeSquare: '<rect x="3.4" y="3.4" width="9.2" height="9.2"/>',
  shapeTriangle: '<path d="M8 3l5.1 9H2.9z"/>',
  person: '<circle cx="8" cy="5.25" r="2.5"/><path d="M3 13.5c.5-2.6 2.5-4 5-4s4.5 1.4 5 4"/>',
  people:
    '<circle cx="6" cy="5.75" r="2.25"/><circle cx="11.5" cy="6.5" r="1.75"/><path d="M1.75 13c.4-2.3 2.1-3.6 4.25-3.6s3.85 1.3 4.25 3.6M10.5 9.6c1.9 0 3.2 1.1 3.75 3.1"/>',
  tasks: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 8.2l1.9 1.9 3.2-3.8"/>',
  fileAdd: '<path d="M4 2.5h5.5l3 3v8H4zM9.5 2.5v3h3M8.25 8v3.5M6.5 9.75H10"/>',
  offline: '<path d="M1.75 6.25a8.5 8.5 0 0 1 12.5 0M4 8.75a5.5 5.5 0 0 1 8 0M6.25 11.25a2.5 2.5 0 0 1 3.5 0M2.5 2.5l11 11"/><circle class="f" cx="8" cy="13.2" r=".8"/>',
  code: '<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3l-2 10"/>',
  cloud: '<path d="M4.75 12.5a3 3 0 0 1-.3-5.98A4 4 0 0 1 12 6.4a3.05 3.05 0 0 1-.25 6.1z"/>',
  window: '<rect x="2" y="3" width="12" height="9" rx="1.5"/><path d="M2 6h12M5.5 14h5"/>',
  refresh: '<path d="M13 8a5 5 0 0 1-8.7 3.4M3 8a5 5 0 0 1 8.7-3.4M11.8 2v2.8H9M4.2 14v-2.8H7"/>',
  tip: '<path d="M6 12.5h4M6.5 14h3M8 2a4.25 4.25 0 0 0-2.4 7.75c.4.3.65.75.65 1.25h3.5c0-.5.25-.95.65-1.25A4.25 4.25 0 0 0 8 2z"/>',
} as const

export type IconName = keyof typeof PATHS

// html[data-size=M] is 15px (styles.css); sizing in rem off that base makes the
// icons follow the font-size pref the way the emoji they replace did.
const REM_BASE_PX = 15

/** Markup string for `name` — for call sites that build `innerHTML` (e.g. icons swapped on state change). `size` is the rendered px at the default font size; the drawing grid stays 16×16. */
export function iconSvg(name: IconName, size = 14): string {
  const rem = +(size / REM_BASE_PX).toFixed(3)
  return (
    `<svg class="tt-icon-svg" viewBox="0 0 16 16" width="${size}" height="${size}" style="width:${rem}rem;height:${rem}rem" ` +
    `fill="none" stroke="currentColor" ` +
    `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`
  )
}

// Parsing SVG markup is the expensive part (a module render can mount dozens of
// icons, and the lifecycle stress test mounts hundreds of modules), so each
// name+size is parsed once and later calls clone the parsed span.
const CACHE = new Map<string, HTMLSpanElement>()

/** A list row with a leading stroke icon and its text — the start screen's and install card's bullet lines. */
export function iconLine(name: IconName, text: string, size = 16): HTMLLIElement {
  return el('li', { class: 'tt-icon-line' }, icon(name, size), el('span', {}, text))
}

/** A decorative (`aria-hidden`) icon span; the owning button carries the accessible name via `title`/`aria-label`. */
export function icon(name: IconName, size = 14): HTMLSpanElement {
  const key = `${name}:${size}`
  let proto = CACHE.get(key)
  if (!proto) {
    proto = el('span', { class: `tt-icon tt-icon-${name}`, 'aria-hidden': 'true' })
    proto.innerHTML = iconSvg(name, size)
    CACHE.set(key, proto)
  }
  return proto.cloneNode(true) as HTMLSpanElement
}

/** Swaps the icon inside an existing `icon()` span in place (favorite star, expander chevron…) without replacing the element, so listeners/focus on its parent stay put. */
export function setIcon(span: HTMLElement, name: IconName, size = 14): void {
  span.className = `tt-icon tt-icon-${name}`
  span.innerHTML = iconSvg(name, size)
}

type KindIconKey = SearchResult['moduleKind']

const KIND_ICON_NAME: Record<KindIconKey, IconName> = {
  daily: 'calendar', general: 'note', person: 'person', stakeholders: 'orgchart', members: 'people',
  actions: 'tasks', milestones: 'flag', risks: 'alert',
}

/**
 * The one icon each module kind wears everywhere the app names a module:
 * fast switch, search results, pane menu and tabs, @ picker, backlinks, due
 * list. Tinted per kind in styles.css (`.tt-kind-<kind>`), so a kind reads the
 * same color wherever it shows up.
 */
export function kindIcon(kind: KindIconKey, size = 14): HTMLSpanElement {
  const span = icon(KIND_ICON_NAME[kind], size)
  span.classList.add('tt-kind-icon', `tt-kind-${kind}`)
  return span
}
