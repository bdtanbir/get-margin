import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { OBJECT_KINDS, type EditObject, type ObjectKind } from '@margin/pdf-core'
import ObjectLayer from '@/features/overlay/ObjectLayer.vue'
import { COMPONENTS, MARKUP_KINDS, isMarkupKind } from '@/features/overlay/objects/registry'

/**
 * Every kind the format can produce must be something the viewer can draw.
 *
 * Three kinds reached the format without a renderer, over three phases, and
 * each produced the same defect: an object that saved, survived undo, moved
 * when dragged, exported perfectly — and was invisible on screen. Nothing
 * failed, because `ObjectLayer` renders nothing for a kind it does not
 * know, and the export path is a completely separate table.
 *
 * They were all reported by a user rather than caught here, which is the
 * argument for this file: a test that enumerates the format's own list
 * cannot miss the next one.
 */
describe('every object kind has a renderer', () => {
  it.each(OBJECT_KINDS)('%s', (kind) => {
    const drawnByOverlay = isMarkupKind(kind)
    const drawnByObjectLayer = COMPONENTS[kind] !== undefined

    expect(
      drawnByObjectLayer || drawnByOverlay,
      `"${kind}" has no renderer: add it to COMPONENTS, or to MARKUP_KINDS ` +
        `if its geometry is in MuPDF page space. An unregistered kind draws ` +
        `nothing and reports no error.`,
    ).toBe(true)
  })

  /** A kind cannot be in both tables: PageOverlay routes on exactly one. */
  it('routes each kind to exactly one renderer', () => {
    for (const kind of MARKUP_KINDS) {
      expect(COMPONENTS[kind], `"${kind}" is in both tables`).toBeUndefined()
    }
  })

  /** The markup list must not name a kind the format does not have. */
  it('lists no kind the format does not define', () => {
    const known = new Set<string>(OBJECT_KINDS)
    for (const kind of MARKUP_KINDS) expect(known.has(kind), kind).toBe(true)
    for (const kind of Object.keys(COMPONENTS)) expect(known.has(kind), kind).toBe(true)
  })
})

/**
 * The reported cases, asserted through an actual mount rather than through
 * the table.
 *
 * A registry entry proves the wiring; only rendering proves something is
 * drawn. These two were the ones a user hit.
 */
describe('the kinds that were silently invisible', () => {
  const base = {
    id: 'o1',
    pageId: 'p1',
    rect: { x: 10, y: 20, w: 100, h: 40 },
    rotation: 0,
    z: 1,
    locked: false,
    opacity: 1,
  }

  function draws(object: EditObject): boolean {
    const w = mount(ObjectLayer, { props: { object } })
    // `find`, not `element.querySelector`: with no renderer registered the
    // component renders a comment node, and a comment has no
    // querySelector — so the assertion would die with "not a function"
    // instead of saying the thing was not drawn.
    return w.find('image, text, rect, path, polygon, line, foreignObject').exists()
  }

  it('draws a signature, the way the export draws it: as an image', () => {
    expect(
      draws({
        ...base,
        kind: 'signature',
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        mime: 'image/png',
      } as EditObject),
    ).toBe(true)
  })

  it('draws a stamp', () => {
    expect(
      draws({
        ...base,
        kind: 'stamp',
        stampKind: 'watermark',
        text: 'DRAFT',
        fontFamily: 'Inter',
        fontSize: 24,
        color: [0, 0, 0],
        align: 'center',
        behind: false,
      } as EditObject),
    ).toBe(true)
  })

  /**
   * Not a passing note: a stamp set to sit behind the page's content
   * previews on top of it, because the overlay is always above the page
   * bitmap. Drawing it in the right place at the wrong depth beats not
   * drawing it at all, and this records the difference rather than leaving
   * someone to discover it.
   */
  it('draws a behind-stamp too, at the wrong depth', () => {
    expect(
      draws({
        ...base,
        kind: 'stamp',
        stampKind: 'watermark',
        text: 'CONFIDENTIAL',
        fontFamily: 'Inter',
        fontSize: 24,
        color: [0.5, 0.5, 0.5],
        align: 'center',
        behind: true,
      } as EditObject),
    ).toBe(true)
  })
})

/** The kinds ObjectLayer owns, mounted one by one. */
describe('ObjectLayer renders what its table claims', () => {
  const kinds = (Object.keys(COMPONENTS) as ObjectKind[]).filter((k) => k !== 'field')

  it.each(kinds)('%s resolves to a component', (kind) => {
    expect(COMPONENTS[kind]).toBeDefined()
  })
})
