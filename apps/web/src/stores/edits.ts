import { defineStore } from 'pinia'
import { ref, shallowRef, computed } from 'vue'
import { produceWithPatches, enablePatches, applyPatches, type Patch } from 'immer'
import { emptyEditDocument, type EditDocument, type Op, type ObjectId } from '@margin/pdf-core'

// Immer ships patch support opt-in. Without this, produceWithPatches returns
// empty patch arrays and every undo silently does nothing.
enablePatches()

const HISTORY_LIMIT = 200
/**
 * Entry count alone is not a memory bound: an image or signature op carries
 * its pixel payload inside the patch. Cap accumulated patch weight too.
 */
const HISTORY_BYTES_LIMIT = 64 * 1024 * 1024

type HistoryEntry = {
  label: string
  patches: Patch[]
  inversePatches: Patch[]
  weight: number
}

function emptyDocument(): EditDocument {
  return emptyEditDocument()
}

/**
 * Recursively sums the byte weight of typed-array payloads reachable from
 * `v`. `addObject`'s patch value is the WHOLE `EditObject` (`{ id, kind,
 * rect, ..., data: Uint8Array }` for an image/signature), not a bare
 * `Uint8Array` -- a shallow `instanceof` check on the patch value itself
 * never finds it, so the byte cap it exists to enforce is silently inert
 * for exactly the payloads (images, signatures) it was written to bound.
 */
function weighValue(v: unknown): number {
  if (v instanceof Uint8Array) return v.byteLength
  if (Array.isArray(v)) {
    let n = 0
    for (const item of v) n += weighValue(item)
    return n
  }
  if (v !== null && typeof v === 'object') {
    let n = 0
    for (const key of Object.keys(v as Record<string, unknown>)) {
      n += weighValue((v as Record<string, unknown>)[key])
    }
    return n
  }
  return 0
}

/**
 * Rough byte weight of a history entry. Typed arrays reachable from either
 * side matter at this scale (images, signatures); everything else is noise
 * against a 64MB cap. Both `patches` (the redo side) AND `inversePatches`
 * (the undo side, e.g. a deleted image's `addObject` inverse retains the
 * full payload it deleted) are weighed -- an entry retains both for as
 * long as it lives in history, so both count toward what it costs to keep.
 */
function weigh(patches: Patch[], inversePatches: Patch[]): number {
  let n = 0
  for (const p of patches) n += 64 + weighValue(p.value)
  for (const p of inversePatches) n += 64 + weighValue(p.value)
  return n
}

function reduce(draft: EditDocument, op: Op): void {
  switch (op.type) {
    case 'addObject':
      draft.objects[op.object.id] = op.object
      if (op.object.z >= draft.nextZ) draft.nextZ = op.object.z + 1
      break
    case 'updateObject': {
      const target = draft.objects[op.id]
      if (!target) return
      Object.assign(target, op.patch)
      break
    }
    case 'deleteObject':
      delete draft.objects[op.id]
      break
    case 'reorder': {
      const target = draft.objects[op.id]
      if (!target) return
      target.z = op.z
      if (op.z >= draft.nextZ) draft.nextZ = op.z + 1
      break
    }

    // ---- Page structure (Task 42). Same linear history as object ops, so
    // Ctrl+Z is globally predictable rather than mode-dependent.

    case 'rotatePage': {
      const page = draft.pages[op.pageId]
      if (!page) return
      // Normalised: an unbounded accumulator would eventually be compared
      // against a normalised source rotation and disagree.
      page.rotation = (((page.rotation + op.by) % 360) + 360) % 360
      break
    }

    case 'reorderPages':
      // Filtered against `pages` so a stale order cannot resurrect a
      // deleted page or introduce an id with no entry.
      draft.pageOrder = op.pageOrder.filter((id) => draft.pages[id])
      break

    case 'deletePages': {
      const doomed = new Set(op.pageIds.filter((id) => draft.pages[id]))
      if (doomed.size === 0) return
      // A document with no pages has nothing to render and no way back
      // except undo. Refuse rather than producing that state.
      if (doomed.size >= draft.pageOrder.length) return
      draft.pageOrder = draft.pageOrder.filter((id) => !doomed.has(id))
      for (const id of doomed) delete draft.pages[id]
      // Objects are keyed by pageId; leaving them behind would orphan them.
      // Both go in ONE patch, so one undo brings the page back with its
      // annotations still on it.
      for (const [objectId, object] of Object.entries(draft.objects)) {
        if (doomed.has(object.pageId)) delete draft.objects[objectId]
      }
      break
    }

    case 'cropPage': {
      const page = draft.pages[op.pageId]
      if (!page) return
      // Stored as a PDF rect [x0,y0,x1,y1] to match PageGeometry.cropBox,
      // which is the shape every consumer of geometry already reads.
      page.cropBox = op.cropBox
        ? [op.cropBox.x, op.cropBox.y, op.cropBox.x + op.cropBox.w, op.cropBox.y + op.cropBox.h]
        : null
      break
    }

    case 'insertPages': {
      // Registering the source here, rather than through a second store
      // method, is what keeps applyOp the only writer -- and means undo
      // takes the source entry away with the pages it brought in.
      if (op.source) draft.sources[op.source.id] = { hash: op.source.hash, name: op.source.name }
      const at = Math.max(0, Math.min(op.at, draft.pageOrder.length))
      for (const { id, ...entry } of op.pages) draft.pages[id] = entry
      draft.pageOrder.splice(at, 0, ...op.pages.map((p) => p.id))
      break
    }
  }
}

