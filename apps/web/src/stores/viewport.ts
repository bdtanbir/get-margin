import { defineStore } from 'pinia'
import { ref, computed, shallowRef, readonly } from 'vue'
import { BitmapCache, cacheKey } from '@/lib/bitmapCache'
import { getPdfClient } from '@/workers/pdfClient'
import { planRenders, effectiveScale, PLACEHOLDER_SCALE } from '@/features/viewport/renderPriority'
import { useDocumentStore, type PageId } from '@/stores/document'
import type { RenderResult } from '@/workers/pdfService'
import { type FitMode, computeFitZoom, nextZoomStep, MIN_ZOOM, MAX_ZOOM } from '@/lib/fit'
import type { PageGeometry } from '@margin/transform'

// MIN_ZOOM/MAX_ZOOM now live in `@/lib/fit` (Task 18 amendment) — this
// module used to define them, and `lib/fit.ts` imported them from here
// while this module imports `computeFitZoom`/`nextZoomStep` from
// `lib/fit.ts`. That is a genuine ES module cycle. Re-exported here so
// existing `import { MIN_ZOOM } from '@/stores/viewport'` call sites keep
// working; `lib/fit.ts` must never import from this module.
export { MIN_ZOOM, MAX_ZOOM }
const VISIBLE_RADIUS = 1

// Amendment A1: use the shared `getPdfClient()` singleton rather than a
// module-local `createPdfClient()` instance. The document store opens the
// document in the shared worker's MuPDF instance (spec §1.5: one worker per
// document); a second, independently-created client here would spawn a
// second Worker + MuPDF instance that never received the document, and
// every render would fail with "no document open" — invisible to unit
// tests because both stores mock the client module, only surfacing as a
// viewer that renders nothing in a real browser.

