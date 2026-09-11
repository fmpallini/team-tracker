// src/core/popover-place.ts — where a fixed-position popover should sit
// relative to its anchor so it stays inside the viewport. Pure: the DOM
// caller (src/ui/date-picker.ts) measures the rects and applies the result.

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

export interface Size {
  width: number
  height: number
}

/**
 * Preferred placement is flush under the anchor's bottom-left corner, `gap`
 * px below it. If that overflows the viewport's bottom, flip to `gap` px
 * above the anchor's top instead; if the flipped position would push the
 * popover's own top off the top edge, clamp it to `margin` (showing the
 * popover's start is more useful than its end). Horizontally, keep the
 * popover's right edge within `margin` of the viewport, then floor its left
 * at `margin`.
 */
export function placePopover(
  anchor: Box,
  size: Size,
  viewport: Size,
  gap = 4,
  margin = 8,
): { left: number; top: number } {
  let top = anchor.bottom + gap
  if (top + size.height > viewport.height - margin) {
    const flipped = anchor.top - gap - size.height
    top = flipped >= margin ? flipped : margin
  }

  let left = anchor.left
  if (left + size.width > viewport.width - margin) {
    left = viewport.width - margin - size.width
  }
  if (left < margin) left = margin

  return { left, top }
}
