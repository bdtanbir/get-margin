import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const render = vi.fn()
// Amendment A1: the brief mocks `createPdfClient`, which the store no longer
// calls — it uses the shared `getPdfClient()` singleton (the document store's
// worker instance) so renders land in the same MuPDF instance the document
// was opened in. Mocking only `createPdfClient` would leave `getPdfClient`
// pointing at the real implementation, and jsdom would try to spawn an
// actual Worker.
vi.mock('../../src/workers/pdfClient.js', () => ({
  getPdfClient: () => ({
    open: vi.fn(), authenticate: vi.fn(), render,
    close: vi.fn().mockResolvedValue(undefined), terminate: vi.fn(),
  }),
}))

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  render.mockImplementation(async (_p: number, scale: number) => ({
    width: Math.round(612 * scale), height: Math.round(792 * scale),
    rgba: new Uint8Array(Math.round(612 * scale) * Math.round(792 * scale) * 4),
  }))
})

async function seededStores() {
  const { useDocumentStore } = await import('../../src/stores/document.js')
  const { useViewportStore } = await import('../../src/stores/viewport.js')
  const doc = useDocumentStore()
  const { seedDocument } = await import('../helpers/seedDocument.js')
  seedDocument(
    [
      { id: 'p0', sourceIndex: 0 },
      { id: 'p1', sourceIndex: 1 },
      { id: 'p2', sourceIndex: 2 },
    ],
    [GEOM, GEOM, GEOM],
  )
  return { doc, vp: useViewportStore() }
}

