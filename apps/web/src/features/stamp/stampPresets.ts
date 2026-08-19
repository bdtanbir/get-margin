import type { StampObject } from '@margin/pdf-core'
import { pageSizePt, type PageGeometry } from '@margin/transform'

export type StampKind = StampObject['stampKind']

/**
 * Where a stamp sits on the page, as a nine-box grid plus a margin.
 *
 * A grid rather than free coordinates because a stamp is a document-wide
 * decision: "bottom centre on every page" survives pages of different sizes,
 * and "at x=306, y=40" does not.
 */
export type StampPosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'middle-left' | 'center' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right'

export type BatesSettings = {
  start: number
  step: number
  digits: number
  prefix: string
  suffix: string
}

export type StampSettings = {
  kind: StampKind
  template: string
  position: StampPosition
  margin: number
  fontFamily: string
  fontSize: number
  color: [number, number, number]
  opacity: number
  rotation: number
  behind: boolean
  bates: BatesSettings
}

const NO_BATES: BatesSettings = { start: 1, step: 1, digits: 6, prefix: '', suffix: '' }

/**
 * The five presets.
 *
 * These differ ONLY in defaults -- one writer and one object kind sit behind
 * all of them. A watermark is a large, faint, rotated, centred stamp drawn
 * beneath the page; a footer is a small opaque one at the bottom drawn over
 * it. Naming them separately is a UI affordance, not an implementation
 * split, which is what keeps the five from drifting into five behaviours.
 */
export const PRESETS: Record<StampKind, StampSettings> = {
  watermark: {
    kind: 'watermark',
    template: 'CONFIDENTIAL',
    position: 'center',
    margin: 0,
    fontFamily: 'Inter',
    fontSize: 60,
    color: [0.5, 0.5, 0.5],
    opacity: 0.25,
    rotation: 45,
    // Beneath the page's content, so it marks the document without
    // obscuring what is being marked.
    behind: true,
    bates: NO_BATES,
  },
  pageNumber: {
    kind: 'pageNumber',
    template: '{n}',
    position: 'bottom-center',
    margin: 28,
    fontFamily: 'Inter',
    fontSize: 10,
    color: [0.2, 0.2, 0.2],
    opacity: 1,
    rotation: 0,
    behind: false,
    bates: NO_BATES,
  },
  header: {
    kind: 'header',
    template: '{filename}',
    position: 'top-center',
    margin: 28,
    fontFamily: 'Inter',
    fontSize: 10,
    color: [0.2, 0.2, 0.2],
    opacity: 1,
    rotation: 0,
    behind: false,
    bates: NO_BATES,
  },
  footer: {
    kind: 'footer',
    template: '{n} of {total}',
    position: 'bottom-center',
    margin: 28,
    fontFamily: 'Inter',
    fontSize: 10,
    color: [0.2, 0.2, 0.2],
    opacity: 1,
    rotation: 0,
    behind: false,
    bates: NO_BATES,
  },
  bates: {
    kind: 'bates',
    template: '{bates}',
    position: 'bottom-right',
    margin: 28,
    fontFamily: 'Inter',
    fontSize: 9,
    color: [0, 0, 0],
    opacity: 1,
    rotation: 0,
    behind: false,
    bates: NO_BATES,
  },
}

export const PRESET_LABELS: Record<StampKind, string> = {
  watermark: 'Watermark',
  pageNumber: 'Page numbers',
  header: 'Header',
  footer: 'Footer',
  bates: 'Bates numbering',
}

export const PRESET_ORDER: StampKind[] = ['watermark', 'pageNumber', 'header', 'footer', 'bates']

/**
 * The stamp's box on one page, in RAW PDF user space -- bottom-up, and NOT
 * normalised to the CropBox origin, because that is what every EditObject
 * rect is and what the writer's toContentSpace expects.
 *
 * The CropBox origin is added back deliberately. A page whose box starts at
 * (50, -35) needs its bottom-centre stamp at x = 50 + margin, not at
 * 0 + margin, or the stamp lands off the visible page entirely. Phase 5's
 * field writer learned the same lesson from the other direction, and the
 * offset-cropbox fixture exists to keep both honest.
 *
 * The UNROTATED extent is used, because the rect is raw user space and
 * /Rotate is a display transform the viewer applies afterwards.
 */
export function stampRect(
  geometry: PageGeometry,
  position: StampPosition,
  margin: number,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const [ox, oy] = geometry.cropBox
  const { w: pw, h: ph } = pageSizePt(geometry)

  const parts = position.split('-')
  const vertical = parts[0]!
  const horizontal = parts[1] ?? 'center'

  const x = horizontal === 'left' ? ox + margin
    : horizontal === 'right' ? ox + pw - margin - width
      : ox + (pw - width) / 2

  const y = vertical === 'bottom' ? oy + margin
    : vertical === 'top' ? oy + ph - margin - height
      : oy + (ph - height) / 2

  return { x, y, w: width, h: height }
}

/** Where the text sits within the stamp's own box. */
export function alignFor(position: StampPosition): 'left' | 'center' | 'right' {
  if (position.endsWith('left')) return 'left'
  if (position.endsWith('right')) return 'right'
  return 'center'
}
