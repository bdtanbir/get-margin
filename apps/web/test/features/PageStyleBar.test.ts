import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import type { TextObject } from '@margin/pdf-core'
import PageStyleBar from '@/features/pages/PageStyleBar.vue'
import PageGrid from '@/features/pages/PageGrid.vue'
import Inspector from '@/features/tools/Inspector.vue'
import { DESKTOP_MIN_PX } from '@/lib/breakpoint'
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

  /**
   * ONE surface per shell, never two. The desktop panel is where every other
   * set of properties in the app lives; the phone has no such panel -- its
   * inspector is a sheet that opens only for a selected OBJECT -- so the
   * grid carries the bar there and nowhere else.
   */
  describe('where it appears', () => {
    async function resizeTo(px: number): Promise<void> {
      window.innerWidth = px
      window.dispatchEvent(new Event('resize'))
      await nextTick()
    }

    it('is in the properties panel once a page is selected', async () => {
      const w = mount(Inspector)
      expect(w.find('[data-page-style-bar]').exists()).toBe(false)
      selection.selectOnly('p1')
      await nextTick()
      expect(w.find('[data-page-style-bar]').exists()).toBe(true)
    })

    it('gives way to an object\'s own properties', async () => {
      addText('t1', 'p0', 'left')
      selection.selectOnly('p0')
      edits.select(['t1'])
      const w = mount(Inspector)
      await nextTick()
      expect(w.find('[data-page-style-bar]').exists()).toBe(false)
    })

    it('is not also in the grid on desktop', async () => {
      await resizeTo(DESKTOP_MIN_PX)
      const w = mount(PageGrid)
      await w.get('[data-page-tile="p1"]').trigger('click')
      expect(w.find('[data-page-style-bar]').exists()).toBe(false)
    })

    it('is in the grid on a phone, which has no properties panel', async () => {
      await resizeTo(DESKTOP_MIN_PX - 1)
      const w = mount(PageGrid)
      expect(w.find('[data-page-style-bar]').exists()).toBe(false)
      await w.get('[data-page-tile="p1"]').trigger('click')
      expect(w.find('[data-page-style-bar]').exists()).toBe(true)
      await resizeTo(DESKTOP_MIN_PX)
    })
  })
})
