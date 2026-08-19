import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { looksLikePdf } from '@margin/pdf-core'
import { normalizeRotation, type PageGeometry } from '@margin/transform'
import { getPdfClient, closeSharedDocument } from '@/workers/pdfClient'
import { checkFileSize, checkPageCount } from '@/lib/limits'
import { sha256Hex } from '@/lib/hash'
import { useEditsStore } from '@/stores/edits'

export type PageId = string
export type SourceId = string

export type PageState = {
  id: PageId
  /** Index in the ORIGINAL document. Never used for display ordering. */
  sourceIndex: number
  /**
   * EFFECTIVE geometry: the source page's own box and rotation with the
   * edit store's crop and rotation overrides folded in. Every consumer in
   * the app reads this and none of them need to know an override exists.
   */
  geometry: PageGeometry
}

/** One opened file. Facts about a file, never edited. */
export type SourceState = {
  id: SourceId
  name: string
  size: number
  hash: string
  pageCount: number
  /** Intrinsic geometry of each page, as the FILE has it. Never mutated. */
  geometries: PageGeometry[]
}

/**
 * Memo for the `pages` getter, keyed by page id.
 *
 * `edits.doc` is replaced wholesale by Immer on EVERY op, so the getter
 * recomputes whenever any object is added or dragged. Without this, each
 * recompute would hand PageCanvas and PageOverlay a fresh PageState object
 * and re-render every mounted page sixty times a second during a drag.
 *
 * The key is derived from every input the value depends on, so a hit can
 * never be stale.
 */
const pageStateCache = new Map<PageId, { key: string; state: PageState }>()

export type DocStatus = 'empty' | 'opening' | 'needs-password' | 'ready' | 'error'

type State = {
  status: DocStatus
  /** The file the user opened first. Merge adds sources, not more of these. */
  fileName: string
  fileSize: number
  sourceHash: string
  /**
   * Every opened file. Page ORDER and per-page overrides live in the edit
   * store, because those are undoable and these are not.
   */
  sources: Record<SourceId, SourceState>
  error: string
}

