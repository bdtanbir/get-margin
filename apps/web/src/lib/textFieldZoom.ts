/**
 * iOS Safari zooms the whole page when a field it is focusing draws text
 * below 16px, on the assumption that anything smaller is unreadable. It is
 * not a preference and there is no opt-out: `user-scalable=no` is ignored
 * in Safari, and disabling page zoom would take pinch-to-zoom away from
 * everyone to fix a problem with one field.
 *
 * The document's text is whatever size the document says -- a 9pt line at
 * 60% zoom draws at 5px -- so an editor sitting on the page is under the
 * threshold most of the time. Tapping a line to correct a word would fling
 * the viewport to a random magnification, and getting back was manual.
 *
 * The way out is to give the browser the 16px it is looking for and undo it
 * visually: set the font to the threshold and scale the element down by the
 * same factor. The glyphs are rasterised at 16px and drawn smaller, which
 * also renders slightly crisper than the equivalent small font.
 */
export const IOS_MIN_FONT_PX = 16

export type TextFieldSize = {
  /** What to put in `font-size`. Never below the threshold. */
  fontSize: number
  /** What to put in `transform: scale()`. Never above 1. */
  scale: number
}

/**
 * `desiredPx` is how large the text should APPEAR, in CSS pixels.
 *
 * A caller that scales an element must also divide its width and height by
 * `scale`, or the box will shrink along with the text it contains.
 */
export function noZoomTextSize(desiredPx: number): TextFieldSize {
  // A non-finite or non-positive size means nothing has been measured yet,
  // or the line is degenerate. Scaling by zero would collapse the field to
  // an invisible caret, which is worse than the zoom this exists to avoid.
  const desired = Number.isFinite(desiredPx) && desiredPx > 0 ? desiredPx : IOS_MIN_FONT_PX
  if (desired >= IOS_MIN_FONT_PX) return { fontSize: desired, scale: 1 }
  return { fontSize: IOS_MIN_FONT_PX, scale: desired / IOS_MIN_FONT_PX }
}
