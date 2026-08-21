import { nanoid } from 'nanoid'
import type { ImageObject, EditObject } from '@margin/pdf-core'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { useViewportStore } from '@/stores/viewport'
import { importImage, placementRect } from './importImage'

/**
 * The Image tool is a file picker, not a drag gesture: there is nothing to
 * draw until a file exists. Picking one places it centred on the page in
 * view and hands it to the select tool, so the very next thing the user
 * does is position it.
 */
export function useImageTool() {
  const doc = useDocumentStore()
  const edits = useEditsStore()
  const tools = useToolsStore()
  const vp = useViewportStore()

  async function place(file: File, pageId?: string): Promise<void> {
    // The page in view, not the first page: an image picked while page
    // three was on screen belongs on page three. An explicit `pageId` (a
    // file dropped onto a page) still wins over where the user happens to
    // be scrolled.
    const target = pageId ?? vp.anchorPageId
    const page = target ? doc.pages[target] : undefined
    if (!page) return

    // Errors surface on the document store, the one place the shells already
    // render a message from; throwing here would leave a silent no-op.
    let imported
    try {
      imported = await importImage(file)
    } catch (e) {
      doc.error = e instanceof Error ? e.message : 'Could not place that image.'
      return
    }

    const [x0, y0, x1, y1] = page.geometry.cropBox
    const centre = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
    const object: ImageObject = {
      id: nanoid(10),
      pageId: page.id,
      kind: 'image',
      data: imported.data,
      mime: imported.mime,
      rect: placementRect(imported, centre),
      rotation: 0,
      z: edits.nextZ(),
      locked: false,
      opacity: 1,
    }
    edits.applyOp({ type: 'addObject', object: object as EditObject }, 'Place image')
    tools.setTool('select')
    edits.select([object.id])
  }

  return { place }
}
