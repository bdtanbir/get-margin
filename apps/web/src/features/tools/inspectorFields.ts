import type { ObjectKind } from '@margin/pdf-core'
import { FONTS } from '@/lib/fonts'
import { normalizeUri } from '@/lib/linkUrl'

export type Field =
  | { key: string; label: string; type: 'number'; min: number; max: number; step: number }
  | { key: string; label: string; type: 'color' }
  | {
      key: string; label: string; type: 'text'
      /**
       * Applied when the edit is COMMITTED (change/blur), not on every
       * keystroke -- normalising mid-typing would fight the caret. Throwing
       * rejects the edit and surfaces the message, which is how a
       * `javascript:` URL stays unrepresentable in the edit document.
       */
      normalize?: (value: string) => string
    }
  | { key: string; label: string; type: 'select'; options: Array<{ value: string; label: string }> }

const OPACITY: Field = { key: 'opacity', label: 'Opacity', type: 'number', min: 0, max: 1, step: 0.05 }
const ROTATION: Field = { key: 'rotation', label: 'Rotation', type: 'number', min: -180, max: 180, step: 1 }

const SHAPE: Field[] = [
  { key: 'stroke', label: 'Stroke', type: 'color' },
  { key: 'strokeWidth', label: 'Stroke width', type: 'number', min: 0, max: 24, step: 0.5 },
  { key: 'fill', label: 'Fill', type: 'color' },
  OPACITY, ROTATION,
]

const TEXT: Field[] = [
  {
    key: 'fontFamily', label: 'Font', type: 'select',
    // Built from the curated set rather than hardcoded: a font added to
    // lib/fonts.ts must appear in the picker, or it exists only to whoever
    // reads the source.
    options: FONTS.map((f) => ({ value: f.family, label: f.family })),
  },
  { key: 'fontSize', label: 'Size', type: 'number', min: 4, max: 144, step: 1 },
  { key: 'color', label: 'Colour', type: 'color' },
  {
    key: 'align', label: 'Align', type: 'select',
    options: [
      { value: 'left', label: 'Left' },
      { value: 'center', label: 'Centre' },
      { value: 'right', label: 'Right' },
    ],
  },
  OPACITY, ROTATION,
]

/**
 * Kind -> editable fields. Adding a field here is all a tool task needs to
 * do to make it editable; the Inspector renders whatever this returns, so no
 * tool ships its own bespoke panel.
 */
const REGISTRY: Partial<Record<ObjectKind, Field[]>> = {
  rect: SHAPE, ellipse: SHAPE, line: SHAPE, arrow: SHAPE,
  text: TEXT,
  whiteout: [{ key: 'fill', label: 'Colour', type: 'color' }, OPACITY],
  ink: [
    { key: 'color', label: 'Colour', type: 'color' },
    { key: 'strokeWidth', label: 'Thickness', type: 'number', min: 0.5, max: 24, step: 0.5 },
    OPACITY,
  ],
  highlight: [{ key: 'color', label: 'Colour', type: 'color' }, OPACITY],
  underline: [{ key: 'color', label: 'Colour', type: 'color' }, OPACITY],
  strikeout: [{ key: 'color', label: 'Colour', type: 'color' }, OPACITY],
  link: [{ key: 'uri', label: 'URL', type: 'text', normalize: normalizeUri }],
  image: [OPACITY, ROTATION],
  signature: [OPACITY, ROTATION],
}

export function fieldsFor(kind: ObjectKind): Field[] {
  return REGISTRY[kind] ?? []
}
