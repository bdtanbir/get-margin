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
    useEditsStore().reset({ 'src-0': { hash: 'hash-abc', name: 'a.pdf' } }, ['p1', 'p2'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null }, p2: { sourceIndex: 1, sourceId: 'src-0', rotation: 0, cropBox: null } })
  })

  it('starts empty with the given source hash', () => {
    const s = useEditsStore()
    expect(s.doc.sources['src-0']!.hash).toBe('hash-abc')
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

  // A pointer drag is not synchronous: pointerdown starts it, window
  // pointermove events land in LATER turns of the event loop, and pointerup
  // finishes it. withTransaction's callback has already returned by then, so
  // Task 26's gestures need a transaction that can span turns -- otherwise
  // every drag frame pushes its own entry and one drag is sixty undo steps,
  // the exact failure transactions exist to prevent.
  it('coalesces ops spanning event-loop turns between begin and end', async () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.beginTransaction('Drag')
    for (let x = 0; x < 3; x++) {
      await Promise.resolve()
      s.applyOp({ type: 'updateObject', id: 'o1', patch: { rect: { x, y: 20, w: 100, h: 50 } } }, 'Drag')
    }
    s.endTransaction()
    expect(s.doc.objects.o1?.rect.x).toBe(2)
    expect(s.historySize).toBe(2)
    s.undo()
    expect(s.doc.objects.o1?.rect.x).toBe(10)
  })

  it('applies ops immediately during a transaction so the overlay tracks live', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.beginTransaction('Drag')
    s.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: 0.3 } }, 'Drag')
    // Visible before the transaction closes -- only HISTORY is deferred.
    expect(s.doc.objects.o1?.opacity).toBe(0.3)
    expect(s.historySize).toBe(1)
    s.endTransaction()
    expect(s.historySize).toBe(2)
  })

  it('nested begin/end join the outermost transaction', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.beginTransaction('Outer')
    s.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: 0.5 } }, 'a')
    s.beginTransaction('Inner')
    s.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: 0.2 } }, 'b')
    s.endTransaction()
    expect(s.historySize).toBe(1)
    s.endTransaction()
    expect(s.historySize).toBe(2)
    s.undo()
    expect(s.doc.objects.o1?.opacity).toBe(1)
  })

  // A gesture aborted before it started (pointercancel with no move) must
  // not corrupt the depth counter for the NEXT gesture.
  it('endTransaction without a matching begin is a no-op', () => {
    const s = useEditsStore()
    s.endTransaction()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    expect(s.historySize).toBe(1)
  })

  // A slider drag opens its transaction on the first `input` and closes it
  // on `change`. Ctrl+Z pressed with the slider still held would otherwise
  // undo the entry BEFORE the drag while the drag's own patches sat
  // uncommitted -- state and history diverging, and the drag unundoable.
  it('seals an open transaction before undoing', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.beginTransaction('Opacity')
    s.applyOp({ type: 'updateObject', id: 'o1', patch: { opacity: 0.5 } }, 'Opacity')
    s.undo()
    expect(s.doc.objects.o1?.opacity).toBe(1)
    // The object itself survives -- undo took the drag, not the add.
    expect(s.doc.objects.o1).toBeDefined()
    expect(s.canRedo).toBe(true)
  })

  it('seals an open transaction before redoing', () => {
    const s = useEditsStore()
    s.applyOp({ type: 'addObject', object: rectObject('o1') }, 'Add rectangle')
    s.undo()
    s.beginTransaction('Noise')
    s.redo()
    expect(s.doc.objects.o1).toBeDefined()
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
      ['applyOp', 'beginTransaction', 'clearHistory', 'clearSelection', 'endTransaction',
        'nextZ', 'redo', 'reset', 'select', 'undo', 'withTransaction'].sort(),
    )
  })
})

