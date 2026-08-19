import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import type { SourceField, SourceId } from '@margin/pdf-core'
import { getPdfClient } from '@/workers/pdfClient'

const cacheKey = (sourceId: SourceId, index: number): string => `${sourceId}:${index}`

/**
 * The form fields each source page carries.
 *
 * Cached because enumerating fields means loading a page in the worker, and
 * the fill overlay asks on every mount -- scrolling a 40-page form would
 * otherwise re-enumerate continuously for answers that cannot change. The
 * source document is immutable, so the cache never needs invalidating for
 * anything but a new document.
 *
 * shallowRef and whole-map reassignment, matching the edit store: the
 * values are frozen arrays from the worker and deep reactivity would buy
 * nothing but proxy overhead on every field of every page.
 */
export const useFieldsStore = defineStore('fields', () => {
  const byPage = shallowRef<Record<string, SourceField[]>>({})
  const inFlight = new Map<string, Promise<void>>()

  function fields(sourceId: SourceId, index: number): SourceField[] {
    return byPage.value[cacheKey(sourceId, index)] ?? []
  }

  /**
   * Fetch a page's fields once.
   *
   * Concurrent callers for the same page share one request rather than
   * racing: two overlays mounting in the same tick is the normal case, not
   * an edge one.
   */
  function load(sourceId: SourceId, index: number): Promise<void> {
    const key = cacheKey(sourceId, index)
    if (key in byPage.value) return Promise.resolve()
    const existing = inFlight.get(key)
    if (existing) return existing

    // The try wraps getPdfClient() as well as the call, not just the
    // promise. Creating the client can throw synchronously -- there is no
    // Worker constructor outside a browser -- and a rejection handler on a
    // promise that was never constructed catches nothing. Without this, a
    // page enumerating its fields could take down the whole overlay, which
    // is the opposite of what the comment below promises.
    let request: Promise<void>
    try {
      request = getPdfClient()
        .listFields(sourceId, index)
        .then((found) => {
          byPage.value = { ...byPage.value, [key]: found }
        })
        .catch(() => {
          // A page whose fields cannot be read still renders and still
          // takes every drawing tool. Cache the empty result so a page that
          // fails once is not retried on every scroll tick.
          byPage.value = { ...byPage.value, [key]: [] }
        })
    } catch {
      byPage.value = { ...byPage.value, [key]: [] }
      return Promise.resolve()
    }
    request = request.finally(() => {
      inFlight.delete(key)
    })

    inFlight.set(key, request)
    return request
  }

  /**
   * Whether any page enumerated so far carries a form field.
   *
   * Deliberately reports on what has been LOOKED AT, not on the document
   * as a whole -- enumerating every page of a 300-page file to decide
   * whether to show one checkbox would be a page load per page. The
   * consequence is honest either way: an option to flatten forms is noise
   * on a document with no form the app has seen, and appears as soon as
   * one scrolls into view.
   */
  function anyFound(): boolean {
    return Object.values(byPage.value).some((f) => f.length > 0)
  }

  function reset(): void {
    byPage.value = {}
    inFlight.clear()
  }

  return { fields, load, anyFound, reset }
})
