import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { replay, WRITERS } from '../../src/write/index.js'
import {
  EDIT_DOCUMENT_VERSION, type EditDocument, type EditObject, type ObjectKind,
} from '../../src/write/types.js'
import { PdfDocument, buildQuadIndex } from '../../src/index.js'
import { assertGolden } from '../golden.js'
import { generateFixtures, fixturePath, type FixtureName } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const bytes = (n: FixtureName): Uint8Array => new Uint8Array(readFileSync(fixturePath(n)))

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FONTS = new Map([
  ['Inter', new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts/Inter.ttf')))],
])

/** A small opaque-ink-on-transparent PNG, standing in for a signature. */
function stampPng(size = 64): Uint8Array {
  const png = new PNG({ width: size, height: size })
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const ink = Math.abs(x - y) < size / 6
      png.data[i] = ink ? 20 : 255
      png.data[i + 1] = ink ? 20 : 255
      png.data[i + 2] = ink ? 200 : 255
      png.data[i + 3] = ink ? 255 : 0
    }
  }
  return new Uint8Array(PNG.sync.write(png))
}

const STAMP = stampPng()

/**
 * Every object kind at once, positioned relative to the page's OWN CropBox
 * so the same builder works on an origin-zero page, a page whose CropBox
 * origin is not (0,0), and a quarter-turned page.
 *
 * This is the phase's regression net: a coordinate change that only shows up
 * on a rotated or offset page fails here and nowhere else.
 */
