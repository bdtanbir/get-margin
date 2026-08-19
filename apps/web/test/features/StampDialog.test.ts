import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import StampDialog from '@/features/stamp/StampDialog.vue'
import { useEditsStore } from '@/stores/edits'
import { useDocumentStore } from '@/stores/document'
import { buildStamps } from '@/features/stamp/buildStamps'
import { stampRect, alignFor, PRESETS } from '@/features/stamp/stampPresets'
import type { StampObject, EditObject } from '@margin/pdf-core'
import type { PageState } from '@/stores/document'

vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ listFields: vi.fn(async () => []) }),
  closeSharedDocument: vi.fn(),
}))

const GEOMETRY = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

function seed(pageCount = 3) {
  const edits = useEditsStore()
  const ids = Array.from({ length: pageCount }, (_, i) => `p${i}`)
  edits.reset(
    { 'src-0': { hash: 'h', name: 'report.pdf' } },
    ids,
    Object.fromEntries(ids.map((id, i) => [
      id, { sourceId: 'src-0', sourceIndex: i, rotation: 0, cropBox: null },
    ])),
  )
  const doc = useDocumentStore()
  doc.$patch({
    status: 'ready',
    fileName: 'report.pdf',
    sources: { 'src-0': { id: 'src-0', name: 'report.pdf', pageCount, geometries: ids.map(() => GEOMETRY) } },
  })
  return { edits, doc }
}

const stampsIn = (edits: ReturnType<typeof useEditsStore>): StampObject[] =>
  Object.values(edits.doc.objects).filter((o): o is StampObject => o.kind === 'stamp')

describe('stampRect', () => {
  const g = GEOMETRY

  it('places a bottom-centre stamp against the bottom margin', () => {
    const r = stampRect(g, 'bottom-center', 28, 100, 14)
    expect(r.y).toBe(28)
    expect(r.x).toBeCloseTo((612 - 100) / 2, 0)
  })

  it('places a top-right stamp against both margins', () => {
    const r = stampRect(g, 'top-right', 28, 100, 14)
    expect(r.x).toBeCloseTo(612 - 28 - 100, 0)
    expect(r.y).toBeCloseTo(792 - 28 - 14, 0)
  })

  it('centres a centred stamp', () => {
    const r = stampRect(g, 'center', 0, 200, 60)
    expect(r.x).toBeCloseTo((612 - 200) / 2, 0)
    expect(r.y).toBeCloseTo((792 - 60) / 2, 0)
  })

  /**
   * A page whose box starts at (50, -35) needs its bottom-centre stamp at
   * x = 50 + margin. Ignoring the origin puts it off the visible page --
   * which is exactly the failure the offset-cropbox fixture exists for.
   */
  it('adds the CropBox origin back, so an offset page is not stamped off-page', () => {
    const offset = { cropBox: [50, -35, 400, 385] as [number, number, number, number], rotate: 0 as const }
    const r = stampRect(offset, 'bottom-left', 20, 100, 14)
    expect(r.x).toBe(70)
    expect(r.y).toBe(-15)
  })

  it('aligns text to the side it is anchored to', () => {
    expect(alignFor('bottom-left')).toBe('left')
    expect(alignFor('top-right')).toBe('right')
    expect(alignFor('center')).toBe('center')
    expect(alignFor('bottom-center')).toBe('center')
  })
})

describe('buildStamps', () => {
  const pages: PageState[] = [0, 1, 2].map((i) => ({
    id: `p${i}`, sourceId: 'src-0', sourceIndex: i, geometry: GEOMETRY,
  }))

  it('produces one stamp per page', () => {
    const out = buildStamps(PRESETS.footer, pages, pages, 'report.pdf', '2026-08-19', () => 1)
    expect(out).toHaveLength(3)
    expect(out.map((s) => s.pageId)).toEqual(['p0', 'p1', 'p2'])
  })

  it('resolves tokens per page', () => {
    const out = buildStamps(PRESETS.footer, pages, pages, 'report.pdf', '2026-08-19', () => 1)
    expect(out.map((s) => s.text)).toEqual(['1 of 3', '2 of 3', '3 of 3'])
  })

  /**
   * Someone stamping pages 2-3 of a 3-page report wants "2 of 3", not
   * "1 of 2": {n} and {total} count the DOCUMENT, not the selection.
   */
  it('numbers against the document, not the selection', () => {
    const out = buildStamps(PRESETS.footer, pages.slice(1), pages, 'report.pdf', 'd', () => 1)
    expect(out.map((s) => s.text)).toEqual(['2 of 3', '3 of 3'])
  })

  // A production numbered 1..n counts the pages actually produced, which is
  // the opposite rule -- and deliberately so.
  it('numbers Bates against the selection', () => {
    const out = buildStamps(
      { ...PRESETS.bates, bates: { start: 1, step: 1, digits: 4, prefix: 'X-', suffix: '' } },
      pages.slice(1), pages, 'report.pdf', 'd', () => 1,
    )
    expect(out.map((s) => s.text)).toEqual(['X-0001', 'X-0002'])
  })

  it('carries the preset’s appearance onto every stamp', () => {
    const out = buildStamps(PRESETS.watermark, pages, pages, 'r.pdf', 'd', () => 1)
    expect(out.every((s) => s.behind)).toBe(true)
    expect(out.every((s) => s.rotation === 45)).toBe(true)
    expect(out.every((s) => s.opacity === 0.25)).toBe(true)
    expect(out.every((s) => s.text === 'CONFIDENTIAL')).toBe(true)
  })

  /**
   * THE BUG THIS CAUGHT. `settings` comes from a Vue ref, so its nested
   * array is a reactive Proxy -- and a Proxy cannot be structure-cloned,
   * so posting the edit document to the worker threw "could not be
   * cloned" and the export died before it started.
   *
   * structuredClone is exactly what postMessage does, so asserting on it
   * tests the real constraint rather than an approximation of it.
   */
  it('produces objects that can cross the worker boundary', () => {
    // From a REF, which is what the dialog holds. A module constant would
    // pass this whether or not the bug existed -- the Proxy only appears
    // once the settings are reactive.
    const reactive = ref({ ...PRESETS.watermark })
    const out = buildStamps(reactive.value, pages, pages, 'r.pdf', 'd', () => 1)
    expect(() => structuredClone(out)).not.toThrow()
  })

  it('gives every stamp a distinct id', () => {
    const out = buildStamps(PRESETS.footer, pages, pages, 'r.pdf', 'd', () => 1)
    expect(new Set(out.map((s) => s.id)).size).toBe(3)
  })
})

