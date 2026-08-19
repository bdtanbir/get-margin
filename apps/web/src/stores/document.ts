import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { looksLikePdf } from '@margin/pdf-core'
import type { PageGeometry } from '@margin/transform'
import { getPdfClient, closeSharedDocument } from '@/workers/pdfClient'
import { checkFileSize, checkPageCount } from '@/lib/limits'
import { sha256Hex } from '@/lib/hash'
import { useEditsStore } from '@/stores/edits'

export type PageId = string

export type PageState = {
  id: PageId
  /** Index in the ORIGINAL document. Never used for display ordering. */
  sourceIndex: number
  geometry: PageGeometry
}

export type DocStatus = 'empty' | 'opening' | 'needs-password' | 'ready' | 'error'

type State = {
  status: DocStatus
  fileName: string
  fileSize: number
  sourceHash: string
  /** Display order. Phase 3 mutates this; nothing else may. */
  pageOrder: PageId[]
  pages: Record<PageId, PageState>
  error: string
}

export const useDocumentStore = defineStore('document', {
  state: (): State => ({
    status: 'empty',
    fileName: '',
    fileSize: 0,
    sourceHash: '',
    pageOrder: [],
    pages: {},
    error: '',
  }),

  getters: {
    pageCount: (s): number => s.pageOrder.length,
    isReady: (s): boolean => s.status === 'ready',
  },

  actions: {
    geometryOf(id: PageId): PageGeometry | undefined {
      return this.pages[id]?.geometry
    },

    // Internal helper, not part of the public store API. Named with a
    // leading underscore rather than `#private` — `#` methods aren't valid
    // syntax in a Pinia options-store action object literal.
    _applyInfo(info: { pageCount: number; geometries: PageGeometry[] }): void {
      const order: PageId[] = []
      const pages: Record<PageId, PageState> = {}
      for (let i = 0; i < info.pageCount; i++) {
        const geometry = info.geometries[i]
        if (!geometry) throw new Error(`missing geometry for page ${i}`)
        const id = nanoid(10)
        order.push(id)
        pages[id] = { id, sourceIndex: i, geometry }
      }
      this.pageOrder = order
      this.pages = pages

      // Objects reference a synthetic pageId, never a page index (spec
      // 1.2b) -- so the edit store must be seeded with THESE ids, from the
      // one place they are minted. Deriving them a second time elsewhere is
      // how objects end up orphaned or attributed to the wrong page.
      useEditsStore().reset(
        this.sourceHash,
        order,
        Object.fromEntries(order.map((id, i) => [id, { sourceIndex: i }])),
      )
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
      this.pageOrder = []
      this.pages = {}
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
          this.pageOrder = []
          this.pages = {}
          this.status = 'needs-password'
          return
        }

        const count = checkPageCount(info.pageCount)
        if (!count.ok) {
          this.status = 'error'
          this.error = count.message
          return
        }

        this._applyInfo(info)
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
        this._applyInfo(info)
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
      this.$reset()
    },
  },
})