export const useDocumentStore = defineStore('document', {
  state: (): State => ({
    status: 'empty',
    fileName: '',
    fileSize: 0,
    sourceHash: '',
    sources: {},
    error: '',
  }),

  getters: {
    /**
     * Display order, owned by the EDIT store so reordering is undoable
     * alongside object edits (PLAN.md 1.2). This getter exists so PageList,
     * ThumbnailPanel and everything else keep reading `doc.pageOrder`
     * exactly as they did in Phase 1.
     */
    pageOrder(): PageId[] {
      // Filtered against `pages` so the two can never disagree. Every
      // consumer indexes `pages` BY `pageOrder` (PageList, ThumbnailPanel),
      // so an id here that `pages` cannot resolve is an undefined page prop
      // rather than a missing thumbnail.
      const resolvable = this.pages
      return useEditsStore().doc.pageOrder.filter((id) => resolvable[id])
    },

    /**
     * EFFECTIVE page state: each source page's intrinsic geometry with the
     * edit store's rotation and crop folded in.
     *
     * Returning effective geometry HERE is what keeps Phase 3 cheap --
     * seventeen call sites read `page.geometry` (PageCanvas, PageOverlay,
     * SelectionChrome, useDrawTool, InkCanvas, Thumbnail, ...) and not one
     * of them needs to know a page was rotated or cropped.
     */
    pages(): Record<PageId, PageState> {
      const edits = useEditsStore()
      const out: Record<PageId, PageState> = {}
      for (const [id, entry] of Object.entries(edits.doc.pages)) {
        const base = this.sources[entry.sourceId]?.geometries[entry.sourceIndex]
        // A page whose source is not loaded yet simply does not render;
        // throwing here would take the whole viewer down mid-merge.
        if (!base) continue

        const key = [
          entry.sourceId, entry.sourceIndex, entry.rotation,
          entry.cropBox?.join(',') ?? '-', base.cropBox.join(','), base.rotate,
        ].join('|')

        const hit = pageStateCache.get(id)
        if (hit?.key === key) {
          out[id] = hit.state
          continue
        }

        const state: PageState = {
          id,
          sourceIndex: entry.sourceIndex,
          geometry: {
            cropBox: entry.cropBox ?? base.cropBox,
            rotate: normalizeRotation(base.rotate + entry.rotation),
          },
        }
        pageStateCache.set(id, { key, state })
        out[id] = state
      }
      return out
    },

    pageCount(): number {
      return this.pageOrder.length
    },
    isReady(): boolean {
      return this.status === 'ready'
    },
  },

  actions: {
    geometryOf(id: PageId): PageGeometry | undefined {
      return this.pages[id]?.geometry
    },

    /**
     * Register an opened file: record its intrinsic geometry, mint a page
     * id per source page, and put those pages into the edit document.
     *
     * Page ids are minted HERE, in the one place, and handed straight to
     * the edit store -- deriving them a second time elsewhere is how
     * objects end up attributed to the wrong page (spec 1.2b).
     *
     * The first source resets the edit document; a later one arrives as an
     * `insertPages` op carrying its own source registration, so adding a
     * document to a merge is undoable like any other page operation.
     */
    addSource(info: {
      id: SourceId
      name: string
      size: number
      hash: string
      geometries: PageGeometry[]
    }): SourceId {
      const edits = useEditsStore()
      // The id comes from the WORKER, which is where the bytes actually
      // live. Minting a second one here would leave the two sides
      // disagreeing about which file a page came from.
      const id = info.id

      this.sources[id] = {
        id,
        name: info.name,
        size: info.size,
        hash: info.hash,
        pageCount: info.geometries.length,
        geometries: info.geometries,
      }

      const entries = info.geometries.map((_, i) => ({
        id: nanoid(10),
        sourceId: id,
        sourceIndex: i,
        rotation: 0,
        cropBox: null,
      }))

      if (Object.keys(edits.doc.sources).length === 0) {
        edits.reset(
          { [id]: { hash: info.hash, name: info.name } },
          entries.map((e) => e.id),
          Object.fromEntries(entries.map(({ id: pageId, ...rest }) => [pageId, rest])),
        )
      } else {
        edits.applyOp(
          {
            type: 'insertPages',
            at: Number.MAX_SAFE_INTEGER,
            source: { id, hash: info.hash, name: info.name },
            pages: entries,
          },
          `Add ${info.name}`,
        )
      }
      return id
    },

    async openFile(file: File): Promise<void> {
      this.error = ''
      this.status = 'opening'
      this.fileName = file.name
      this.fileSize = file.size
      // Clear any previously open document's page state up front, not just
      // on the success paths below — otherwise a document opened after a
      // corrupt one keeps reporting the PREVIOUS document's page ids while
      // sitting in an 'error' status.
      // Page order and page state are getters over the EDIT store now, so
      // emptying the document means clearing both halves: the sources here
      // and the edit document itself. Clearing only one leaves a closed
      // document still reporting its pages.
      this.sources = {}
      pageStateCache.clear()
      useEditsStore().reset({}, [], {})
      this.sourceHash = ''

      const size = checkFileSize(file.size)
      if (!size.ok) {
        this.status = 'error'
        this.error = size.message
        return
      }

      try {
        const buf = await file.arrayBuffer()

        // Spec §4: validate magic bytes, not the extension. A .pdf that is
        // actually a zip must be refused before it reaches the parser.
        if (!looksLikePdf(new Uint8Array(buf.slice(0, 1024)))) {
          this.status = 'error'
          this.error = 'That file is not a PDF. Check the file and try again.'
          return
        }

        // Hash first — the transfer below neuters this buffer.
        this.sourceHash = await sha256Hex(buf)

        const info = await getPdfClient().open(new Uint8Array(buf))

        if (info.needsPassword) {
          this.sources = {}
          useEditsStore().reset({}, [], {})
          this.status = 'needs-password'
          return
        }

        const count = checkPageCount(info.pageCount)
        if (!count.ok) {
          this.status = 'error'
          this.error = count.message
          return
        }

        this.addSource({
          id: info.sourceId,
          name: file.name,
          size: file.size,
          hash: this.sourceHash,
          geometries: info.geometries,
        })
        this.status = 'ready'
      } catch (e) {
        this.status = 'error'
        // Comlink reconstructs errors crossing the worker boundary as plain
        // `Error` objects — the original prototype chain (e.g. PdfOpenError)
        // is lost, so this must not (and cannot reliably) branch on the
        // specific error class. `.message` is all that survives intact.
        this.error = e instanceof Error ? e.message : 'Could not open that PDF.'
      }
    },

    async submitPassword(password: string): Promise<void> {
      this.error = ''
      try {
        const info = await getPdfClient().authenticate(password)
        const count = checkPageCount(info.pageCount)
        if (!count.ok) {
          this.status = 'error'
          this.error = count.message
          return
        }
        this.addSource({
          id: info.sourceId,
          name: this.fileName,
          size: this.fileSize,
          hash: this.sourceHash,
          geometries: info.geometries,
        })
        this.status = 'ready'
      } catch (e) {
        // Stay in needs-password so the user can retry without re-picking the file.
        this.status = 'needs-password'
        this.error = e instanceof Error ? e.message : 'Incorrect password'
      }
    },

    async reset(): Promise<void> {
      // Close the shared client's document only if a worker was ever
      // created — constructing one here just to close it would load ~10MB
      // of WASM on a reset from an already-empty state.
      await closeSharedDocument()
      pageStateCache.clear()
      // $reset() only clears THIS store; the pages live in the edit store.
      useEditsStore().reset({}, [], {})
      this.$reset()
    },
  },
})
