import { nanoid } from 'nanoid'
import { resolveTokens, batesNumber, type StampObject, type EditObject } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'
import { stampRect, alignFor, type StampSettings } from './stampPresets'

/**
 * How wide the stamp's box should be, in points.
 *
 * The box is what the text is aligned WITHIN, so for a left- or
 * right-anchored stamp it wants to be the text's own width -- a full-width
 * box would push a right-aligned footer to the page edge regardless of the
 * margin. Estimated rather than measured: the exact advance needs the font,
 * which lives in the worker, and being a few points out only shifts a
 * centred stamp by half that.
 */
const CHAR_WIDTH_RATIO = 0.55

function estimateWidth(text: string, fontSize: number): number {
  return Math.max(1, text.length * fontSize * CHAR_WIDTH_RATIO)
}

/**
 * Turn one stamp specification into the objects it produces, one per page.
 *
 * Tokens are resolved HERE rather than in the writer, so what is stored is
 * the finished text for each page. That keeps replay a pure function of the
 * edit document: an export does not need to know the page count, the file
 * name, or what today's date was when the stamp was applied -- which also
 * means a document stamped "3 of 12" still says "3 of 12" after a page is
 * deleted, rather than silently renumbering itself in the exported file
 * while the editor shows something else.
 *
 * `pages` is the SUBSET being stamped; `allPages` is the whole document, so
 * {n} and {total} count the document rather than the selection. Someone
 * stamping pages 3-5 of a 12-page report wants "3 of 12", not "1 of 3".
 */
export function buildStamps(
  settings: StampSettings,
  pages: PageState[],
  allPages: PageState[],
  fileName: string,
  date: string,
  nextZ: () => number,
): StampObject[] {
  return pages.map((page) => {
    const pageNumber = allPages.findIndex((p) => p.id === page.id) + 1
    // The Bates counter follows the SELECTION, not the document: a
    // production numbered 1..n counts the pages actually produced.
    const batesIndex = pages.findIndex((p) => p.id === page.id)

    const text = resolveTokens(settings.template, {
      pageNumber,
      pageCount: allPages.length,
      fileName,
      date,
      bates: batesNumber(batesIndex, settings.bates),
    })

    const width = estimateWidth(text, settings.fontSize)
    const height = settings.fontSize * 1.4
    const rect = stampRect(page.geometry, settings.position, settings.margin, width, height)

    return {
      id: nanoid(10),
      pageId: page.id,
      kind: 'stamp',
      stampKind: settings.kind,
      text,
      rect,
      rotation: settings.rotation,
      z: nextZ(),
      locked: false,
      opacity: settings.opacity,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      color: settings.color,
      align: alignFor(settings.position),
      behind: settings.behind,
    }
  })
}

/** The objects as an EditObject[], for the store. */
export const asEditObjects = (stamps: StampObject[]): EditObject[] => stamps as EditObject[]