export const useViewportStore = defineStore('viewport', () => {
  const doc = useDocumentStore()

  const zoom = ref(1)
  const anchorIndex = ref(0)
  const dpr = ref(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
  // shallowRef: the cache holds large typed arrays that must never be made reactive.
  const cache = shallowRef(new BitmapCache())
  const version = ref(0) // bumped on cache mutation so getters re-evaluate

  // Set when a render rejects (worker died post-boot; a render racing
  // `closeSharedDocument()` from `doc.reset()`). Diagnostic only — `pump()`
  // itself already recovers by skipping the failed task and continuing the
  // drain; nothing in this store reads `lastError` to decide behavior. A
  // caller that wants to surface it to the user reads `lastError.value`.
  const lastError = ref('')

  let pumping: Promise<void> | undefined
  // Amendment A2: set whenever the render plan may be stale (anchor moved,
  // zoom changed, dpr changed, or a page was invalidated). `pump()` loops
  // while this is set, re-planning from scratch each pass, and also checks
  // it between individual renders so a scroll mid-pump abandons the stale
  // plan at the next render boundary rather than draining it to completion.
  // MuPDF cannot interrupt a render already inside WASM, so "between
  // renders" is the finest granularity available.
  //
  // Invariant: every input to the render plan produced by `planRenders` —
  // not just `effectiveScale(zoom, dpr)`, the formula behind the cache key
  // every render is planned and stored against, but also `anchorIndex`,
  // which decides which pages the plan even considers — must mark the plan
  // dirty when it changes, exactly like `setZoom`, `setDpr`, and `setAnchor`
  // do below. `zoom`, `dpr`, and `anchorIndex` are therefore all returned as
  // `readonly()`-wrapped refs, not plain writable ones; each has a setter
  // that owns marking `dirty`. If a new input is ever added to the plan,
  // wire its setter the same way, or the cache will silently keep serving
  // stale results — blurry pages or a plan anchored at the wrong page, no
  // error, no signal anything is stale.
  //
  // Caveat: `readonly()` here is a runtime-only guarantee. Pinia's
  // setup-store type extraction treats any `isRef()`-true value as mutable
  // state — a `readonly()`-wrapped ref is still `isRef() === true` (only
  // `computed()` gets special-cased), so the store's exposed TypeScript
  // type does not actually forbid `vp.zoom = x` / `vp.dpr = x` at compile
  // time. `vp.zoom = x` still fails at runtime (Vue's readonly proxy warns
  // and does not apply the write — verified directly, not assumed), but a
  // caller gets a clean `tsc`/`vue-tsc` build and only a console warning
  // that is easy to miss in CI. Route every external write through
  // `setZoom`/`setDpr`; do not rely on the type system to catch a direct
  // assignment here.
  let dirty = true

  /** Best available bitmap: the full render if present, else the placeholder. */
  function bitmapFor(pageId: PageId): RenderResult | undefined {
    void version.value
    const c = cache.value
    return (
      c.get(cacheKey(pageId, effectiveScale(zoom.value, dpr.value))) ??
      c.get(cacheKey(pageId, PLACEHOLDER_SCALE))
    )
  }

  function setZoom(z: number): void {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
    if (clamped === zoom.value) return
    zoom.value = clamped
    dirty = true
  }

  function setAnchor(i: number): void {
    const clamped = Math.max(0, Math.min(doc.pageOrder.length - 1, i))
    if (clamped === anchorIndex.value) return
    anchorIndex.value = clamped
    dirty = true
  }

  /**
   * The only way to change `dpr` from outside the store — mirrors
   * `setZoom`. `dpr` feeds `effectiveScale` exactly like `zoom` does, so a
   * plain writable ref would let a caller change the render scale without
   * marking the plan dirty, leaving the viewer silently serving bitmaps
   * rendered at the old scale. Nothing currently calls this after the
   * store's initial creation, but Task 18's zoom UI and any future
   * DPR-change listener (a multi-monitor drag, browser page zoom) need it.
   */
  function setDpr(d: number): void {
    if (d === dpr.value) return
    dpr.value = d
    dirty = true
  }

  function invalidate(pageId: PageId): void {
    cache.value.invalidatePage(pageId)
    version.value++
    dirty = true
  }

  const fitMode = ref<FitMode>('width')

  function setFitMode(m: FitMode): void { fitMode.value = m }

  /** Called by the shell on container resize and on document open. */
  function applyFit(containerWidth: number, containerHeight: number, geometry: PageGeometry): void {
    if (fitMode.value === 'custom') return
    setZoom(computeFitZoom({ mode: fitMode.value, containerWidth, containerHeight, geometry }))
  }

  function zoomIn(): void { fitMode.value = 'custom'; setZoom(nextZoomStep(zoom.value, 1)) }
  function zoomOut(): void { fitMode.value = 'custom'; setZoom(nextZoomStep(zoom.value, -1)) }

  /**
   * Drain the render plan. Serialized: concurrent callers await the
   * in-flight pump rather than starting a second one, because MuPDF is not
   * reentrant and duplicate work is pure waste.
   *
   * Re-plans in a `while (dirty)` loop and checks `dirty` between renders
   * (A2) so a scroll mid-pump abandons a stale plan instead of grinding
   * through it before the page the user actually jumped to gets rendered.
   */
  async function pump(): Promise<void> {
    if (pumping) return pumping
    pumping = (async () => {
      try {
        while (dirty) {
          dirty = false
          const tasks = planRenders({
            pageOrder: doc.pageOrder,
            pages: doc.pages,
            anchorIndex: anchorIndex.value,
            visibleRadius: VISIBLE_RADIUS,
            zoom: zoom.value,
            dpr: dpr.value,
            cache: cache.value,
          })
          for (const task of tasks) {
            if (dirty) break // stale plan — abandon it, the outer loop re-plans
            const key = cacheKey(task.pageId, task.scale)
            if (cache.value.has(key)) continue
            // A rejection here (worker died post-boot; a render racing
            // `closeSharedDocument()` from `doc.reset()`) used to propagate
            // out of this loop, clearing `pumping` and rejecting a promise
            // every caller discards with `void` — leaving every page stuck
            // as a pulsing placeholder with `dirty` already false, so
            // nothing would ever re-plan. Catch it, record it, and move on
            // to the next task instead of abandoning the whole drain.
            let result
            try {
              result = await getPdfClient().render(task.sourceIndex, task.scale)
            } catch (e) {
              lastError.value = e instanceof Error ? e.message : String(e)
              continue
            }
            if (!result) continue // never started (should not happen in practice; render() has no cancellation path)
            cache.value.set(key, result)
            version.value++
          }
        }
      } finally {
        pumping = undefined
      }
    })()
    return pumping
  }

  const zoomPercent = computed(() => Math.round(zoom.value * 100))

  // `zoom`, `dpr`, and `anchorIndex` are read-only outside the store — see
  // the invariant comment by `dirty` above. External code that needs to
  // change any of them calls `setZoom`/`setDpr`/`setAnchor`, which own
  // marking the plan dirty.
  return {
    zoom: readonly(zoom),
    anchorIndex: readonly(anchorIndex),
    dpr: readonly(dpr),
    zoomPercent,
    lastError: readonly(lastError),
    fitMode,
    bitmapFor,
    setZoom,
    setAnchor,
    setDpr,
    invalidate,
    pump,
    setFitMode,
    applyFit,
    zoomIn,
    zoomOut,
  }
})
