import type { PageGeometry } from '@margin/transform'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'

export const LETTER: PageGeometry = { cropBox: [0, 0, 612, 792], rotate: 0 }

/**
 * Put a ready document in the stores without going through the worker.
 *
 * Since Task 43 `doc.pages` and `doc.pageOrder` are GETTERS over the edit
 * store, so a test can no longer `$patch` them directly. Seeding takes two
 * halves — the source's intrinsic geometry on the document store, and the
 * page entries on the edit store — and this keeps that in one place.
 *
 * `sourceIndex` is explicit so a test can make display order differ from
 * source order, which is the whole point of having both.
 */
export function seedDocument(
  entries: Array<{ id: string; sourceIndex: number }>,
  geometries: PageGeometry[] = entries.map(() => LETTER),
): void {
  const doc = useDocumentStore()
  const edits = useEditsStore()

  doc.$patch({
    status: 'ready',
    fileName: 'a.pdf',
    fileSize: 1,
    sourceHash: 'h',
    sources: {
      'src-0': {
        id: 'src-0',
        name: 'a.pdf',
        size: 1,
        hash: 'h',
        pageCount: geometries.length,
        geometries,
      },
    },
  })

  edits.reset(
    { 'src-0': { hash: 'h', name: 'a.pdf' } },
    entries.map((e) => e.id),
    Object.fromEntries(
      entries.map((e) => [
        e.id,
        { sourceId: 'src-0', sourceIndex: e.sourceIndex, rotation: 0, cropBox: null },
      ]),
    ),
  )
}

/** `n` pages in source order, ids `p0..p(n-1)`. */
export function seedPages(n: number, geometry: PageGeometry = LETTER): void {
  seedDocument(
    Array.from({ length: n }, (_, i) => ({ id: `p${i}`, sourceIndex: i })),
    Array.from({ length: n }, () => geometry),
  )
}
