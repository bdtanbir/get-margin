import * as mupdf from 'mupdf'

/**
 * Two-state appearance streams for buttons.
 *
 * WHY THIS FILE EXISTS AT ALL. Phase 0 measured that mupdf auto-generates
 * /AP appearance streams for every field type "including two-state checkbox
 * appearances -- the fiddly part nobody had to hand-build", and the spec
 * inferred radio groups would inherit that. They do not, and the Phase 5
 * pre-flight measured the difference
 * (docs/findings/12-phase-5-preflight.md 1).
 *
 * mupdf derives a button's ON-STATE NAME from the keys of its /AP /N
 * dictionary. A radio kid with no /AP has no name to derive, so it falls
 * back to "Yes" -- and three kids all called "Yes" are, as far as the format
 * is concerned, ONE button. Toggling any of them turns on all of them.
 * Nothing throws; the file is structurally valid and simply wrong.
 *
 * So the on-state stream is not decoration. It is where the button's
 * identity is stored, and building it is the only way to have a radio group
 * that behaves like one.
 *
 * Checkboxes go through the same path even though mupdf would generate
 * theirs, because one appearance code path is easier to reason about than
 * two and the cost is a dozen lines.
 */

/** A /Subtype /Form XObject with the given content, sized to the widget. */
function formXObject(
  raw: mupdf.PDFDocument,
  w: number,
  h: number,
  content: string,
): mupdf.PDFObject {
  const dict = raw.newDictionary()
  dict.put('Type', raw.newName('XObject'))
  dict.put('Subtype', raw.newName('Form'))
  const bbox = raw.newArray()
  for (const n of [0, 0, w, h]) bbox.push(n)
  dict.put('BBox', bbox)
  // An empty resource dictionary rather than none: a form XObject with no
  // /Resources is legal but makes some viewers fall back to the page's,
  // which is a surprising place for a checkbox to inherit state from.
  dict.put('Resources', raw.newDictionary())
  return raw.addStream(content, dict)
}

/**
 * The "on" appearance: a filled dot, inset from the border.
 *
 * A dot rather than a checkmark because it reads correctly for both a radio
 * button and a checkbox, and because a mark built from line segments needs
 * a stroke width that looks wrong at more sizes than it looks right at.
 */
export function onAppearance(raw: mupdf.PDFDocument, w: number, h: number): mupdf.PDFObject {
  const cx = w / 2
  const cy = h / 2
  const r = Math.max(1, Math.min(w, h) / 2 - 2)
  // Four Bezier arcs. PDF has no circle operator, and the magic constant is
  // the standard 4/3*(sqrt(2)-1) circle-to-Bezier approximation.
  const k = r * 0.5523
  const content =
    '0 g\n' +
    `${cx + r} ${cy} m\n` +
    `${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c\n` +
    `${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c\n` +
    `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c\n` +
    `${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c\n` +
    'f\n'
  return formXObject(raw, w, h, content)
}

/**
 * The "off" appearance: empty.
 *
 * Empty, and NOT absent. The border a user sees around an unchecked box
 * comes from the widget's /MK /BC, not from here -- Phase 0 measured that
 * omitting /MK /BC renders the unchecked state invisibly, which is
 * structurally correct and looks like a missing field.
 */
export function offAppearance(raw: mupdf.PDFDocument, w: number, h: number): mupdf.PDFObject {
  return formXObject(raw, w, h, '')
}

/**
 * The /AP dictionary for a two-state button.
 *
 * `onState` is the button's export value, and it is the load-bearing
 * argument: it becomes the key mupdf reads the button's identity from. Two
 * buttons in one group must never be given the same one.
 */
export function twoStateAppearance(
  raw: mupdf.PDFDocument,
  w: number,
  h: number,
  onState: string,
): mupdf.PDFObject {
  const n = raw.newDictionary()
  n.put(onState, onAppearance(raw, w, h))
  n.put('Off', offAppearance(raw, w, h))
  const ap = raw.newDictionary()
  ap.put('N', raw.addObject(n))
  return raw.addObject(ap)
}