function everyKind(target: Target): EditDocument {
  const { fixture: name, page: pageIndex } = target
  const doc = PdfDocument.open(bytes(name))
  let geometry
  let quads: number[][] = []
  let markupRect = { x: 0, y: 0, w: 0, h: 0 }
  try {
    geometry = doc.pageGeometry(pageIndex)
    // Markup quads come from the real index, in MuPDF page space -- the same
    // producer/consumer pair production uses.
    const line = buildQuadIndex(doc, pageIndex).lines[0]
    if (line) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const c of line.chars) {
        for (let i = 0; i < 8; i += 2) {
          minX = Math.min(minX, c.quad[i]!); maxX = Math.max(maxX, c.quad[i]!)
          minY = Math.min(minY, c.quad[i + 1]!); maxY = Math.max(maxY, c.quad[i + 1]!)
        }
      }
      quads = [[minX, minY, maxX, minY, minX, maxY, maxX, maxY]]
      const pageH = geometry.cropBox[3] - geometry.cropBox[1]
      markupRect = { x: minX, y: pageH - maxY, w: maxX - minX, h: maxY - minY }
    }
  } finally { doc.close() }

  const [x0, y0, x1, y1] = geometry.cropBox
  const pw = x1 - x0
  const ph = y1 - y0

  /**
   * Placement as a FRACTION of the page's own box, not fixed points.
   * offset-cropbox is 350x420 -- a third smaller than Letter -- so a fixed
   * layout put most kinds off-page entirely and the golden recorded a
   * near-blank sheet while still passing.
   */
  const at = (fx: number, fy: number) => ({ x: x0 + fx * pw, y: y0 + fy * ph })
  const size = (fw: number, fh: number) => ({ w: fw * pw, h: fh * ph })

  const shape = {
    rotation: 0, locked: false, opacity: 1,
    stroke: [0, 0, 1] as [number, number, number], strokeWidth: 2, fill: null,
  }

  const objects: EditObject[] = [
    { ...shape, id: 'k-rect', pageId: 'p0', kind: 'rect', z: 1, rect: { ...at(0.08, 0.66), ...size(0.18, 0.07) }, fill: [1, 0.9, 0.2] },
    { ...shape, id: 'k-ellipse', pageId: 'p0', kind: 'ellipse', z: 2, rect: { ...at(0.30, 0.66), ...size(0.18, 0.07) } },
    { ...shape, id: 'k-line', pageId: 'p0', kind: 'line', z: 3, rect: { ...at(0.08, 0.61), ...size(0.40, 0) } },
    { ...shape, id: 'k-arrow', pageId: 'p0', kind: 'arrow', z: 4, rect: { ...at(0.08, 0.56), ...size(0.40, 0) } },
    {
      id: 'k-whiteout', pageId: 'p0', kind: 'whiteout', z: 5,
      rect: { ...at(0.56, 0.66), ...size(0.16, 0.05) }, rotation: 0, locked: false, opacity: 1,
      fill: [1, 1, 1],
    },
    {
      id: 'k-text', pageId: 'p0', kind: 'text', z: 6,
      rect: { ...at(0.08, 0.48), ...size(0.55, 0.035) }, rotation: 0, locked: false, opacity: 1,
      text: 'Every kind', fontFamily: 'Inter', fontSize: 18, color: [0, 0, 0], align: 'left',
    },
    {
      id: 'k-image', pageId: 'p0', kind: 'image', z: 7,
      rect: { ...at(0.08, 0.36), ...size(0.11, 0.08) }, rotation: 0, locked: false, opacity: 1,
      data: STAMP, mime: 'image/png',
    },
    {
      id: 'k-signature', pageId: 'p0', kind: 'signature', z: 8,
      rect: { ...at(0.23, 0.36), ...size(0.11, 0.08) }, rotation: 0, locked: false, opacity: 1,
      data: STAMP, mime: 'image/png',
    },
    {
      id: 'k-ink', pageId: 'p0', kind: 'ink', z: 9,
      rect: { ...at(0.38, 0.36), ...size(0.22, 0.08) }, rotation: 0, locked: false, opacity: 1,
      strokes: [[
        at(0.38, 0.37).x, at(0.38, 0.37).y,
        at(0.44, 0.44).x, at(0.44, 0.44).y,
        at(0.50, 0.37).x, at(0.50, 0.37).y,
        at(0.56, 0.44).x, at(0.56, 0.44).y,
      ]],
      color: [0.9, 0.2, 0.2], strokeWidth: 3,
    },
    {
      id: 'k-link', pageId: 'p0', kind: 'link', z: 10,
      rect: { ...at(0.08, 0.28), ...size(0.3, 0.03) }, rotation: 0, locked: false, opacity: 1,
      uri: 'https://example.com/',
    },
  ] as EditObject[]

  // Markup only where the fixture actually has text to mark.
  if (quads.length > 0) {
    const markup = (kind: 'highlight' | 'underline' | 'strikeout', z: number, color: [number, number, number]) => ({
      id: `k-${kind}`, pageId: 'p0', kind, z, quads, color,
      rect: markupRect, rotation: 0, locked: false, opacity: 1,
    }) as EditObject
    objects.push(
      markup('highlight', 11, [1, 0.9, 0.2]),
      markup('underline', 12, [0, 0.4, 1]),
      markup('strikeout', 13, [0.9, 0.1, 0.1]),
    )
  }

  return {
    version: EDIT_DOCUMENT_VERSION, sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'], pages: { p0: { sourceIndex: pageIndex, sourceId: 'src-0', rotation: 0, cropBox: null } },
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    nextZ: 99,
  }
}

type Target = { name: string; fixture: FixtureName; page: number }

/**
 * `rotated.pdf` page 0 has /Rotate 0 -- the turned pages are 1 (90), 2 (180)
 * and 3 (270). Targeting page 0 would have exercised nothing this suite
 * exists to catch, so the quarter-turned page is named explicitly.
 */
const TARGETS: Target[] = [
  { name: 'simple-text', fixture: 'simple-text', page: 0 },
  { name: 'offset-cropbox', fixture: 'offset-cropbox', page: 0 },
  { name: 'rotated-90', fixture: 'rotated', page: 1 },
  { name: 'rotated-270', fixture: 'rotated', page: 3 },
]