describe('StampDialog', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('offers every preset', () => {
    seed()
    const w = mount(StampDialog)
    expect(w.findAll('[data-preset]').map((b) => b.attributes('data-preset')))
      .toEqual(['watermark', 'pageNumber', 'header', 'footer', 'bates'])
  })

  /**
   * A half-merged state -- a watermark's 60pt rotated text at a footer's
   * bottom-centre position -- is not something anyone asked for, and it is
   * what merging produces the moment two presets disagree about a field.
   */
  it('replaces settings wholesale when the preset changes', async () => {
    seed()
    const w = mount(StampDialog)
    await w.get('[data-preset="footer"]').trigger('click')
    expect((w.get('[data-stamp-template]').element as HTMLInputElement).value).toBe('{n} of {total}')
    expect((w.get('[data-stamp-position]').element as HTMLSelectElement).value).toBe('bottom-center')
    expect((w.get('[data-stamp-rotation]').element as HTMLInputElement).value).toBe('0')
  })

  it('shows what the first page will actually say', async () => {
    seed()
    const w = mount(StampDialog)
    await w.get('[data-preset="footer"]').trigger('click')
    expect(w.get('[data-stamp-preview]').text()).toContain('1 of 3')
  })

  it('defaults to every page', () => {
    seed(5)
    expect(mount(StampDialog).get('[data-stamp-count]').text()).toContain('5 pages')
  })

  it('honours a page range', async () => {
    seed(5)
    const w = mount(StampDialog)
    await w.get('[data-stamp-range]').setValue('1-3')
    expect(w.get('[data-stamp-count]').text()).toContain('3 pages')
  })

  it('says why a bad range is bad, and refuses to apply', async () => {
    seed(5)
    const w = mount(StampDialog)
    await w.get('[data-stamp-range]').setValue('9-20')
    expect(w.find('[data-stamp-range-error]').exists()).toBe(true)
    expect(w.get('[data-stamp-apply]').attributes('disabled')).toBeDefined()
  })

  it('adds one stamp per targeted page', async () => {
    const { edits } = seed(3)
    const w = mount(StampDialog)
    await w.get('[data-preset="footer"]').trigger('click')
    await w.get('[data-stamp-apply]').trigger('click')
    expect(stampsIn(edits)).toHaveLength(3)
  })

  // Stamping 300 pages should cost one Cmd+Z, not three hundred.
  it('records the whole run as one undo entry', async () => {
    const { edits } = seed(3)
    edits.clearHistory()
    const w = mount(StampDialog)
    await w.get('[data-stamp-apply]').trigger('click')
    expect(edits.historySize).toBe(1)
    edits.undo()
    expect(stampsIn(edits)).toHaveLength(0)
  })

  it('shows Bates settings only for Bates numbering', async () => {
    seed()
    const w = mount(StampDialog)
    expect(w.find('[data-bates-settings]').exists()).toBe(false)
    await w.get('[data-preset="bates"]').trigger('click')
    expect(w.find('[data-bates-settings]').exists()).toBe(true)
  })

  it('applies Bates start, step, and padding', async () => {
    const { edits } = seed(3)
    const w = mount(StampDialog)
    await w.get('[data-preset="bates"]').trigger('click')
    await w.get('[data-bates-start]').setValue(500)
    await w.get('[data-bates-digits]').setValue(4)
    await w.get('[data-bates-prefix]').setValue('ACME-')
    await w.get('[data-stamp-apply]').trigger('click')
    expect(stampsIn(edits).map((s) => s.text).sort())
      .toEqual(['ACME-0500', 'ACME-0501', 'ACME-0502'])
  })

  it('closes without applying on cancel', async () => {
    const { edits } = seed()
    const w = mount(StampDialog)
    await w.get('[data-stamp-cancel]').trigger('click')
    expect(w.emitted('close')).toBeTruthy()
    expect(stampsIn(edits)).toHaveLength(0)
  })

  it('names the tokens where they are typed', () => {
    seed()
    const text = mount(StampDialog).text()
    for (const token of ['{n}', '{total}', '{filename}', '{date}', '{bates}']) {
      expect(text).toContain(token)
    }
  })
})
