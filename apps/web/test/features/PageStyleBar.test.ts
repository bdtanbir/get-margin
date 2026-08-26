import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import type { TextObject } from '@margin/pdf-core'
import PageStyleBar from '@/features/pages/PageStyleBar.vue'
import PageGrid from '@/features/pages/PageGrid.vue'
import { useEditsStore } from '@/stores/edits'
import { usePageSelectionStore } from '@/stores/pageSelection'

import { seedPages } from '../helpers/seedDocument'

describe('PageStyleBar', () => {
  let edits: ReturnType<typeof useEditsStore>
  let selection: ReturnType<typeof usePageSelectionStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    seedPages(3)
    edits = useEditsStore()
    selection = usePageSelectionStore()
  })

  const bar = () => mount(PageStyleBar)

  function addText(id: string, pageId: string, align: TextObject['align']): void {
    edits.applyOp({
      type: 'addObject',
      object: {
        id, pageId, kind: 'text',
        rect: { x: 10, y: 10, w: 100, h: 20 },
        rotation: 0, z: 1, locked: false, opacity: 1,
        text: 'hello', fontFamily: 'Inter', bold: false, italic: false,
        fontSize: 14, color: [0, 0, 0], align,
      },
    }, 'Add text')
  }

  describe('background', () => {
    it('paints every selected page in one undo step', async () => {
      selection.selectOnly('p0')
      selection.toggle('p2')
      const w = bar()

      const input = w.get('[data-page-background-input]')
      ;(input.element as HTMLInputElement).value = '#ff0000'
      await input.trigger('input')
      await input.trigger('change')

      expect(edits.doc.pages.p0!.background).toEqual([1, 0, 0])
      expect(edits.doc.pages.p2!.background).toEqual([1, 0, 0])
      // Untouched: painting is scoped to the selection, not the document.
      expect(edits.doc.pages.p1!.background).toBeUndefined()

      edits.undo()
      expect(edits.doc.pages.p0!.background).toBeUndefined()
      expect(edits.doc.pages.p2!.background).toBeUndefined()
    })

    /**
     * A colour input fires an `input` per pixel of pointer travel. Without
     * the open transaction each frame of a drag is its own history entry and
     * undoing the choice takes thirty presses.
     */
    it('coalesces a drag across the picker into one history entry', async () => {
      selection.selectOnly('p0')
      const w = bar()
      const input = w.get('[data-page-background-input]')

      for (const hex of ['#110000', '#880000', '#ff0000']) {
        ;(input.element as HTMLInputElement).value = hex
        await input.trigger('input')
      }
      await input.trigger('change')

      expect(edits.doc.pages.p0!.background).toEqual([1, 0, 0])
      edits.undo()
      expect(edits.doc.pages.p0!.background).toBeUndefined()
    })

    it('shows the colour a page already has', () => {
      edits.applyOp({ type: 'setPageBackground', pageId: 'p0', color: [0, 0, 1] }, 'bg')
      selection.selectOnly('p0')
      const input = bar().get('[data-page-background-input]')
      expect((input.element as HTMLInputElement).value).toBe('#0000ff')
    })

    /**
     * A swatch showing the first page's colour for a selection of pages that
     * disagree would be a claim about the others that is not true -- and the
     * next click would silently repaint them all to a colour the user was
     * only shown as a description of one.
     */
    it('shows no opinion when the selected pages disagree', () => {
      edits.applyOp({ type: 'setPageBackground', pageId: 'p0', color: [0, 0, 1] }, 'bg')
      selection.selectOnly('p0')
      selection.toggle('p1')
      const input = bar().get('[data-page-background-input]')
      expect((input.element as HTMLInputElement).value).toBe('#000000')
    })

    it('removes the background rather than painting it white', async () => {
      edits.applyOp({ type: 'setPageBackground', pageId: 'p0', color: [0, 0, 1] }, 'bg')
      selection.selectOnly('p0')
      const w = bar()
      await w.get('[data-clear-page-background]').trigger('click')
      expect(edits.doc.pages.p0!.background).toBeUndefined()
      expect('background' in edits.doc.pages.p0!).toBe(false)
    })

    it('disables the remove button when there is nothing to remove', () => {
      selection.selectOnly('p0')
      const btn = bar().get('[data-clear-page-background]')
      expect(btn.attributes('disabled')).toBeDefined()
    })
  })

  describe('alignment', () => {
    it('aligns every text object on the selected pages in one undo step', async () => {
      addText('t1', 'p0', 'left')
      addText('t2', 'p0', 'left')
      selection.selectOnly('p0')
      const w = bar()

      await w.get('[data-align="center"]').trigger('click')
      expect((edits.doc.objects.t1 as TextObject).align).toBe('center')
      expect((edits.doc.objects.t2 as TextObject).align).toBe('center')

      edits.undo()
      expect((edits.doc.objects.t1 as TextObject).align).toBe('left')
      expect((edits.doc.objects.t2 as TextObject).align).toBe('left')
    })

    it('leaves text on pages that are not selected alone', async () => {
      addText('t1', 'p0', 'left')
      addText('t2', 'p1', 'left')
      selection.selectOnly('p0')
      await bar().get('[data-align="right"]').trigger('click')
      expect((edits.doc.objects.t1 as TextObject).align).toBe('right')
      expect((edits.doc.objects.t2 as TextObject).align).toBe('left')
    })

    it('presses the button the page already agrees on', () => {
      addText('t1', 'p0', 'right')
      addText('t2', 'p0', 'right')
      selection.selectOnly('p0')
      const w = bar()
      expect(w.get('[data-align="right"]').attributes('aria-pressed')).toBe('true')
      expect(w.get('[data-align="left"]').attributes('aria-pressed')).toBe('false')
    })

    it('presses nothing when the text disagrees', () => {
      addText('t1', 'p0', 'left')
      addText('t2', 'p0', 'center')
      selection.selectOnly('p0')
      const w = bar()
      for (const a of ['left', 'center', 'right']) {
        expect(w.get(`[data-align="${a}"]`).attributes('aria-pressed')).toBe('false')
      }
    })

    /**
     * This application cannot re-align a PDF's own text -- the glyphs are
     * placed at fixed coordinates and there is no paragraph to reflow. A page
     * with no text objects therefore has nothing these buttons can move, and
     * saying so beats three controls that look live and do nothing.
     */
    it('disables the buttons and says why when there is no text to align', () => {
      selection.selectOnly('p0')
      const w = bar()
      expect(w.get('[data-align="left"]').attributes('disabled')).toBeDefined()
      expect(w.get('[data-align-notice]').text()).toContain('text you add')
    })

    it('will not move a locked object', async () => {
      addText('t1', 'p0', 'left')
      edits.applyOp({ type: 'updateObject', id: 't1', patch: { locked: true } }, 'Lock')
      selection.selectOnly('p0')
      const w = bar()
      expect(w.get('[data-align="center"]').attributes('disabled')).toBeDefined()
    })
  })

  describe('in the grid', () => {
    it('appears only once a page is selected', async () => {
      const w = mount(PageGrid)
      expect(w.find('[data-page-style-bar]').exists()).toBe(false)
      await w.get('[data-page-tile="p1"]').trigger('click')
      expect(w.find('[data-page-style-bar]').exists()).toBe(true)
    })
  })
})
