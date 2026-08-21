import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SelectionToolbar from '@/features/tools/SelectionToolbar.vue'
import Inspector from '@/features/tools/Inspector.vue'
import PageOverlay from '@/features/overlay/PageOverlay.vue'
import { useEditsStore } from '@/stores/edits'
import { useSelectionStore } from '@/stores/selection'
import { useToolsStore } from '@/stores/tools'
import { TOOLS } from '@/features/tools/toolList'
import type { PageState } from '@/stores/document'
import type { RedactionObject, EditObject } from '@margin/pdf-core'

vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ listFields: vi.fn(async () => []), quadIndex: vi.fn(async () => ({ lines: [] })) }),
  closeSharedDocument: vi.fn(),
}))

const page: PageState = {
  id: 'p1', sourceId: 'src-0', sourceIndex: 0,
  geometry: { cropBox: [0, 0, 612, 792], rotate: 0 },
}

/** Two characters on one line, in MuPDF page space. */
const CHAR_QUADS = [
  [100, 100, 160, 100, 100, 120, 160, 120],
  [160, 100, 220, 100, 160, 120, 220, 120],
]

const INDEX = {
  lines: [{
    bbox: [100, 100, 220, 120] as [number, number, number, number],
    text: 'ab', font: 'Helvetica', bold: false, size: 12, baseline: 116,
    chars: [
      { char: 'a', quad: CHAR_QUADS[0] as never },
      { char: 'b', quad: CHAR_QUADS[1] as never },
    ],
  }],
}

function seed() {
  const edits = useEditsStore()
  edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
    { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
  return edits
}

/** Drive the selection store the way the pointer gesture does. */
function selectText() {
  const selection = useSelectionStore()
  selection.begin('p1', INDEX, { line: 0, char: 0 })
  selection.extend({ line: 0, char: 1 })
  return selection
}

const redactionsIn = (edits: ReturnType<typeof useEditsStore>): RedactionObject[] =>
  Object.values(edits.doc.objects).filter((o): o is RedactionObject => o.kind === 'redaction')

describe('the redact tool', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('is in the rail, so it is discoverable', () => {
    expect(TOOLS.map((t) => t.id)).toContain('redact')
    expect(TOOLS.find((t) => t.id === 'redact')?.label).toBe('Redact')
  })

  /**
   * The two look similar and do opposite things. Side by side in the rail
   * they would invite exactly the confusion the whiteout copy exists to
   * prevent.
   */
  it('does not sit next to whiteout in the rail', () => {
    const ids = TOOLS.map((t) => t.id)
    expect(Math.abs(ids.indexOf('redact') - ids.indexOf('whiteout'))).toBeGreaterThan(1)
  })

  it('activates text selection, like the markup tools', () => {
    const tools = useToolsStore()
    tools.setTool('redact')
    seed()
    const w = mount(PageOverlay, { props: { page, zoom: 1 } })
    expect(w.find('[data-text-surface]').exists()).toBe(true)
  })
})

describe('redacting a selection', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('offers Redact while text is selected', () => {
    seed(); selectText()
    const w = mount(SelectionToolbar, { props: { page, zoom: 1 } })
    expect(w.find('[data-redact]').exists()).toBe(true)
  })

  it('creates a redaction carrying the selected quads', async () => {
    const edits = seed()
    const selection = selectText()
    // Captured BEFORE the click, which clears the selection -- the store
    // also merges adjacent character quads into one run quad, so this
    // asserts against what was actually selected rather than a guess.
    const expected = selection.selectedQuads.map((q) => [...q])
    expect(expected.length).toBeGreaterThan(0)

    const w = mount(SelectionToolbar, { props: { page, zoom: 1 } })
    await w.get('[data-redact]').trigger('click')
    const made = redactionsIn(edits)
    expect(made).toHaveLength(1)
    // The export reads these quads directly, so they must survive verbatim.
    expect(made[0]!.quads).toEqual(expected)
  })

  // A redaction nobody can see is one nobody can check, including the
  // person who made it.
  it('draws a mark by default', async () => {
    const edits = seed(); selectText()
    const w = mount(SelectionToolbar, { props: { page, zoom: 1 } })
    await w.get('[data-redact]').trigger('click')
    expect(redactionsIn(edits)[0]!.blackBox).toBe(true)
  })

  it('is undoable like any other op', async () => {
    const edits = seed(); selectText()
    const w = mount(SelectionToolbar, { props: { page, zoom: 1 } })
    await w.get('[data-redact]').trigger('click')
    edits.undo()
    expect(redactionsIn(edits)).toHaveLength(0)
  })

  it('clears the text selection and selects the new object', async () => {
    const edits = seed()
    const selection = selectText()
    const w = mount(SelectionToolbar, { props: { page, zoom: 1 } })
    await w.get('[data-redact]').trigger('click')
    expect(selection.selectedQuads).toHaveLength(0)
    expect(edits.selection).toHaveLength(1)
  })
})

describe('the redaction preview', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  const withRedaction = (blackBox = true) => {
    const edits = seed()
    edits.applyOp({
      type: 'addObject',
      object: {
        id: 'r1', pageId: 'p1', kind: 'redaction', quads: CHAR_QUADS, blackBox,
        rect: { x: 100, y: 672, w: 120, h: 20 },
        rotation: 0, z: 1, locked: false, opacity: 1,
      } as EditObject,
    }, 'Redact')
    return mount(PageOverlay, { props: { page, zoom: 1 } })
  }

  /**
   * Every other overlay affordance hints at what the export will do; this
   * one is a picture of the result. A translucent preview would show the
   * words that are about to be destroyed, reading as "still there" at
   * exactly the moment the user needs to believe otherwise.
   */
  it('is opaque black, not a translucent wash', () => {
    const polys = withRedaction(true).findAll('polygon')
    expect(polys.length).toBeGreaterThan(0)
    expect(polys[0]!.attributes('fill')).toBe('#000')
    expect(polys[0]!.attributes('fill-opacity')).toBeUndefined()
  })

  it('draws one shape per quad', () => {
    expect(withRedaction(true).findAll('polygon')).toHaveLength(CHAR_QUADS.length)
  })

  // The export draws no mark, but the editor still must -- otherwise the
  // user cannot tell which words they have selected.
  it('outlines the region when the export will draw no mark', () => {
    const poly = withRedaction(false).findAll('polygon')[0]!
    expect(poly.attributes('fill')).toBe('none')
    expect(poly.attributes('stroke')).toBe('#000')
    expect(poly.attributes('stroke-dasharray')).toBeTruthy()
  })
})

describe('the whiteout notice', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('now points at the tool that actually removes text', () => {
    const edits = seed()
    edits.applyOp({
      type: 'addObject',
      object: {
        id: 'w1', pageId: 'p1', kind: 'whiteout', fill: [1, 1, 1],
        rect: { x: 10, y: 10, w: 100, h: 20 },
        rotation: 0, z: 1, locked: false, opacity: 1,
      } as EditObject,
    }, 'Add')
    edits.select(['w1'])
    const text = mount(Inspector).get('[data-whiteout-notice]').text()
    // Both halves: the warning it always carried, and where to go instead.
    expect(text).toContain('does not delete it')
    expect(text).toContain('Redact')
  })
})
