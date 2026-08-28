import { describe, it, expect } from 'vitest'
import { deleteOpFor } from '@/features/patch/patchDelete'
import type { EditObject } from '@margin/pdf-core'

const patch = (over: Record<string, unknown> = {}): EditObject => ({
  id: 'p1', pageId: 'pg', kind: 'imagePatch',
  imageIndex: 0, originalHash: 'aaaa1111',
  background: [1, 1, 1], backgroundConfidence: 1,
  rect: { x: 0, y: 0, w: 10, h: 10 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  ...over,
} as unknown as EditObject)

const rect = (): EditObject => ({
  id: 'r1', pageId: 'pg', kind: 'rect',
  rect: { x: 0, y: 0, w: 10, h: 10 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  stroke: [0, 0, 0], strokeWidth: 1, fill: null,
} as unknown as EditObject)

describe('what Delete means', () => {
  /**
   * A patch carrying a copy IS the thing the user is looking at. Deleting
   * the object would take the cover with it and put the document's own
   * content straight back -- so pressing Delete on a logo would leave the
   * logo exactly where it was, which reads as the button not working.
   */
  it('takes the copy off a patch that is carrying one, and keeps the cover', () => {
    const op = deleteOpFor(patch({ data: new Uint8Array([1]), mime: 'image/png' }))
    expect(op).toEqual({
      type: 'updateObject',
      id: 'p1',
      patch: { data: undefined, mime: undefined, offset: undefined },
    })
  })

  /**
   * Once it carries nothing, the only thing left to remove is the edit
   * itself -- which puts the page back as it was.
   */
  it('removes a patch that is carrying nothing', () => {
    expect(deleteOpFor(patch())).toEqual({ type: 'deleteObject', id: 'p1' })
  })

  it('treats an empty copy as no copy', () => {
    expect(deleteOpFor(patch({ data: new Uint8Array() }))).toEqual({
      type: 'deleteObject', id: 'p1',
    })
  })

  it('applies the same rule to a lifted area', () => {
    const lifted = patch({ kind: 'regionPatch', data: new Uint8Array([1]) })
    expect(deleteOpFor(lifted).type).toBe('updateObject')
  })

  it('deletes anything else outright, as it always did', () => {
    expect(deleteOpFor(rect())).toEqual({ type: 'deleteObject', id: 'r1' })
  })

  /**
   * A moved copy drops its offset with the copy. Without that, bringing
   * the same area back later would find it already displaced by a drag the
   * user cannot see any evidence of.
   */
  it('drops the offset along with the copy', () => {
    const op = deleteOpFor(patch({ data: new Uint8Array([1]), offset: { dx: 20, dy: 5 } }))
    expect(op).toMatchObject({ patch: { offset: undefined } })
  })
})
