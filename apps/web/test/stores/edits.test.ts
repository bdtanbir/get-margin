import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useEditsStore } from '@/stores/edits'
import type { EditObject } from '@margin/pdf-core'

function rectObject(id: string, pageId = 'p1'): EditObject {
  return {
    id, pageId, kind: 'rect',
    rect: { x: 10, y: 20, w: 100, h: 50 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    stroke: [0, 0, 0], strokeWidth: 1, fill: null,
  }
}

describe('useEditsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useEditsStore().reset('hash-abc', ['p1', 'p2'], { p1: { sourceIndex: 0 }, p2: { sourceIndex: 1 } })
  })

  it('starts empty with the given source hash', () => {
    const s = useEditsStore()
    expect(s.doc.sourceHash).toBe('hash-abc')
    expect(Object.keys(s.doc.objects)).toHaveLength(0)
    expect(s.canUndo).toBe(false)
  })

  it('adds an object through applyOp', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    expect(s.doc.objects.o1?.kind).toBe('rect')
    expect(s.canUndo).toBe(true)
  })

  it('undo restores the exact prior state', () => {
    const s = useEditsStore()
    const before = structuredClone(s.doc)
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.undo()
    expect(s.doc).toEqual(before)
  })

  it('redo reapplies what undo removed', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    const after = structuredClone(s.doc)
    s.undo()
    s.redo()
    expect(s.doc).toEqual(after)
  })

  it('updateObject patches in place and inverts cleanly', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: 0.5 } }, 'Set opacity')
    expect(s.doc.objects.o1?.opacity).toBe(0.5)
    s.undo()
    expect(s.doc.objects.o1?.opacity).toBe(1)
  })

  it('deleteObject removes the object and undo brings it back intact', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.applyOp({ type: 'deleteObject', id: 'o1' }, 'Delete')
    expect(s.doc.objects.o1).toBeUndefined()
    s.undo()
    expect(s.doc.objects.o1).toEqual(rectObject('o1'))
  })

  it('a new op clears the redo stack', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.undo()
    expect(s.canRedo).toBe(true)
    s.applyOp({ type: 'addObject', object: rectObject('o2') }, 'Add rectangle')
    expect(s.canRedo).toBe(false)
  })

  it('withTransaction coalesces many ops into ONE history entry', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.withTransaction('Drag', () => {
      for (let x = 0; x < 60; x++) {
        s.applyOp({ type: 'updateObject', id: 'o1', patch: { rect: { x, y: 20, w: 100, h: 50 } } }, 'Drag')
      }
    })
    expect(s.doc.objects.o1?.rect.x).toBe(59)
    s.undo()
    // One undo must rewind the ENTIRE drag, not one of 60 frames.
    expect(s.doc.objects.o1?.rect.x).toBe(10)
  })

  it('nested transactions still produce one entry', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.withTransaction('Outer', () => {
      s.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: 0.5 } }, 'a')
      s.withTransaction('Inner', () => {
        s.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: 0.2 } }, 'b')
      })
    })
    s.undo()
    expect(s.doc.objects.o1?.opacity).toBe(1)
  })

  it('caps history and drops the oldest entries', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    for (let i = 0; i < 250; i++) {
      s.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: i / 250 } }, 'Opacity')
    }
    expect(s.historySize).toBeLessThanOrEqual(200)
    expect(s.canUndo).toBe(true)
  })

  it('assigns increasing z to each added object', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: { ...rectObject('o1'), z: s.nextZ() } }, 'a')
    s.applyOp({ type: 'addObject', object: { ...rectObject('o2'), z: s.nextZ() } }, 'b')
    expect(s.doc.objects.o2!.z).toBeGreaterThan(s.doc.objects.o1!.z)
  })

  it('undo on empty history is a no-op, not a throw', () => {
    const s = useEditsStore()
    expect(() => s.undo()).not.toThrow()
    expect(Object.keys(s.doc.objects)).toHaveLength(0)
  })

  // The single-write-path invariant (design §1.2). `doc` is exposed as a
  // computed, so this assignment is BOTH a compile error and a runtime
  // no-op. readonly() would give only the runtime half -- see the caveat
  // documented in stores/viewport.ts.
  //
  // `$`/`_`-prefixed keys (`$patch`, `$reset`, `$subscribe`, `$onAction`,
  // `$dispose`, `_hotUpdate`) are Pinia framework internals present on
  // EVERY store regardless of what `setup()` returns -- excluded here
  // because they are not part of this store's own exported surface.
  it('exposes no writer other than applyOp', () => {
    const s = useEditsStore()
    const mutators = Object.keys(s).filter(
      (k) => !k.startsWith('$') && !k.startsWith('_')
        && typeof (s as unknown as Record<string, unknown>)[k] === 'function',
    )
    expect(mutators.sort()).toEqual(
      ['applyOp', 'clearSelection', 'nextZ', 'redo', 'reset', 'select', 'undo', 'withTransaction'].sort(),
    )
  })
})
