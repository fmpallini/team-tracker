import { describe, it, expect } from 'vitest'
import { attachEmojiPicker, emojiCategories } from '../src/ui/emoji-picker'

describe('emoji picker', () => {
  it('has curated categories', () => {
    const cats = emojiCategories()
    expect(cats.length).toBeGreaterThanOrEqual(4)
    expect(cats.flatMap(c => c.emojis).length).toBeGreaterThan(80)
  })
  it('opens on focus and picks into the input', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    const handle = attachEmojiPicker(input, 'en-US')
    input.dispatchEvent(new FocusEvent('focus'))
    const first = document.querySelector('.tt-emoji-grid button') as HTMLButtonElement
    expect(first).not.toBeNull()
    let inputFired = false
    input.addEventListener('input', () => { inputFired = true })
    first.click()
    expect(input.value).toBe(first.textContent)
    expect(inputFired).toBe(true)
    expect(document.querySelector('.tt-emoji-popup')).toBeNull()
    handle.dispose()
  })
})
