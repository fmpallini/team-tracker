// src/ui/tab-rail.ts — the vertical tab rail Preferences and Help share: a
// tablist of full-width rows beside a tabpanel, with a roving tabindex.
//
// Arrow keys only move focus (Enter/Space then activates, as for any button):
// activating on focus would rebuild a tab for every tab the user merely passes
// over. The caller owns what a tab *shows* (`onSelect`); the rail owns which
// one is current, the ARIA wiring and the keyboard.
import { el } from './dom'

export interface TabRailTab<Id extends string> {
  id: Id
  label: string
  /** Extra content after the label (a badge), laid out beside it. */
  extra?: Node
}

export interface TabRail<Id extends string> {
  /** The tablist, to be placed before `panel` in the dialog body. */
  tabs: HTMLElement
  /** The tabpanel the caller renders the current tab into. */
  panel: HTMLElement
  readonly active: Id
  /** Makes `id` current without calling `onSelect` — the caller renders it. */
  select(id: Id): void
  focusActive(): void
}

export function createTabRail<Id extends string>(opts: {
  /** Prefix of the DOM ids: `<prefix>-panel` and `<prefix>-tab-<id>`. */
  idPrefix: string
  tabs: readonly TabRailTab<Id>[]
  initial: Id
  /** Called after a click made `id` current; `changed` is false when it already was. */
  onSelect: (id: Id, changed: boolean) => void
}): TabRail<Id> {
  const panelId = `${opts.idPrefix}-panel`
  const tabDomId = (id: Id): string => `${opts.idPrefix}-tab-${id}`
  const ids = opts.tabs.map((tab) => tab.id)
  const buttons = new Map<Id, HTMLButtonElement>()
  const panel = el('div', { class: 'tt-prefs-content', role: 'tabpanel', id: panelId })
  let active = opts.initial

  function paint(): void {
    for (const [id, btn] of buttons) {
      const on = id === active
      btn.classList.toggle('active', on)
      btn.setAttribute('aria-selected', String(on))
      // Roving tabindex: Tab enters the strip once, arrow keys move within it.
      btn.tabIndex = on ? 0 : -1
    }
    panel.setAttribute('aria-labelledby', tabDomId(active))
  }

  function onKeydown(e: KeyboardEvent): void {
    const from = ids.indexOf(active)
    const focused = ids.find((id) => buttons.get(id) === document.activeElement)
    const at = focused !== undefined ? ids.indexOf(focused) : from
    let next: number
    // The strip is a vertical rail, so Up/Down are the natural keys; Left/Right keep working as before.
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (at + 1) % ids.length
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (at - 1 + ids.length) % ids.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = ids.length - 1
    else return
    e.preventDefault()
    const target = buttons.get(ids[next]!)
    if (!target) return
    for (const btn of buttons.values()) btn.tabIndex = btn === target ? 0 : -1
    target.focus()
  }

  const tabs = el(
    'div',
    { class: 'tt-prefs-tabs', role: 'tablist', 'aria-orientation': 'vertical', onkeydown: (e: Event) => onKeydown(e as KeyboardEvent) },
    ...opts.tabs.map(({ id, label, extra }) => {
      const btn = el(
        'button',
        {
          class: 'tt-btn tt-prefs-tab-btn',
          type: 'button',
          role: 'tab',
          id: tabDomId(id),
          'aria-controls': panelId,
          onclick: () => {
            const changed = active !== id
            active = id
            paint()
            opts.onSelect(id, changed)
          },
        },
        label,
        extra ?? null
      )
      buttons.set(id, btn)
      return btn
    })
  )
  paint()

  return {
    tabs,
    panel,
    get active() { return active },
    select(id) {
      active = id
      paint()
    },
    focusActive() { buttons.get(active)?.focus() },
  }
}