export const useEditsStore = defineStore('edits', () => {
  // shallowRef, not ref: Immer deep-freezes everything it produces
  // (`produceWithPatches`'s autofreeze). Vue's `ref()` would deep-wrap that
  // frozen object in a reactive Proxy, and reading back through that Proxy
  // later -- as the base of the NEXT `produceWithPatches` call, or via
  // `applyPatches` -- trips the Proxy invariant for frozen/non-configurable
  // properties ("'get' on proxy: property ... is a read-only and
  // non-configurable data property ... but the proxy did not return its
  // actual value"). `structuredClone` on the same reactive-wrapped object
  // throws `DataCloneError` for the identical reason. `past`/`future` hold
  // Immer patches whose `value` fields reference pieces of that same frozen
  // state, so they need the same treatment. Because shallowRef does not
  // track in-place mutation, every writer below reassigns `.value` with a
  // new array/object rather than push/pop/shift-ing the existing one.
  const state = shallowRef<EditDocument>(emptyDocument())
  const past = shallowRef<HistoryEntry[]>([])
  const future = shallowRef<HistoryEntry[]>([])
  const selectedIds = ref<ObjectId[]>([])

  // Transaction depth, plus the patches accumulated across the whole
  // transaction. `applyOp` still mutates state immediately during a
  // transaction (the overlay must track the drag live) -- what the
  // transaction changes is HISTORY: 60 drag frames become one entry.
  let depth = 0
  let txPatches: Patch[] = []
  let txInverse: Patch[] = []
  let txLabel = ''

  function push(label: string, patches: Patch[], inversePatches: Patch[]): void {
    if (patches.length === 0) return
    const next = [...past.value, { label, patches, inversePatches, weight: weigh(patches, inversePatches) }]
    let bytes = next.reduce((n, e) => n + e.weight, 0)
    while (next.length > HISTORY_LIMIT || (bytes > HISTORY_BYTES_LIMIT && next.length > 1)) {
      const dropped = next.shift()
      bytes -= dropped?.weight ?? 0
    }
    past.value = next
    future.value = []
  }

  function applyOp(op: Op, label: string): void {
    const [next, patches, inversePatches] = produceWithPatches(state.value, (draft) => {
      reduce(draft, op)
    })
    state.value = next as EditDocument
    if (depth > 0) {
      txPatches.push(...patches)
      // Inverses must be replayed in REVERSE order to unwind correctly, so
      // build the transaction's inverse list back-to-front as we go.
      txInverse.unshift(...inversePatches)
      return
    }
    push(label, patches, inversePatches)
  }

  /**
   * Open a transaction that may span event-loop turns. A pointer drag is
   * inherently asynchronous -- pointerdown opens it, each pointermove lands
   * in a later turn, pointerup closes it -- so the synchronous
   * `withTransaction` below cannot wrap one: its callback returns after
   * merely REGISTERING the move listeners, closing the transaction before a
   * single drag frame has been applied and leaving every frame to push its
   * own history entry. Gestures call begin/end directly; everything
   * synchronous should prefer `withTransaction`.
   *
   * Nested calls join the outermost transaction, so the label that survives
   * is the outermost one.
   */
  function beginTransaction(label: string): void {
    if (depth === 0) {
      txPatches = []
      txInverse = []
      txLabel = label
    }
    depth++
  }

  /**
   * Close the innermost transaction; pushes one history entry when the
   * outermost closes. Unbalanced calls are a no-op rather than an error: a
   * gesture can be cancelled (pointercancel) on a path that never opened
   * one, and driving `depth` negative there would silently swallow the NEXT
   * gesture's history.
   */
  function endTransaction(): void {
    if (depth === 0) return
    depth--
    if (depth === 0) {
      push(txLabel, txPatches, txInverse)
      txPatches = []
      txInverse = []
    }
  }

  /**
   * Coalesce every op emitted inside `fn` into a single history entry.
   * Required for freehand strokes and typing -- without it one burst is
   * dozens of undo steps. Nested calls join the outermost transaction.
   * `fn` must be synchronous; use begin/end for anything that spans turns.
   */
  function withTransaction(label: string, fn: () => void): void {
    beginTransaction(label)
    try {
      fn()
    } finally {
      endTransaction()
    }
  }

  /**
   * Seal any transaction still open. Undo/redo call this first: a gesture
   * in flight (a held slider, a drag mid-stroke) has already mutated state,
   * so undoing "the last entry" while its patches sit uncommitted rewinds
   * the wrong step and leaves the gesture permanently unundoable. Sealing
   * makes the in-flight gesture the entry that undo then takes, which is
   * what pressing undo mid-gesture visibly means.
   */
  function sealOpenTransaction(): void {
    while (depth > 0) endTransaction()
  }

  function undo(): void {
    sealOpenTransaction()
    const entry = past.value[past.value.length - 1]
    if (!entry) return
    past.value = past.value.slice(0, -1)
    state.value = applyPatches(state.value, entry.inversePatches)
    future.value = [...future.value, entry]
  }

  function redo(): void {
    sealOpenTransaction()
    const entry = future.value[future.value.length - 1]
    if (!entry) return
    future.value = future.value.slice(0, -1)
    state.value = applyPatches(state.value, entry.patches)
    past.value = [...past.value, entry]
  }

  function nextZ(): number {
    return state.value.nextZ
  }

  function select(ids: ObjectId[]): void { selectedIds.value = ids }
  function clearSelection(): void { selectedIds.value = [] }

  /**
   * Drop the undo stack without touching the document.
   *
   * Used after restoring an autosave: the restore itself is not a step the
   * user should be able to undo, because undoing it would leave them
   * between two documents with no way to say which one they meant.
   */
  function clearHistory(): void {
    past.value = []
    future.value = []
  }

  function reset(
    sources: EditDocument['sources'],
    pageOrder: string[],
    pages: EditDocument['pages'],
  ): void {
    state.value = { ...emptyDocument(), sources, pageOrder, pages }
    past.value = []
    future.value = []
    selectedIds.value = []
  }


  return {
    // computed(), NOT readonly(). Pinia's setup-store type extraction treats
    // any isRef()-true value as mutable state and only special-cases
    // computed() -- so readonly() would leave `edits.doc = x` type-clean
    // while silently failing at runtime. See stores/viewport.ts's caveat.
    doc: computed(() => state.value),
    selection: computed(() => selectedIds.value),
    canUndo: computed(() => past.value.length > 0),
    canRedo: computed(() => future.value.length > 0),
    historySize: computed(() => past.value.length),
    applyOp,
    withTransaction,
    beginTransaction,
    endTransaction,
    undo,
    redo,
    nextZ,
    select,
    clearSelection,
    reset,
    clearHistory,
  }
})
