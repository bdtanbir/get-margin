import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PatchedAreaObject from '@/features/overlay/objects/PatchedAreaObject.vue'
import type { ImagePatchObject } from '@margin/pdf-core'

/**
 * The preview has to draw what the export will produce. The two share
 * their bleed constant and their defaults on purpose; these pin the
 * geometry so the pair cannot drift apart unnoticed.
 */
const patch = (over: Record<string, unknown> = {}): ImagePatchObject => ({
  id: 'ip1', pageId: 'p1', kind: 'imagePatch',
  imageIndex: 0, originalHash: 'aaaa1111',
  background: [1, 1, 1], backgroundConfidence: 1,
  rect: { x: 50, y: 60, w: 200, h: 100 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  ...over,
} as unknown as ImagePatchObject)

const render = (o: ImagePatchObject) => mount(PatchedAreaObject, { props: { object: o } })

describe('PatchedAreaObject', () => {
  it('covers the area, a little wider than the area itself', () => {
    const rect = render(patch()).get('rect')
    // The writer's bleed is 0.75pt on every side.
    expect(Number(rect.attributes('x'))).toBeCloseTo(49.25, 2)
    expect(Number(rect.attributes('width'))).toBeCloseTo(201.5, 2)
  })

  it('draws nothing over the cover while it carries nothing', () => {
    expect(render(patch()).find('image').exists()).toBe(false)
  })

  it('draws the copy at the covered area’s size by default', () => {
    const image = render(patch({ data: new Uint8Array([1]) })).get('image')
    expect(image.attributes('width')).toBe('200')
    expect(image.attributes('height')).toBe('100')
  })

  it('draws the copy at its own size once it has one', () => {
    const image = render(patch({ data: new Uint8Array([1]), size: { w: 60, h: 30 } })).get('image')
    expect(image.attributes('width')).toBe('60')
    expect(image.attributes('height')).toBe('30')
  })

  /** The cover stays put however the copy is resized or moved. */
  it('leaves the cover alone when the copy is resized and moved', () => {
    const w = render(patch({
      data: new Uint8Array([1]), size: { w: 60, h: 30 }, offset: { dx: 40, dy: 20 },
    }))
    expect(Number(w.get('rect').attributes('x'))).toBeCloseTo(49.25, 2)
    expect(Number(w.get('rect').attributes('width'))).toBeCloseTo(201.5, 2)
    expect(w.get('image').attributes('x')).toBe('90')
    expect(w.get('image').attributes('y')).toBe('80')
  })
})
