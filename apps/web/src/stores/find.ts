import { defineStore } from 'pinia'
import { ref, computed, shallowRef } from 'vue'
import type { Match } from '@margin/pdf-core'
import { getPdfClient } from '@/workers/pdfClient'

export type PageMatch = { page: number } & Match

/**
 * Find state: the query, its matches, and which one is current.
 *
 * Separate from the text-selection store because these are different
 * things: a selection is something the user made with a pointer and can
 * act on, while a match is something the document contains. Conflating
 * them would make "next match" quietly change what a markup tool would
 * annotate.
 */
export const useFindStore = defineStore('find', () => {
  const query = ref('')
  const caseSensitive = ref(false)
  const wholeWord = ref(false)
  // shallowRef: the matches are plain frozen data from the worker and
  // deep-wrapping every quad of every match would cost more than it buys.
  const matches = shallowRef<PageMatch[]>([])
  const current = ref(0)
  const searching = ref(false)
  const capped = ref(false)

  const count = computed(() => matches.value.length)
  const active = computed<PageMatch | undefined>(() => matches.value[current.value])

  /** Matches on one page, for the highlight layer. */
  function onPage(page: number): PageMatch[] {
    return matches.value.filter((m) => m.page === page)
  }

  let token = 0

  async function search(): Promise<void> {
    const mine = ++token
    const q = query.value
    if (q === '') {
      matches.value = []
      current.value = 0
      capped.value = false
      return
    }

    searching.value = true
    try {
      const result = await getPdfClient().find(q, {
        caseSensitive: caseSensitive.value,
        wholeWord: wholeWord.value,
      })
      // A slower earlier search must not overwrite a faster later one --
      // typing produces overlapping requests, and the last query typed is
      // the one the user is looking at.
      if (mine !== token) return
      matches.value = result.matches
      capped.value = result.capped
      current.value = 0
    } catch {
      if (mine !== token) return
      matches.value = []
      capped.value = false
    } finally {
      if (mine === token) searching.value = false
    }
  }

  /** Wrap around: the end of the document is not the end of the search. */
  function next(): void {
    if (matches.value.length === 0) return
    current.value = (current.value + 1) % matches.value.length
  }

  function previous(): void {
    if (matches.value.length === 0) return
    current.value = (current.value - 1 + matches.value.length) % matches.value.length
  }

  function clear(): void {
    token++
    query.value = ''
    matches.value = []
    current.value = 0
    capped.value = false
    searching.value = false
  }

  return {
    query,
    caseSensitive,
    wholeWord,
    matches: computed(() => matches.value),
    current: computed(() => current.value),
    count,
    active,
    searching: computed(() => searching.value),
    capped: computed(() => capped.value),
    onPage,
    search,
    next,
    previous,
    clear,
  }
})
