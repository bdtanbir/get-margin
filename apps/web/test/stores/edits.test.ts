import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { watchEffect, nextTick } from 'vue'
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

function imageObject(id: string, bytes: number, pageId = 'p1'): EditObject {
  return {
    id, pageId, kind: 'image',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    rotation: 0, z: 1, locked: false, opacity: 1,
    data: new Uint8Array(bytes), mime: 'image/png',
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

  it('caps history at exactly 200 entries and evicts the oldest first', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    for (let i = 0; i < 250; i++) {
      s.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: i / 250 } }, 'Opacity')
    }
    // 251 pushes total (1 add + 250 updates); the cap must land on exactly
    // 200, not merely "at or under" -- a cap of 1, or a push that drops
    // everything but the newest entry, would also satisfy `<= 200`.
    expect(s.historySize).toBe(200)
    // Every retained entry's opacity value is < 1 by construction
    // (i / 250 for i in 0..249 never reaches 1). Rewinding ALL retained
    // history must therefore land short of the pristine `opacity: 1` --
    // proof the original `addObject` (and the earliest updates) were
    // actually evicted, not merely that undo stops working after 200 pops.
    for (let i = 0; i < 200; i++) s.undo()
    expect(s.canUndo).toBe(false)
    expect(s.doc.objects.o1?.opacity).not.toBe(1)
  })

  it('caps history by byte weight, not just entry count', () => {
    const s = useEditsStore()
    const TWO_MB = 2 * 1024 * 1024
    s.applyOp({ type: 'addObject', object: imageObject('img1', 1024) }, 'Add image')
    const pushes = 20
    for (let i = 0; i < pushes; i++) {
      s.applyOp({ type: 'updateObject', id: 'img1', patch: { data: new Uint8Array(TWO_MB) } }, 'Replace image')
    }
    // 21 entries total, each carrying a ~2MB forward payload plus a ~2MB
    // (or, for the first, ~1KB) inverse payload -- roughly 80MB, well over
    // the 64MB cap, while nowhere near the 200-entry cap. Eviction here can
    // only be explained by the byte-weight ceiling actually firing.
    expect(s.historySize).toBeLessThan(pushes + 1)
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

  // Deviation A (task-23 review) rests entirely on `state`/`past`/`future`
  // being reassigned wholesale, never mutated in place, because they are
  // `shallowRef`s and Vue only tracks `.value` reassignment on those --
  // NOT push/pop/shift on the array they hold. Every other test in this
  // file happens to read `doc`/`canUndo`/`historySize` for the first time
  // AFTER the mutating call, so a regression back to in-place `push`/`pop`
  // (which still satisfies every assertion above) would slip through
  // unnoticed. This test subscribes BEFORE any mutation and counts re-fires
  // across `applyOp`, `undo`, and `redo`, so an in-place regression shows
  // up as a stuck effect count instead of a value that happens to still be
  // correct.
  it('doc, canUndo, and historySize re-fire reactively on every write', async () => {
    const s = useEditsStore()
    let docFires = 0
    let canUndoFires = 0
    let historyFires = 0
    const stopDoc = watchEffect(() => { void s.doc; docFires++ })
    const stopCanUndo = watchEffect(() => { void s.canUndo; canUndoFires++ })
    const stopHistory = watchEffect(() => { void s.historySize; historyFires++ })
    await nextTick()
    expect(docFires).toBe(1)
    expect(canUndoFires).toBe(1)
    expect(historyFires).toBe(1)

    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    await nextTick()
    expect(docFires).toBe(2)
    expect(canUndoFires).toBe(2)
    expect(historyFires).toBe(2)

    s.undo()
    await nextTick()
    expect(docFires).toBe(3)
    expect(canUndoFires).toBe(3)
    expect(historyFires).toBe(3)

    s.redo()
    await nextTick()
    expect(docFires).toBe(4)
    expect(canUndoFires).toBe(4)
    expect(historyFires).toBe(4)

    stopDoc()
    stopCanUndo()
    stopHistory()
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
