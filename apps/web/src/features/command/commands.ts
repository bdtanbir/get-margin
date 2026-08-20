import { computed, type ComputedRef } from 'vue'
import { TOOLS } from '@/features/tools/toolList'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { usePageSelectionStore } from '@/stores/pageSelection'
import { useViewportStore } from '@/stores/viewport'
import { useDialogsStore } from '@/stores/dialogs'

export type Command = {
  id: string
  label: string
  group: string
  run: () => void
  /** False hides it: a command that cannot work should not be offered. */
  available: () => boolean
}

/**
 * Every command the palette can run.
 *
 * Tool commands are DERIVED from toolList.ts rather than repeated here.
 * Two hand-maintained lists of the same tools is how a palette silently
 * falls behind the rail, and a test asserts every tool is reachable so it
 * cannot happen quietly.
 */
export function useCommands(): ComputedRef<Command[]> {
  const doc = useDocumentStore()
  const edits = useEditsStore()
  const tools = useToolsStore()
  const selection = usePageSelectionStore()
  const vp = useViewportStore()
  const dialogs = useDialogsStore()

  return computed<Command[]>(() => {
    const hasDocument = () => doc.isReady
    const hasPageSelection = () => doc.isReady && selection.count > 0

    const toolCommands: Command[] = TOOLS.map((tool) => ({
      id: `tool:${tool.id}`,
      label: tool.label,
      group: 'Tools',
      run: () => tools.setTool(tool.id),
      available: hasDocument,
    }))

    const pageCommands: Command[] = [
      {
        id: 'page:rotate-right',
        label: 'Rotate selected pages right',
        group: 'Pages',
        available: hasPageSelection,
        run: () => {
          const ids = [...selection.selected]
          edits.withTransaction('Rotate pages', () => {
            for (const id of ids) edits.applyOp({ type: 'rotatePage', pageId: id, by: 90 }, 'Rotate')
          })
          for (const id of ids) vp.invalidate(id)
        },
      },
      {
        id: 'page:rotate-left',
        label: 'Rotate selected pages left',
        group: 'Pages',
        available: hasPageSelection,
        run: () => {
          const ids = [...selection.selected]
          edits.withTransaction('Rotate pages', () => {
            for (const id of ids) edits.applyOp({ type: 'rotatePage', pageId: id, by: 270 }, 'Rotate')
          })
          for (const id of ids) vp.invalidate(id)
        },
      },
      {
        id: 'page:delete',
        label: 'Delete selected pages',
        group: 'Pages',
        available: hasPageSelection,
        run: () => {
          edits.applyOp({ type: 'deletePages', pageIds: [...selection.selected] }, 'Delete pages')
          selection.prune(doc.pageOrder)
        },
      },
    ]

    const documentCommands: Command[] = [
      {
        // Document-wide operations have no home in the tool rail: they act
        // on the whole file rather than on a place in it, so the palette is
        // where they live.
        id: 'doc:stamp',
        label: 'Watermark, page numbers, header, footer…',
        group: 'Document',
        available: hasDocument,
        run: () => dialogs.show('stamp'),
      },
      {
        id: 'doc:protect',
        label: 'Protect with a password…',
        group: 'Document',
        available: hasDocument,
        run: () => dialogs.show('protect'),
      },
      {
        id: 'doc:metadata',
        label: 'Document details…',
        group: 'Document',
        available: hasDocument,
        run: () => dialogs.show('metadata'),
      },
      {
        id: 'doc:compress',
        label: 'Make the file smaller…',
        group: 'Document',
        available: hasDocument,
        run: () => dialogs.show('compress'),
      },
      {
        id: 'app:help',
        label: 'Help and keyboard shortcuts…',
        group: 'App',
        // Available with no document open: someone who has just arrived is
        // exactly who needs it.
        available: () => true,
        run: () => dialogs.show('help'),
      },
      {
        id: 'doc:images',
        label: 'Export as images…',
        group: 'Document',
        available: hasDocument,
        run: () => dialogs.show('images'),
      },
      {
        id: 'doc:find',
        label: 'Find in document…',
        group: 'Document',
        available: hasDocument,
        run: () => dialogs.show('find'),
      },
      {
        id: 'doc:undo',
        label: 'Undo',
        group: 'Document',
        available: () => edits.canUndo,
        run: () => edits.undo(),
      },
      {
        id: 'doc:redo',
        label: 'Redo',
        group: 'Document',
        available: () => edits.canRedo,
        run: () => edits.redo(),
      },
      {
        id: 'view:zoom-in',
        label: 'Zoom in',
        group: 'View',
        available: hasDocument,
        run: () => vp.zoomIn(),
      },
      {
        id: 'view:zoom-out',
        label: 'Zoom out',
        group: 'View',
        available: hasDocument,
        run: () => vp.zoomOut(),
      },
      {
        id: 'view:fit-width',
        label: 'Fit width',
        group: 'View',
        available: hasDocument,
        run: () => vp.setFitMode('width'),
      },
      {
        id: 'view:actual-size',
        label: 'Actual size',
        group: 'View',
        available: hasDocument,
        run: () => {
          vp.setFitMode('actual')
          vp.setZoom(1)
        },
      },
    ]

    return [...toolCommands, ...pageCommands, ...documentCommands]
  })
}

/**
 * Case-insensitive subsequence match, so "rsp" finds "Rotate selected
 * pages". Exact substring hits rank first, because when someone types a
 * whole word they mean that word.
 */
export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands

  const scored: Array<{ command: Command; score: number }> = []
  for (const command of commands) {
    const label = command.label.toLowerCase()
    const substring = label.indexOf(q)
    if (substring >= 0) {
      scored.push({ command, score: substring })
      continue
    }
    let i = 0
    for (const ch of label) {
      if (ch === q[i]) i++
      if (i === q.length) break
    }
    if (i === q.length) scored.push({ command, score: 1000 })
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.command)
}
