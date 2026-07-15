// src/ui/emoji-picker.ts — curated emoji picker popup for team emoji fields
// (add/edit team modals). Overlay discipline mirrors atref.ts: document-level
// `mousedown` capture to close, positioned near the input via
// `getBoundingClientRect`, all listeners removed in `dispose`.
import { t, type Locale, type MsgKey } from '../core/i18n'
import { el } from './dom'

const CATEGORIES: { key: MsgKey; emojis: string[] }[] = [
  {
    key: 'emoji_cat_people',
    emojis: ['🙂', '😀', '😎', '🤓', '🧐', '🤠', '👋', '💪', '🧠', '👀', '🧑‍💻', '🧑‍🔧', '🧑‍🎨', '🧑‍🚀', '🦸', '🥷', '🧑‍🏫', '🧑‍⚕️', '🧑‍🍳', '🧑‍🌾', '🧑‍✈️', '🧙', '🤝', '🙌'],
  },
  {
    key: 'emoji_cat_teams',
    emojis: ['🚀', '⚡', '🔥', '⭐', '🌟', '💫', '🏆', '🥇', '🎯', '🛡️', '⚙️', '🔧', '🧩', '🗺️', '🧭', '🏗️', '📣', '🏁', '🧱', '🪁', '🎖️', '🥈', '🥉', '🏅'],
  },
  {
    key: 'emoji_cat_nature',
    emojis: ['🦁', '🐯', '🐺', '🦅', '🦉', '🐙', '🐝', '🦄', '🐉', '🌊', '🌋', '🌈', '🌱', '🌵', '🍀', '🌸', '🌻', '🌙', '☀️', '🐚', '🐢', '🦋', '🐬', '🌲'],
  },
  {
    key: 'emoji_cat_objects',
    emojis: ['💼', '📦', '📚', '🔬', '🔭', '💡', '🔑', '🗝️', '⚗️', '🧪', '🎲', '🎮', '🎨', '🎵', '📈', '💎', '🖥️', '📱', '📌', '🧮', '🗂️', '🧰', '🛠️', '🔗'],
  },
]

export function emojiCategories(): { key: MsgKey; emojis: string[] }[] {
  return CATEGORIES
}

export interface EmojiPickerHandle {
  /** Closes the popup and removes all document/element listeners this instance attached. Idempotent. */
  dispose(): void
}

/**
 * A team emoji is exactly one grapheme cluster, which `maxlength` cannot
 * express: it counts UTF-16 code units, so two simple emojis (2 units each)
 * fit inside `maxlength="4"` while a single ZWJ emoji like 🧑‍💻 (5 units)
 * gets blocked. The field keeps the LAST grapheme because the edit modal
 * prefills the current emoji — an OS-picker (Win+. / Cmd+Ctrl+Space)
 * insertion appends at the caret, and the newest choice must win.
 */
function lastGrapheme(value: string): string {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    let last = ''
    for (const s of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
      last = s.segment
    }
    return last
  }
  // No Segmenter: fall back to code points — splits ZWJ sequences, but still
  // guarantees "one emoji" for the common non-ZWJ case.
  const points = Array.from(value)
  return points[points.length - 1] ?? ''
}

export function attachEmojiPicker(input: HTMLInputElement, locale: Locale): EmojiPickerHandle {
  let popup: HTMLElement | null = null
  let activeCat = 0

  function positionPopup(): void {
    // jsdom's Element does not implement layout (real browsers always do) —
    // guard so tests can exercise the popup lifecycle without a
    // layout-capable DOM.
    if (!popup || typeof input.getBoundingClientRect !== 'function') return
    const rect = input.getBoundingClientRect()
    popup.style.position = 'fixed'
    popup.style.left = `${rect.left}px`
    popup.style.top = `${rect.bottom}px`
  }

  function renderPopup(): void {
    if (!popup) return
    popup.innerHTML = ''
    const tabs = el('div', { class: 'tt-emoji-tabs' })
    CATEGORIES.forEach((cat, i) => {
      tabs.appendChild(
        el(
          'button',
          {
            type: 'button',
            class: 'tt-emoji-tab' + (i === activeCat ? ' selected' : ''),
            onmousedown: (e: Event) => e.preventDefault(),
            onclick: () => { activeCat = i; renderPopup() },
          },
          t(locale, cat.key)
        )
      )
    })
    const grid = el('div', { class: 'tt-emoji-grid' })
    for (const emoji of CATEGORIES[activeCat]!.emojis) {
      grid.appendChild(
        el(
          'button',
          {
            type: 'button',
            onmousedown: (e: Event) => e.preventDefault(),
            onclick: () => pick(emoji),
          },
          emoji
        )
      )
    }
    const hint = el('div', { class: 'tt-emoji-hint' }, t(locale, 'emoji_os_hint'))
    popup.appendChild(tabs)
    popup.appendChild(grid)
    popup.appendChild(hint)
  }

  function pick(emoji: string): void {
    input.value = emoji
    input.dispatchEvent(new Event('input', { bubbles: true }))
    close()
  }

  function onDocMousedown(e: MouseEvent): void {
    if (popup?.contains(e.target as Node) || e.target === input) return
    close()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  function onFocus(): void {
    open()
  }

  function open(): void {
    if (popup) return
    activeCat = 0
    popup = el('div', { class: 'tt-emoji-popup' })
    document.body.appendChild(popup)
    renderPopup()
    positionPopup()
    document.addEventListener('mousedown', onDocMousedown, true)
    document.addEventListener('keydown', onKeydown, true)
  }

  function close(): void {
    if (!popup) return
    popup.remove()
    popup = null
    document.removeEventListener('mousedown', onDocMousedown, true)
    document.removeEventListener('keydown', onKeydown, true)
  }

  function onInput(): void {
    const single = lastGrapheme(input.value.trim())
    if (input.value !== single) input.value = single
  }

  input.addEventListener('focus', onFocus)
  input.addEventListener('input', onInput)

  return {
    dispose(): void {
      close()
      input.removeEventListener('focus', onFocus)
      input.removeEventListener('input', onInput)
    },
  }
}