describe('page operations', () => {
  function seed(): ReturnType<typeof useEditsStore> {
    const s = useEditsStore()
    s.reset(
      { 'src-0': { hash: 'h', name: 'a.pdf' } },
      ['p1', 'p2', 'p3'],
      {
        p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null },
        p2: { sourceId: 'src-0', sourceIndex: 1, rotation: 0, cropBox: null },
        p3: { sourceId: 'src-0', sourceIndex: 2, rotation: 0, cropBox: null },
      },
    )
    return s
  }

  it('rotates a page by the given quarter turns', () => {
    const s = seed()
    s.applyOp({ type: 'rotatePage', pageId: 'p2', by: 90 }, 'Rotate')
    expect(s.doc.pages.p2!.rotation).toBe(90)
  })

  it('accumulates rotation and wraps at 360', () => {
    const s = seed()
    for (let i = 0; i < 5; i++) s.applyOp({ type: 'rotatePage', pageId: 'p1', by: 90 }, 'Rotate')
    expect(s.doc.pages.p1!.rotation).toBe(90)
  })

  it('reorders pages', () => {
    const s = seed()
    s.applyOp({ type: 'reorderPages', pageOrder: ['p3', 'p1', 'p2'] }, 'Reorder')
    expect(s.doc.pageOrder).toEqual(['p3', 'p1', 'p2'])
  })

  // A stale order must not resurrect a deleted page or introduce an id
  // with no entry behind it.
  it('filters an order containing unknown ids', () => {
    const s = seed()
    s.applyOp({ type: 'reorderPages', pageOrder: ['p3', 'ghost', 'p1', 'p2'] }, 'Reorder')
    expect(s.doc.pageOrder).toEqual(['p3', 'p1', 'p2'])
  })

  it('deletes pages from both the order and the map', () => {
    const s = seed()
    s.applyOp({ type: 'deletePages', pageIds: ['p2'] }, 'Delete')
    expect(s.doc.pageOrder).toEqual(['p1', 'p3'])
    expect(s.doc.pages.p2).toBeUndefined()
  })

  // Objects are keyed by pageId. Leaving them behind would make
  // EditDocument hold objects pointing at pages that no longer exist.
  it('takes a deleted page’s objects with it', () => {
    const s = seed()
    s.applyOp({ type: 'addObject', object: rectObject('o1', 'p2') }, 'Add')
    s.applyOp({ type: 'addObject', object: rectObject('o2', 'p1') }, 'Add')
    s.applyOp({ type: 'deletePages', pageIds: ['p2'] }, 'Delete')
    expect(s.doc.objects.o1).toBeUndefined()
    expect(s.doc.objects.o2).toBeDefined()
  })

  // One Ctrl+Z brings back the page AND the annotations that were on it.
  it('restores a deleted page with its objects in one undo', () => {
    const s = seed()
    s.applyOp({ type: 'addObject', object: rectObject('o1', 'p2') }, 'Add')
    s.applyOp({ type: 'deletePages', pageIds: ['p2'] }, 'Delete')
    s.undo()
    expect(s.doc.pageOrder).toEqual(['p1', 'p2', 'p3'])
    expect(s.doc.objects.o1).toBeDefined()
  })

  it('deletes several pages in one op and one undo step', () => {
    const s = seed()
    const before = s.historySize
    s.applyOp({ type: 'deletePages', pageIds: ['p1', 'p3'] }, 'Delete')
    expect(s.doc.pageOrder).toEqual(['p2'])
    expect(s.historySize).toBe(before + 1)
    s.undo()
    expect(s.doc.pageOrder).toEqual(['p1', 'p2', 'p3'])
  })

  // A document with no pages has nothing to render and no way back but undo.
  it('refuses to delete every page', () => {
    const s = seed()
    s.applyOp({ type: 'deletePages', pageIds: ['p1', 'p2', 'p3'] }, 'Delete')
    expect(s.doc.pageOrder).toEqual(['p1', 'p2', 'p3'])
  })

  it('crops a page and clears the crop again', () => {
    const s = seed()
    s.applyOp({ type: 'cropPage', pageId: 'p1', cropBox: { x: 10, y: 20, w: 100, h: 200 } }, 'Crop')
    expect(s.doc.pages.p1!.cropBox).toEqual([10, 20, 110, 220])
    s.applyOp({ type: 'cropPage', pageId: 'p1', cropBox: null }, 'Uncrop')
    expect(s.doc.pages.p1!.cropBox).toBeNull()
  })

  it('inserts pages at a position', () => {
    const s = seed()
    s.applyOp({
      type: 'insertPages',
      at: 1,
      pages: [{ id: 'n1', sourceId: 'src-1', sourceIndex: 0, rotation: 0, cropBox: null }],
    }, 'Insert')
    expect(s.doc.pageOrder).toEqual(['p1', 'n1', 'p2', 'p3'])
    expect(s.doc.pages.n1!.sourceId).toBe('src-1')
  })

  it('appends when inserting past the end', () => {
    const s = seed()
    s.applyOp({
      type: 'insertPages',
      at: 99,
      pages: [{ id: 'n1', sourceId: 'src-1', sourceIndex: 0, rotation: 0, cropBox: null }],
    }, 'Insert')
    expect(s.doc.pageOrder[3]).toBe('n1')
  })

  // Registering the source inside the op is what keeps applyOp the only
  // writer -- and what makes undoing a merge remove the source too.
  it('registers a source in the same op, and undo removes it again', () => {
    const s = seed()
    s.applyOp({
      type: 'insertPages',
      at: 99,
      source: { id: 'src-1', hash: 'h2', name: 'b.pdf' },
      pages: [{ id: 'n1', sourceId: 'src-1', sourceIndex: 0, rotation: 0, cropBox: null }],
    }, 'Add b.pdf')
    expect(s.doc.sources['src-1']).toEqual({ hash: 'h2', name: 'b.pdf' })
    s.undo()
    expect(s.doc.sources['src-1']).toBeUndefined()
    expect(s.doc.pageOrder).toEqual(['p1', 'p2', 'p3'])
  })

  it('ignores an op naming a page that does not exist', () => {
    const s = seed()
    s.applyOp({ type: 'rotatePage', pageId: 'nope', by: 90 }, 'Rotate')
    s.applyOp({ type: 'cropPage', pageId: 'nope', cropBox: null }, 'Crop')
    s.applyOp({ type: 'deletePages', pageIds: ['nope'] }, 'Delete')
    expect(s.doc.pageOrder).toEqual(['p1', 'p2', 'p3'])
    expect(s.historySize).toBe(0)
  })
})

