import { defineStore } from 'pinia'
import { ref, shallowRef, computed, watch } from 'vue'
import type { EditDocument } from '@margin/pdf-core'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { putEdit, findEdit, deleteEdit, type SavedEdit } from '@/lib/autosaveDb'
import { migrateEditDocument } from '@margin/pdf-core'

/**
 * How long after the last edit a save runs.
 *
 * An autosave per keystroke would be a write per keystroke. Long enough to
 * coalesce a burst of typing or a drag, short enough that a crash costs at
 * most a second and a half of work.
 */
export const AUTOSAVE_DEBOUNCE_MS = 1500

export const useAutosaveStore = defineStore('autosave', () => {
  const edits = useEditsStore()
  const doc = useDocumentStore()

  const lastSavedAt = ref<number | undefined>(undefined)

  /**
   * A stored record matching the open document, waiting to be offered.
   *
   * shallowRef, not ref, for the same reason stores/edits.ts uses one: a
   * deep reactive Proxy over this record would be handed to Immer on
   * restore, and Immer's freeze walk trips the Proxy invariant for
   * non-configurable properties ("'get' on proxy: property 'src-0' is a
   * read-only and non-configurable data property ... but the proxy did not
   * return its actual value"). Nothing renders from the record's interior,
   * so shallow reactivity is all it needs.
   */
  const offered = shallowRef<SavedEdit | undefined>(undefined)

  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  /** Reactive mirror of `timer`, so the UI can show "Saving…" honestly. */
  const pending = ref(false)

  /** The hash the record is keyed by: the first source the user opened. */
  function primaryHash(): string | undefined {
    return doc.sourceHash || undefined
  }

  /**
   * Persist once. Never rejects.
   *
   * autosaveDb already swallows storage failures, but this must not depend
   * on that: the call is fired from a timer, so a rejection here would
   * surface as an unhandled promise rejection with no one to catch it --
   * and losing an autosave is never worth taking the page down for.
   */
  async function write(): Promise<void> {
    try {
      await persist()
    } catch {
      // Recorded by nothing on purpose: a failed autosave is not something
      // to interrupt the user over, and the next edit schedules another.
    }
  }

  /**
   * Nothing worth restoring: no objects on the page and nothing in the undo
   * stack, so the document is exactly the file that was opened.
   *
   * Without this, discarding a restore immediately re-saved the emptied
   * document, and reopening the same file offered to restore *nothing* --
   * caught by e2e/autosave.spec.ts, not by any unit test.
   *
   * A restored document has objects but an empty history (restore clears
   * it deliberately), which is why both conditions are required rather
   * than just the history one.
   */
  function nothingToSave(): boolean {
    return Object.keys(edits.doc.objects).length === 0 && edits.historySize === 0
  }

  async function persist(): Promise<void> {
    const hash = primaryHash()
    if (!hash || !doc.isReady || nothingToSave()) return
    const now = Date.now()
    await putEdit({
      hash,
      name: doc.fileName,
      savedAt: now,
      // A plain structured-cloneable snapshot. `edits.doc` is Immer-frozen,
      // which IndexedDB is happy with, but taking the value here means a
      // later edit cannot mutate what is queued.
      doc: edits.doc as EditDocument,
    })
    lastSavedAt.value = now
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    pending.value = true
    timer = setTimeout(() => {
      timer = undefined
      void write().finally(() => { pending.value = false })
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  /** Write now, for beforeunload — a deliberate close should keep the last edit. */
  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    await write()
    pending.value = false
  }

  function start(): void {
    if (unsubscribe) return
    // `watch` on the computed, NOT `edits.$subscribe`. The edit store keeps
    // its document in an internal shallowRef and exposes only a computed
    // over it, so Pinia has no tracked state to subscribe to and
    // $subscribe never fires -- it fails silently, which is how an autosave
    // that never saves ships green.
    //
    // `doc` is replaced wholesale by Immer on every op, so identity change
    // is an exact "something was edited" signal.
    unsubscribe = watch(() => edits.doc, () => schedule())
  }

  function stop(): void {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    pending.value = false
    unsubscribe?.()
    unsubscribe = undefined
    offered.value = undefined
  }

  /** Look for stored edits for the document just opened. Does NOT apply them. */
  async function checkForSaved(): Promise<void> {
    const hash = primaryHash()
    offered.value = hash ? await findEdit(hash) : undefined
  }

  function dismiss(): void {
    offered.value = undefined
  }

  /**
   * Apply the offered edits.
   *
   * Migrated on the way in: a record written by an older build predates the
   * current schema, and one written by a NEWER build must be refused rather
   * than mangled. migrateEditDocument does both, and throwing here is
   * correct -- silently restoring a document this build cannot represent
   * would corrupt the user's work rather than lose it, which is worse.
   */
  function restore(): void {
    const record = offered.value
    offered.value = undefined
    if (!record) return
    const doc_ = migrateEditDocument(record.doc)
    edits.reset(doc_.sources, doc_.pageOrder, doc_.pages)
    for (const object of Object.values(doc_.objects)) {
      edits.applyOp({ type: 'addObject', object }, 'Restore')
    }
    // Restoring is not itself an undoable step: undoing it would leave the
    // user between two documents with no way to say which they wanted.
    edits.clearHistory()
  }

  async function discard(): Promise<void> {
    const hash = primaryHash()
    offered.value = undefined
    if (hash) await deleteEdit(hash)
  }

  return {
    lastSavedAt: computed(() => lastSavedAt.value),
    pending: computed(() => pending.value),
    /**
     * 'saving' while a write is queued or running, 'saved' once one has
     * landed, and empty before anything has been worth saving. Shown to the
     * user, and the signal e2e waits on instead of a fixed delay.
     */
    state: computed(() => {
      if (pending.value) return 'saving'
      return lastSavedAt.value ? 'saved' : ''
    }),
    offered: computed(() => offered.value),
    start,
    stop,
    flush,
    checkForSaved,
    restore,
    dismiss,
    discard,
  }
})
