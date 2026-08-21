import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useImageTool } from '@/features/tools/useImageTool'
import { useEditsStore } from '@/stores/edits'
import { useViewportStore } from '@/stores/viewport'
import { seedPages } from '../helpers/seedDocument'

/**
 * The decode/downscale pipeline needs a canvas and createImageBitmap, and
 * none of that is what these tests are about: they are about WHICH page an
 * inserted object lands on.
 */
vi.mock('@/features/tools/importImage', async () => {
  const actual = await vi.importActual<typeof import('@/features/tools/importImage')>(
    '@/features/tools/importImage',
  )
  return {
    ...actual,
    importImage: vi.fn(async () => ({
      data: new Uint8Array([1, 2, 3]), mime: 'image/png' as const, w: 100, h: 50,
    })),
  }
})

const file = new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' })

describe('inserting on the page in view', () => {
  let edits: ReturnType<typeof useEditsStore>
  let vp: ReturnType<typeof useViewportStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    vp = useViewportStore()
    seedPages(3)
  })

  const placed = () => Object.values(edits.doc.objects)[0]

  /**
   * The bug this pins: an image picked while page three was on screen was
   * placed on page one, off screen, and the user was left looking at an
   * unchanged page wondering where it went.
   */
  it('places an image on the page the user is looking at', async () => {
    vp.setAnchor(2)
    await useImageTool().place(file)
    expect(placed()?.pageId).toBe('p2')
  })

  it('places on the first page when that is the one in view', async () => {
    await useImageTool().place(file)
    expect(placed()?.pageId).toBe('p0')
  })

  // An explicit target still wins: dropping a file ONTO a page says which
  // page far more precisely than the scroll position does.
  it('honours an explicit page over the anchor', async () => {
    vp.setAnchor(2)
    await useImageTool().place(file, 'p1')
    expect(placed()?.pageId).toBe('p1')
  })

  it('exposes the anchor page id on the viewport store', () => {
    vp.setAnchor(1)
    expect(vp.anchorPageId).toBe('p1')
  })
})
