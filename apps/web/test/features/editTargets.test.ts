import { describe, it, expect } from 'vitest'
import { lineAtPoint, imageAtPoint } from '@/features/patch/editTargets'
import type {
  EditObject, ImagePatchObject, PageImageIndex, PageQuadIndex, Quad, TextPatchObject,
} from '@margin/pdf-core'

/** One line of 10pt-wide characters, from (x, y) rightwards. */
function line(text: string, x: number, y: number) {
  return {
    bbox: [x, y, x + text.length * 10, y + 18] as [number, number, number, number],
    text,
    font: 'Test',
    bold: false,
    italic: false,
    color: [0, 0, 0] as [number, number, number],
    size: 12,
    baseline: y + 14,
    chars: [...text].map((char, i) => ({
      char,
      quad: [
        x + i * 10, y, x + 10 + i * 10, y,
        x + i * 10, y + 18, x + 10 + i * 10, y + 18,
      ] as Quad,
    })),
  }
}

/** 'Alpha' at 40,100..90,118 and 'Beta' at 40,200..80,218. */
const INDEX: PageQuadIndex = { lines: [line('Alpha', 40, 100), line('Beta', 40, 200)] }

const IMAGES: PageImageIndex = {
  images: [{ index: 0, bbox: [50, 50, 250, 150], width: 800, height: 400, hash: 'aaaa1111' }],
}

function textPatch(lineIndex: number, extra: Partial<TextPatchObject> = {}): EditObject {
  return {
    id: `t${lineIndex}`,
    pageId: 'p1',
    kind: 'textPatch',
    lineIndex,
    originalHash: 'h',
    originalText: 'Alpha',
    text: 'Alpha',
    fontFamily: 'Inter',
    bold: false,
    italic: false,
    fontSize: 12,
    baseline: 114,
    color: [0, 0, 0],
    background: [1, 1, 1],
    backgroundConfidence: 1,
    fit: 'overflow',
    rect: { x: 40, y: 100, w: 50, h: 18 },
    rotation: 0,
    z: 1,
    locked: false,
    opacity: 1,
    ...extra,
  } as EditObject
}

function imagePatch(imageIndex: number, extra: Partial<ImagePatchObject> = {}): EditObject {
  return {
    id: `i${imageIndex}`,
    pageId: 'p1',
    kind: 'imagePatch',
    imageIndex,
    originalHash: 'aaaa1111',
    background: [1, 1, 1],
    backgroundConfidence: 1,
    rect: { x: 50, y: 50, w: 200, h: 100 },
    rotation: 0,
    z: 1,
    locked: false,
    opacity: 1,
    ...extra,
  } as EditObject
}

describe('lineAtPoint', () => {
  it('finds the line the point is inside', () => {
    expect(lineAtPoint(INDEX, [], 'p1', 60, 110)).toBe(0)
    expect(lineAtPoint(INDEX, [], 'p1', 60, 210)).toBe(1)
  })

  /**
   * The whole reason this is not `charAt`.
   *
   * `charAt` answers with the NEAREST character however far away it is,
   * which is right for dragging a selection and catastrophic for a
   * double-click: it would open an editor on a line halfway up the page
   * because the user double-clicked a margin.
   */
  it('finds nothing on blank paper', () => {
    expect(lineAtPoint(INDEX, [], 'p1', 400, 500)).toBeUndefined()
  })

  it('finds nothing in the leading between two lines', () => {
    expect(lineAtPoint(INDEX, [], 'p1', 60, 150)).toBeUndefined()
  })

  it('finds nothing past the end of a line', () => {
    expect(lineAtPoint(INDEX, [], 'p1', 300, 110)).toBeUndefined()
  })

  it('ignores a line the extraction found no characters on', () => {
    const empty: PageQuadIndex = { lines: [{ ...line('', 40, 100), chars: [] }] }
    expect(lineAtPoint(empty, [], 'p1', 60, 110)).toBeUndefined()
  })

  /**
   * A line that has been dragged is hit where the user can SEE it, not
   * where the document originally put it -- the same rule `PatchEditor`
   * applies to its own click targets.
   */
  it('follows a line the user has moved', () => {
    const objects = [textPatch(0, { offset: { dx: 100, dy: 50 } })]
    expect(lineAtPoint(INDEX, objects, 'p1', 60, 110)).toBeUndefined()
    expect(lineAtPoint(INDEX, objects, 'p1', 160, 160)).toBe(0)
  })

  /** A patch on another page must not move this page's line. */
  it('ignores a patch belonging to a different page', () => {
    const objects = [textPatch(0, { pageId: 'p2', offset: { dx: 100, dy: 50 } })]
    expect(lineAtPoint(INDEX, objects, 'p1', 60, 110)).toBe(0)
  })

  /**
   * Typed text that runs past the original line stays clickable along its
   * whole length. Measurement is injected because jsdom has no canvas to
   * measure with -- in the browser this is the font the export will use.
   */
  it('covers text that has overflowed the original line', () => {
    const objects = [textPatch(0, { text: 'Alpha and a great deal more' })]
    const measure = () => 300
    expect(lineAtPoint(INDEX, objects, 'p1', 200, 110, measure)).toBe(0)
    expect(lineAtPoint(INDEX, objects, 'p1', 400, 110, measure)).toBeUndefined()
  })

  it('does not widen a line whose text is cut off rather than allowed to run', () => {
    const objects = [textPatch(0, { text: 'Alpha and a great deal more', fit: 'truncate' })]
    expect(lineAtPoint(INDEX, objects, 'p1', 200, 110, () => 300)).toBeUndefined()
  })
})

describe('imageAtPoint', () => {
  it('finds the image the point is inside', () => {
    expect(imageAtPoint(IMAGES, [], 'p1', 100, 100)).toBe(0)
  })

  it('finds nothing off the image', () => {
    expect(imageAtPoint(IMAGES, [], 'p1', 400, 400)).toBeUndefined()
  })

  it('follows an image the user has moved', () => {
    const objects = [imagePatch(0, { offset: { dx: 100, dy: 0 } })]
    expect(imageAtPoint(IMAGES, objects, 'p1', 60, 100)).toBeUndefined()
    expect(imageAtPoint(IMAGES, objects, 'p1', 160, 100)).toBe(0)
  })

  it('follows an image the user has resized', () => {
    const objects = [imagePatch(0, { size: { w: 20, h: 20 } })]
    expect(imageAtPoint(IMAGES, objects, 'p1', 55, 55)).toBe(0)
    expect(imageAtPoint(IMAGES, objects, 'p1', 240, 140)).toBeUndefined()
  })

  it('ignores a patch belonging to a different page', () => {
    const objects = [imagePatch(0, { pageId: 'p2', offset: { dx: 100, dy: 0 } })]
    expect(imageAtPoint(IMAGES, objects, 'p1', 100, 100)).toBe(0)
  })
})