describe('useViewportStore', () => {
  it('defaults to zoom 1 and anchor 0', async () => {
    const { vp } = await seededStores()
    expect(vp.zoom).toBe(1)
    expect(vp.anchorIndex).toBe(0)
  })

  it('renders the anchor page and caches the result', async () => {
    const { vp } = await seededStores()
    await vp.pump()
    expect(vp.bitmapFor('p0')).toBeDefined()
  })

  it('does not re-render a cached page on a second pump', async () => {
    const { vp } = await seededStores()
    await vp.pump()
    const calls = render.mock.calls.length
    await vp.pump()
    expect(render.mock.calls.length).toBe(calls)
  })

  it('re-renders after a zoom change', async () => {
    const { vp } = await seededStores()
    await vp.pump()
    const calls = render.mock.calls.length
    vp.setZoom(2)
    await vp.pump()
    expect(render.mock.calls.length).toBeGreaterThan(calls)
  })

  it('re-renders after setDpr changes the effective scale', async () => {
    // dpr is a second input to effectiveScale, exactly like zoom — proves
    // setDpr marks the plan dirty the same way setZoom does, closing the
    // gap a plain writable `dpr` ref would leave open (a DPR change with no
    // setter would never invalidate the cache, silently serving stale-scale
    // bitmaps).
    const { vp } = await seededStores()
    await vp.pump()
    const calls = render.mock.calls.length
    vp.setDpr(vp.dpr + 1)
    await vp.pump()
    expect(render.mock.calls.length).toBeGreaterThan(calls)
  })

  it('setDpr is a no-op when the value is unchanged (no spurious dirty)', async () => {
    const { vp } = await seededStores()
    await vp.pump()
    const calls = render.mock.calls.length
    vp.setDpr(vp.dpr) // same value
    await vp.pump()
    expect(render.mock.calls.length).toBe(calls)
  })

  it('clamps zoom to the allowed range', async () => {
    const { vp } = await seededStores()
    vp.setZoom(100); expect(vp.zoom).toBeLessThanOrEqual(8)
    vp.setZoom(0.001); expect(vp.zoom).toBeGreaterThanOrEqual(0.1)
  })

  it('falls back to the placeholder bitmap when no full render exists yet', async () => {
    const { vp } = await seededStores()
    vp.setAnchor(0)
    await vp.pump()
    // p2 is outside the radius, so only its placeholder should exist.
    expect(vp.bitmapFor('p2')).toBeDefined()
    expect(vp.bitmapFor('p2')!.width).toBeLessThan(612)
  })

  it('invalidate drops cached renders for one page', async () => {
    const { vp } = await seededStores()
    await vp.pump()
    vp.invalidate('p0')
    expect(vp.bitmapFor('p0')).toBeUndefined()
  })

  // F7: a rejected render (worker died post-boot; a render racing
  // `closeSharedDocument()`) used to propagate out of `pump()`'s loop
  // uncaught, clearing `pumping` and rejecting a promise every caller
  // discards with `void` — leaving every page stuck as a placeholder with
  // `dirty` already false, so nothing would ever re-plan. Proves the fix:
  // `pump()` itself must not throw, later tasks in the same plan must still
  // render, and the failure must be recorded rather than silently dropped.
  it('recovers from a render rejection instead of abandoning the drain', async () => {
    const { vp } = await seededStores()
    let calls = 0
    render.mockImplementation(async (p: number, scale: number) => {
      calls++
      if (p === 0) throw new Error('worker died')
      return {
        width: Math.round(612 * scale), height: Math.round(792 * scale),
        rgba: new Uint8Array(Math.round(612 * scale) * Math.round(792 * scale) * 4),
      }
    })

    await expect(vp.pump()).resolves.toBeUndefined() // does not throw/reject

    expect(vp.bitmapFor('p0')).toBeUndefined() // the failed page never got a bitmap
    expect(vp.bitmapFor('p1')).toBeDefined() // later tasks in the same plan still ran
    expect(vp.lastError).toContain('worker died')
    expect(calls).toBeGreaterThan(1) // the loop continued past the failure
  })

  it('serializes pumps so overlapping calls cannot interleave renders', async () => {
    const { vp } = await seededStores()
    await Promise.all([vp.pump(), vp.pump(), vp.pump()])
    const keys = render.mock.calls.map((c) => `${c[0]}@${c[1]}`)
    expect(new Set(keys).size).toBe(keys.length) // no duplicate work
  })

  // Amendment A2: a stale plan must be abandoned mid-drain when the anchor
  // moves, not drained to completion. Proven directly against the `dirty`
  // mechanism rather than by inference from call counts: change the anchor
  // partway through a pump (via the mocked render's first invocation) and
  // assert the plan that was running at that moment did not finish
  // rendering every page it had originally queued before the fresh
  // full-render for the new anchor landed.
  it('abandons a stale plan when the anchor moves mid-pump (A2 starvation fix)', async () => {
    const { doc, vp } = await seededStores()
    // A bigger document so the initial plan has many placeholder tasks to
    // grind through if it were not abandoned.
    const { seedDocument } = await import('../helpers/seedDocument.js')
    seedDocument(
      Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, sourceIndex: i })),
      Array.from({ length: 20 }, () => GEOM),
    )
    vp.setDpr(2) // deterministic scale regardless of the test environment's devicePixelRatio
    vp.setAnchor(0)

    const renderOrder: string[] = []
    let movedAnchor = false
    render.mockImplementation(async (p: number, scale: number) => {
      renderOrder.push(`${p}@${scale}`)
      // As soon as the first (anchor) render lands, jump the anchor far
      // away — simulating a fast scroll mid-pump.
      if (!movedAnchor) {
        movedAnchor = true
        vp.setAnchor(19)
      }
      return {
        width: Math.round(612 * scale), height: Math.round(792 * scale),
        rgba: new Uint8Array(Math.round(612 * scale) * Math.round(792 * scale) * 4),
      }
    })

    await vp.pump()

    // Without the A2 fix, the plan computed for anchor 0 (full renders for
    // q0/q1, then 20 placeholders in page order) would drain uninterrupted:
    // q1's full render — or worse, a placeholder-only pass — would come
    // next, and q19 would not get a *full* render until some later pump()
    // call. With the fix, the second render issued by this single pump()
    // call is q19's full render, not q1's: the stale plan was abandoned the
    // instant the anchor moved, and the loop re-prioritized the new anchor
    // ahead of everything queued under the old one.
    expect(renderOrder[0]).toBe('0@2')
    expect(renderOrder[1]).toBe('19@2')
    // The new anchor got a genuine full-resolution render, not just its
    // cheap placeholder.
    expect(vp.bitmapFor('q19')).toBeDefined()
    expect(vp.bitmapFor('q19')!.width).toBeGreaterThan(200) // full render, not placeholder-only
  })
})