/**
 * Coalescing. Distinct from a transaction, which brackets edits whose
 * extent the caller knows: typing has no such bracket -- there is no event
 * meaning "the user has finished with this field", only a keystroke that
 * happens to be the last one.
 */
describe('history coalescing', () => {
  const seeded = () => {
    const s = useEditsStore()
    s.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
      { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
    s.clearHistory()
    return s
  }
  const type = (s: ReturnType<typeof useEditsStore>, key: string, text: string) => {
    for (let i = 1; i <= text.length; i++) {
      s.applyOp({ type: 'setFieldValue', key, value: text.slice(0, i) }, 'Fill field', `field:${key}`)
    }
  }

  it('makes typing one undo entry, not one per keystroke', () => {
    const s = seeded()
    type(s, 'fullname', 'Ada')
    expect(s.doc.fieldValues.fullname).toBe('Ada')
    expect(s.historySize).toBe(1)
  })

  /**
   * Inverses unwind in reverse, so a merged entry has to run the LATER
   * inverse first. Get that backwards and undo restores a value from the
   * middle of the burst instead of the one before it.
   */
  it('undoes the whole burst, back to before it started', () => {
    const s = seeded()
    s.applyOp({ type: 'setFieldValue', key: 'fullname', value: 'seed' }, 'Fill field', 'field:fullname')
    s.clearHistory()
    type(s, 'fullname', 'Ada')
    s.undo()
    expect(s.doc.fieldValues.fullname).toBe('seed')
  })

  it('redoes it as one step too', () => {
    const s = seeded()
    type(s, 'fullname', 'Ada')
    s.undo()
    s.redo()
    expect(s.doc.fieldValues.fullname).toBe('Ada')
    expect(s.canRedo).toBe(false)
  })

  // Moving to the next field starts a new entry, so one undo per field is
  // what the user gets -- which is what they would expect.
  it('starts a new entry for a different field', () => {
    const s = seeded()
    type(s, 'fullname', 'Ada')
    type(s, 'email', 'a@b.c')
    expect(s.historySize).toBe(2)
    s.undo()
    expect(s.doc.fieldValues.email).toBeUndefined()
    expect(s.doc.fieldValues.fullname).toBe('Ada')
  })

  it('does not coalesce ops that ask for no key', () => {
    const s = seeded()
    s.applyOp({ type: 'setFlattenForms', on: true }, 'Flatten form')
    s.applyOp({ type: 'setFlattenForms', on: false }, 'Keep form fields')
    expect(s.historySize).toBe(2)
  })

  // An empty string is a real value: clearing a field someone pre-filled is
  // an edit, and dropping the key would make replay skip it.
  it('keeps an emptied field as an empty value, not a missing one', () => {
    const s = seeded()
    s.applyOp({ type: 'setFieldValue', key: 'fullname', value: '' }, 'Fill field', 'field:fullname')
    expect('fullname' in s.doc.fieldValues).toBe(true)
    expect(s.doc.fieldValues.fullname).toBe('')
  })
})
