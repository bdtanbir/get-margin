import { describe, it, expect, beforeEach, vi } from 'vitest'
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
import { useViewportStore } from '@/stores/viewport'

import { seedPages } from '../helpers/seedDocument'

describe('PageStyleBar', () => {
  let edits: ReturnType<typeof useEditsStore>
  let selection: ReturnType<typeof usePageSelectionStore>
  let vp: ReturnType<typeof useViewportStore>

  /**
   * What each page RENDERS as, which is where the swatch reads the paper
   * colour from. Stubbed rather than driven through the worker: the component
   * only asks the viewport store what a page looks like, and every case here
   * is about what it does with the answer.
   */
  let rendered: Record<string, [number, number, number]>

  function paperIs(id: string, rgb: [number, number, number]): void {
    rendered[id] = rgb
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    seedPages(3)
    edits = useEditsStore()
    selection = usePageSelectionStore()
    vp = useViewportStore()
    rendered = {}
    vi.spyOn(vp, 'bitmapFor').mockImplementation((id: string) => {
      const rgb = rendered[id] ?? [255, 255, 255]
      const w = 8
      const h = 8
      const buf = new Uint8Array(w * h * 4)
      for (let i = 0; i < buf.length; i += 4) {
        buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = 255
      }
      return { width: w, height: h, rgba: buf, page: 0, scale: 1 }
    })
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
     * THE REPORTED BUG. Open a document you exported a background onto and the
     * colour is baked into the file: nothing is stored, and the swatch showed
     * black while the page was plainly red. The paper is what the reader sees,
     * so the paper is what the swatch has to show.
     */
    it("shows a colour baked into the PDF, which nothing is stored for", () => {
      paperIs('p0', [255, 0, 0])
      selection.selectOnly('p0')
      const input = bar().get('[data-page-background-input]')
      expect((input.element as HTMLInputElement).value).toBe('#ff0000')
      // Nothing of ours is on it, so there is nothing to remove.
      expect(bar().get('[data-clear-page-background]').attributes('disabled')).toBeDefined()
    })

    /**
     * THE OTHER HALF OF THE SAME BUG. A background is MULTIPLIED over the
     * page, so on a page that was not white the stored colour and the colour
     * on screen are two different things. Showing the stored one would claim
     * a page is grey when it is in fact dark red.
     */
    it('shows the page, not the colour stored for it', () => {
      paperIs('p0', [255, 0, 0])
      edits.applyOp({ type: 'setPageBackground', pageId: 'p0', color: [0.5, 0.5, 0.5] }, 'bg')
      selection.selectOnly('p0')
      const input = bar().get('[data-page-background-input]')
      expect((input.element as HTMLInputElement).value).toBe('#800000')
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

    /**
     * THE MAGENTA CARD. A page is not guaranteed to have ONE paper colour:
     * the document that produced this test renders its margin orange and its
     * card white. An earlier version divided the sampled corner back out of
     * the pick, which on orange sent blue to 1 -- correct on the margin, and
     * on the white card it left blue at full strength, so a pick of red came
     * out magenta.
     *
     * What is stored is now the colour itself. A plain Multiply can never
     * raise a channel, so both papers move toward red instead of one of them
     * acquiring a cast.
     */
    it('stores the colour picked, unadjusted for whatever the page already is', async () => {
      paperIs('p0', [235, 115, 0])
      selection.selectOnly('p0')
      const w = bar()

      const input = w.get('[data-page-background-input]')
      ;(input.element as HTMLInputElement).value = '#ff0000'
      await input.trigger('input')
      await input.trigger('change')

      expect(edits.doc.pages.p0!.background).toEqual([1, 0, 0])
    })

    /**
     * Multiply only ever darkens, so no factor turns a red sheet blue. Saying
     * so is the alternative to silently producing mud, which is what the
     * report was about.
     */
    it('says so when the pick is lighter than the page already is', async () => {
      paperIs('p0', [255, 0, 0])
      selection.selectOnly('p0')
      const w = bar()
      expect(w.find('[data-unreachable-notice]').exists()).toBe(false)

      const input = w.get('[data-page-background-input]')
      ;(input.element as HTMLInputElement).value = '#0000ff'
      await input.trigger('input')
      await input.trigger('change')

      expect(w.get('[data-unreachable-notice]').text()).toContain('only')
    })

    it('is reported by the swatch as what the page has become', async () => {
      paperIs('p0', [235, 115, 0])
      selection.selectOnly('p0')
      const w = bar()

      const input = w.get('[data-page-background-input]')
      ;(input.element as HTMLInputElement).value = '#ff0000'
      await input.trigger('input')
      await input.trigger('change')

      // Orange x red is the orange's own red channel with the rest removed --
      // not the #ff0000 that was asked for, and the swatch says so rather
      // than repeating the request back.
      expect((w.get('[data-page-background-input]').element as HTMLInputElement).value)
        .toBe('#eb0000')
    })

    it('says nothing of the sort on an ordinary white page', async () => {
      selection.selectOnly('p0')
      const w = bar()
      const input = w.get('[data-page-background-input]')
      ;(input.element as HTMLInputElement).value = '#0000ff'
      await input.trigger('input')
      await input.trigger('change')
      expect(w.find('[data-unreachable-notice]').exists()).toBe(false)
    })

    /**
     * A factor that changes nothing is stored as no background at all, so an
     * untouched document stays untouched -- `replay` hands back the user's
     * original bytes when nothing is on them, and a neutral fill would defeat
     * that while being invisible.
     */
    it('stores nothing for white, which multiplies to no change at all', async () => {
      paperIs('p0', [255, 0, 0])
      selection.selectOnly('p0')
      const w = bar()
      const input = w.get('[data-page-background-input]')
      ;(input.element as HTMLInputElement).value = '#ffffff'
      await input.trigger('input')
      await input.trigger('change')
      expect(edits.doc.pages.p0!.background).toBeUndefined()
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
