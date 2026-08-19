import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { EditDocument } from '@margin/pdf-core'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { putEdit, findEdit, deleteEdit, type SavedEdit } from '@/lib/autosaveDb'

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
  /** A stored record matching the open document, waiting to be offered. */
  const offered = ref<SavedEdit | undefined>(undefined)

  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined

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

  async function persist(): Promise<void> {
    const hash = primaryHash()
    if (!hash || !doc.isReady) return
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
    timer = setTimeout(() => {
      timer = undefined
      void write()
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  /** Write now, for beforeunload — a deliberate close should keep the last edit. */
  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    await write()
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

  async function discard(): Promise<void> {
    const hash = primaryHash()
    offered.value = undefined
    if (hash) await deleteEdit(hash)
  }

  return {
    lastSavedAt: computed(() => lastSavedAt.value),
    offered: computed(() => offered.value),
    start,
    stop,
    flush,
    checkForSaved,
    dismiss,
    discard,
  }
})
