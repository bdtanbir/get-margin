import * as mupdf from 'mupdf'

/**
 * Which `U+FFFD` characters on a page draw nothing at all.
 *
 * MuPDF reports a glyph it cannot name as U+FFFD. Most of the time that is
 * a real, visible letter in a font with no Unicode table, and it has to stay
 * in the line. But a broken PDF can also be full of glyphs with no outline:
 * the Turnitin page that prompted this had its /F1 overwritten with Inter,
 * so a heading's two-byte codes were read one byte at a time and every 0x00
 * byte became Inter's empty "null" glyph or its `.notdef`. The page shows
 * `^^/'EDEdÌ`; extraction said `�^�^�/�'�E�D�E�d�Ì�`, and that is what the
 * edit field, the layer name and the missing-glyph warning all showed.
 * Sejda shows `^^/'EDEdÌ`.
 *
 * A character is invisible when it is U+FFFD AND every glyph drawn at its
 * pen position is either glyph 0 (`.notdef`, which the viewer blanks -- see
 * notdef.ts) or has an empty outline: one whose bounds reach no further
 * than a point either side of the pen. Glyph 0 counts by its NUMBER, not its
 * outline, so the answer is the same in the viewing document (where it has
 * been blanked) and in the export (where it has not) -- the two must agree,
 * or the export's hash guard refuses the edit.
 *
 * Real characters are never touched: a space or any named glyph is not
 * U+FFFD, and a U+FFFD glyph with ink is kept.
 *
 * Lazy: the page is only walked the first time a U+FFFD shows up, so a page
 * without one pays nothing.
 */
export function invisibleCharTest(page: mupdf.Page): (origin: ArrayLike<number>) => boolean {
  let glyphs: Array<{ x: number; y: number; visible: boolean }> | undefined

  const collect = (): Array<{ x: number; y: number; visible: boolean }> => {
    const found: Array<{ x: number; y: number; visible: boolean }> = []
    const walk = (text: mupdf.Text, ctm: mupdf.Matrix): void => {
      text.walk({
        showGlyph(font, trm, gid, unicode) {
          if (unicode !== 0xfffd) return
          const at = mupdf.Matrix.concat(trm, ctm)
          let visible = false
          if (gid !== 0) {
            const one = new mupdf.Text()
            try {
              one.showGlyph(font, trm, gid, unicode)
              // An empty outline bounds to the pen position itself -- or,
              // depending on how MuPDF loaded the font, to a 2x2 box around
              // it. Anything reaching further has ink.
              const [x0, y0, x1, y1] = one.getBounds(null as never, ctm)
              const slack = 1.01
              visible = x0! < at[4]! - slack || x1! > at[4]! + slack ||
                y0! < at[5]! - slack || y1! > at[5]! + slack
            } finally {
              one.destroy()
            }
          }
          found.push({ x: at[4]!, y: at[5]!, visible })
        },
      })
    }
    const device = new mupdf.Device({
      fillText: walk,
      strokeText: (text, _stroke, ctm) => walk(text, ctm),
      clipText: walk,
      clipStrokeText: (text, _stroke, ctm) => walk(text, ctm),
      ignoreText: walk,
    })
    try {
      page.run(device, mupdf.Matrix.identity)
      device.close()
    } catch {
      // Nothing found means nothing hidden: the safe answer.
    } finally {
      device.destroy()
    }
    return found
  }

  return (origin) => {
    glyphs ??= collect()
    const x = origin[0] ?? 0
    const y = origin[1] ?? 0
    let any = false
    for (const g of glyphs) {
      if (Math.abs(g.x - x) > 0.05 || Math.abs(g.y - y) > 0.05) continue
      if (g.visible) return false
      any = true
    }
    return any
  }
}

/**
 * Indices of a line's characters to leave out of its text: the invisible
 * U+FFFD ones -- unless that is all of them, in which case none. A line is
 * never emptied, because the export addresses lines by position and an
 * extraction that skipped one would point every later edit at the wrong
 * line.
 */
export function hiddenIndices(
  chars: ReadonlyArray<{ char: string; origin: ArrayLike<number> }>,
  invisible: (origin: ArrayLike<number>) => boolean,
): Set<number> {
  const hidden = new Set<number>()
  chars.forEach((c, i) => {
    if (c.char === '�' && invisible(c.origin)) hidden.add(i)
  })
  return hidden.size === chars.length ? new Set() : hidden
}
