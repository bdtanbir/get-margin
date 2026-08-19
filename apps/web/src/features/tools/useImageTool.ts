import { nanoid } from 'nanoid'
import type { ImageObject, EditObject } from '@margin/pdf-core'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { importImage, placementRect } from './importImage'

/**
 * The Image tool is a file picker, not a drag gesture: there is nothing to
 * draw until a file exists. Picking one places it centred on the anchor page
 * and hands it to the select tool, so the very next thing the user does is
 * position it.
 */
export function useImageTool() {
  const doc = useDocumentStore()
  const edits = useEditsStore()
  const tools = useToolsStore()

  async function place(file: File, pageId?: string): Promise<void> {
    const target = pageId ?? doc.pageOrder[0]
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