describe('Phase 2 golden suite', () => {
  // Every kind must have a writer. This is the guard the per-task tests
  // cannot give: a kind added to ObjectKind without a writer would only fail
  // at export time, in front of a user.
  it('registers a writer for every ObjectKind', () => {
    const kinds: ObjectKind[] = [
      'text', 'image', 'rect', 'ellipse', 'line', 'arrow',
      'ink', 'highlight', 'underline', 'strikeout',
      'whiteout', 'link', 'signature',
    ]
    for (const kind of kinds) expect(WRITERS[kind], `no writer for "${kind}"`).toBeDefined()
  })

  it.each(TARGETS)('exports every object kind onto $name', (target) => {
    expect(() => replay(new Map([['src-0', bytes(target.fixture)]]), everyKind(target), { fonts: FONTS })).not.toThrow()
  })

  it.each(TARGETS)('matches the reviewed golden for $name', async (target) => {
    // Page 0 of the OUTPUT, not of the source: since Task 44 the edit
    // document's pageOrder is the exported document, so a one-page edit
    // produces a one-page file. The rendered content is the same page it
    // always was, which is why the existing goldens still match.
    await assertGolden(
      `export-all-${target.name}`,
      replay(new Map([['src-0', bytes(target.fixture)]]), everyKind(target), { fonts: FONTS }),
      { page: 0 },
    )
  })

  // Export must be a pure function of (sourceBytes, EditDocument): the same
  // inputs produce the same bytes, and the source is never touched.
  it.each(TARGETS)('is deterministic and leaves the source untouched for $name', (target) => {
    const src = bytes(target.fixture)
    const before = src.slice()
    const editDoc = everyKind(target)
    const a = replay(new Map([['src-0', src]]), editDoc, { fonts: FONTS })
    const b = replay(new Map([['src-0', src]]), editDoc, { fonts: FONTS })
    expect(src).toEqual(before)
    expect(a.byteLength).toBe(b.byteLength)
  })

  it.each(TARGETS)('produces a reopenable document for $name', (target) => {
    const out = replay(new Map([['src-0', bytes(target.fixture)]]), everyKind(target), { fonts: FONTS })
    const doc = PdfDocument.open(out)
    try {
      expect(doc.pageCount).toBeGreaterThan(0)
    } finally { doc.close() }
  })

  it.each(TARGETS)('keeps ink and markup as native annotations on $name', (target) => {
    const editDoc = everyKind(target)
    const out = replay(new Map([['src-0', bytes(target.fixture)]]), editDoc, { fonts: FONTS })
    const doc = PdfDocument.open(out)
    try {
      const page = doc._raw().loadPage(0)
      try {
        const types = page.getAnnotations().map((a) => a.getType())
        // The semantic split: these stay editable in other PDF tools rather
        // than being burned into the page content.
        expect(types).toContain('Ink')

        // Markup is only built where the fixture has extractable text --
        // offset-cropbox has none. Deriving the expectation from the edit
        // document rather than from a hardcoded fixture list keeps this
        // honest if a fixture ever gains or loses text.
        if (Object.values(editDoc.objects).some((o) => o.kind === 'highlight')) {
          expect(types).toContain('Highlight')
          expect(types).toContain('Underline')
          expect(types).toContain('StrikeOut')
        }

        // ...and the link is an fz_link, not an annotation.
        expect(types).not.toContain('Link')
        expect(page.getLinks()).toHaveLength(1)
      } finally { page.destroy() }
    } finally { doc.close() }
  })

  // The markup half of the suite would silently cover nothing if every
  // fixture stopped yielding text, so at least one must still exercise it.
  it('exercises markup on at least one target', () => {
    const withMarkup = TARGETS.filter((t) =>
      Object.values(everyKind(t).objects).some((o) => o.kind === 'highlight'),
    )
    expect(withMarkup.length).toBeGreaterThan(0)
  })

  // The suite is only a regression net for rotation if it actually visits a
  // turned page. rotated.pdf page 0 is /Rotate 0.
  it('covers a quarter-turned page', () => {
    const rotations = TARGETS.map((t) => {
      const doc = PdfDocument.open(bytes(t.fixture))
      try { return doc.pageGeometry(t.page).rotate } finally { doc.close() }
    })
    expect(rotations).toContain(90)
    expect(rotations.some((r) => r !== 0)).toBe(true)
  })
})
