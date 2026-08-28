import type { Component } from 'vue'
import type { ObjectKind } from '@margin/pdf-core'
import RectObject from './RectObject.vue'
import EllipseObject from './EllipseObject.vue'
import LineObject from './LineObject.vue'
import ArrowObject from './ArrowObject.vue'
import WhiteoutObject from './WhiteoutObject.vue'
import TextObject from './TextObject.vue'
import ImageObject from './ImageObject.vue'
import InkObject from './InkObject.vue'
import LinkObject from './LinkObject.vue'
import FieldObject from './FieldObject.vue'

/**
 * Kind -> the component that draws it, for objects in raw PDF space.
 *
 * A separate module from `ObjectLayer.vue` so a test can read it. That is
 * the whole reason it moved: three kinds had been added to the format over
 * three phases with no renderer here, and each one produced an object that
 * exported perfectly and drew NOTHING on screen — a signature you could
 * select, drag and download but never see. Nothing failed, because an
 * unregistered kind renders nothing rather than throwing, and no test could
 * enumerate what was missing while this table was private to a component.
 *
 * `objectRenderers.test.ts` now checks this against `OBJECT_KINDS`, so a
 * kind added to the format without a renderer fails immediately.
 */
export const COMPONENTS: Partial<Record<ObjectKind, Component>> = {
  rect: RectObject,
  ellipse: EllipseObject,
  line: LineObject,
  arrow: ArrowObject,
  whiteout: WhiteoutObject,
  text: TextObject,
  image: ImageObject,
  ink: InkObject,
  link: LinkObject,
  field: FieldObject,

  /**
   * A signature is a raster placed on the page, exactly like an image —
   * `WRITERS.signature = writeImage` says so on the export side, and the
   * preview has no business disagreeing with it.
   */
  signature: ImageObject,

  /**
   * A stamp is a single line of text: same baseline formula, same alignment
   * offset as `TextObject`, which `write/objects/stamp.ts` shares with
   * `write/objects/text.ts`.
   *
   * ONE difference the preview cannot express: `behind: true` draws under
   * the page's own content on export (`prependContent`), and the overlay is
   * always above the page bitmap. A watermark set to sit behind will
   * therefore preview on top of the text it will actually sit under.
   * Drawing it in the wrong place is worse than drawing it in the right
   * place at the wrong depth.
   */
  stamp: TextObject,
}

/**
 * Kinds whose geometry is MuPDF PAGE space rather than raw PDF space.
 *
 * These render OUTSIDE the overlay's y-flipped root, so `PageOverlay` draws
 * them itself rather than going through `COMPONENTS`. Listed here so the
 * completeness test can account for them.
 */
export const MARKUP_KINDS = [
  'highlight',
  'underline',
  'strikeout',
  'redaction',
  'textPatch',
  'imagePatch',
  'regionPatch',
] as const

export const isMarkupKind = (kind: string): boolean =>
  (MARKUP_KINDS as readonly string[]).includes(kind)
