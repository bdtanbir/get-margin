import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SelectionChrome from '@/features/overlay/SelectionChrome.vue'
import { pageAtPoint, pageBoxes, type PageBox } from '@/features/overlay/pageBoxes'
import { useEditsStore } from '@/stores/edits'
import { useDocumentStore } from '@/stores/document'
import { seedDocument } from '../helpers/seedDocument'
import type { EditObject } from '@margin/pdf-core'

/**
 * Two letter pages stacked the way the scroller lays them out: page one at
 * client y 0, page two 20px below it. x is the same for both because the
 * list centres every page in one column.
 */
const P1 = { left: 100, top: 0, width: 612, height: 792 }
const P2 = { left: 100, top: 812, width: 612, height: 792 }

function fakePage(id: string, box: typeof P1): HTMLElement {
  const el = document.createElement('div')
  el.dataset.pageId = id
  document.body.appendChild(el)
  el.getBoundingClientRect = () => ({
    ...box, right: box.left + box.width, bottom: box.top + box.height,
    x: box.left, y: box.top, toJSON: () => ({}),
  })
  return el
}

const object: EditObject = {
  id: 'o1', pageId: 'p1', kind: 'image',
  rect: { x: 100, y: 200, w: 80, h: 40 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  data: new Uint8Array([1]), mime: 'image/png',
} as EditObject

function move(x: number, y: number): void {
  const e = new Event('pointermove', { bubbles: true }) as PointerEvent
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 })
  window.dispatchEvent(e)
}
function up(): void {
  window.dispatchEvent(new Event('pointerup', { bubbles: true }))
}

describe('pageAtPoint', () => {
  const boxes: PageBox[] = [{ id: 'p1', ...P1 }, { id: 'p2', ...P2 }]

  it('finds the page a client point lands on', () => {
    expect(pageAtPoint(200, 400, boxes)?.id).toBe('p1')
    expect(pageAtPoint(200, 1000, boxes)?.id).toBe('p2')
  })

  // The gutter between two sheets belongs to neither, and a drop there must
  // not silently reassign the object to a page the pointer is not over.
  it('returns nothing for the gap between two pages', () => {
    expect(pageAtPoint(200, 800, boxes)).toBeUndefined()
  })

  it('returns nothing beside the pages', () => {
    expect(pageAtPoint(50, 400, boxes)).toBeUndefined()
  })
})

describe('pageBoxes', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('reads every mounted page box out of the DOM', () => {
    fakePage('p1', P1)
    fakePage('p2', P2)
    expect(pageBoxes().map((b) => b.id)).toEqual(['p1', 'p2'])
  })

  // An element with no measured box (jsdom, or a page not laid out yet) is
  // not a drop target: treating a 0x0 rect as a page would land every drop
  // on whichever placeholder happened to come first.
  it('ignores elements with no measured box', () => {
    const el = document.createElement('div')
    el.dataset.pageId = 'ghost'
    document.body.appendChild(el)
    expect(pageBoxes()).toEqual([])
  })
})

describe('moving an object between pages', () => {
  let edits: ReturnType<typeof useEditsStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    seedDocument([{ id: 'p1', sourceIndex: 0 }, { id: 'p2', sourceIndex: 1 }])
    edits.applyOp({ type: 'addObject', object }, 'add')
    edits.select(['o1'])
    fakePage('p1', P1)
    fakePage('p2', P2)
  })

  afterEach(() => { document.body.innerHTML = '' })

  const chrome = () => {
    const doc = useDocumentStore()
    return mount(SelectionChrome, { props: { page: doc.pages['p1']!, zoom: 1 } })
  }

  /**
   * The bug this pins: an object dropped on another page stayed owned by the
   * page it started on, so it hung off that page's sheet and was clipped by
   * the page's own edge instead of moving.
   */
  it('hands the object to the page the pointer is over', async () => {
    const w = chrome()
    await w.get('[data-selection]').trigger('pointerdown', { clientX: 200, clientY: 600, pointerId: 1 })
    move(200, 1000)
    up()

    const moved = edits.doc.objects['o1']!
    expect(moved.pageId).toBe('p2')
    // The object keeps its size and its place under the pointer: the box's
    // top-left travelled 400px down, landing 140px below page two's top.
    expect(moved.rect).toEqual({ x: 100, y: 612, w: 80, h: 40 })
  })

  it('leaves the object where it is when the drop lands in the gutter', async () => {
    const w = chrome()
    await w.get('[data-selection]').trigger('pointerdown', { clientX: 200, clientY: 600, pointerId: 1 })
    move(200, 800)
    up()

    expect(edits.doc.objects['o1']!.pageId).toBe('p1')
  })

  // One drag is one undo step whichever pages it crosses.
  it('records the whole cross-page drag as a single history entry', async () => {
    const before = edits.historySize
    const w = chrome()
    await w.get('[data-selection]').trigger('pointerdown', { clientX: 200, clientY: 600, pointerId: 1 })
    move(200, 950)
    move(200, 1000)
    up()

    expect(edits.historySize).toBe(before + 1)
    edits.undo()
    expect(edits.doc.objects['o1']!.pageId).toBe('p1')
    expect(edits.doc.objects['o1']!.rect).toEqual({ x: 100, y: 200, w: 80, h: 40 })
  })

  it('keeps a locked object on its page', async () => {
    edits.applyOp({ type: 'updateObject', id: 'o1', patch: { locked: true } }, 'lock')
    const w = chrome()
    await w.get('[data-selection]').trigger('pointerdown', { clientX: 200, clientY: 600, pointerId: 1 })
    move(200, 1000)
    up()

    expect(edits.doc.objects['o1']!.pageId).toBe('p1')
  })
})
