import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import FindPanel from '@/features/find/FindPanel.vue'
import FindHighlights from '@/features/find/FindHighlights.vue'
import { useFindStore, type PageMatch } from '@/stores/find'
import { useEditsStore } from '@/stores/edits'
import { useViewportStore } from '@/stores/viewport'
import type { PageState } from '@/stores/document'
import type { Quad } from '@margin/pdf-core'

const find = vi.fn<
  (q: string, o?: unknown, l?: number) => Promise<{ matches: PageMatch[]; capped: boolean }>
>()
vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ find }),
  closeSharedDocument: vi.fn(),
}))

const quad = (i: number): Quad => [i * 10, 0, i * 10 + 10, 0, i * 10, 18, i * 10 + 10, 18]

const match = (page: number, text = 'hit'): PageMatch => ({
  page, lineIndex: 0, start: 0, end: text.length, text,
  lineText: text,
  bold: false,
  size: 12,
  baseline: 14,
  quads: [...text].map((_, i) => quad(i)),
})

function seed(pages = 3) {
  const edits = useEditsStore()
  const ids = Array.from({ length: pages }, (_, i) => `p${i}`)
  edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ids,
    Object.fromEntries(ids.map((id, i) => [
      id, { sourceId: 'src-0', sourceIndex: i, rotation: 0, cropBox: null },
    ])))
}

async function search(query: string) {
  const store = useFindStore()
  store.query = query
  await store.search()
  return store
}

describe('the find store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    find.mockResolvedValue({ matches: [match(0), match(1), match(2)], capped: false })
    seed()
  })

  it('reports the matches it found', async () => {
    const store = await search('hit')
    expect(store.count).toBe(3)
    expect(store.active?.page).toBe(0)
  })

  it('moves to the next and previous match', async () => {
    const store = await search('hit')
    store.next()
    expect(store.current).toBe(1)
    store.previous()
    expect(store.current).toBe(0)
  })

  // The end of the document is not the end of the search.
  it('wraps around in both directions', async () => {
    const store = await search('hit')
    store.previous()
    expect(store.current).toBe(2)
    store.next()
    expect(store.current).toBe(0)
  })

  it('does nothing when there is nothing to move between', async () => {
    find.mockResolvedValue({ matches: [], capped: false })
    const store = await search('nothing')
    store.next()
    expect(store.current).toBe(0)
    expect(store.count).toBe(0)
  })

  it('clears without searching for an empty query', async () => {
    const store = await search('hit')
    store.query = ''
    await store.search()
    expect(store.count).toBe(0)
  })

  /**
   * Typing produces overlapping requests, and the last query typed is the
   * one the user is looking at -- a slower earlier search must not
   * overwrite a faster later one.
   */
  it('ignores a stale response that arrives after a newer one', async () => {
    const store = useFindStore()
    let resolveFirst: (v: { matches: PageMatch[]; capped: boolean }) => void = () => {}
    find.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r }))
    find.mockResolvedValueOnce({ matches: [match(2, 'new')], capped: false })

    store.query = 'old'
    const first = store.search()
    store.query = 'new'
    await store.search()
    // The stale one lands last, and must be discarded.
    resolveFirst({ matches: [match(0, 'old'), match(1, 'old')], capped: false })
    await first
    await flushPromises()

    expect(store.count).toBe(1)
    expect(store.active?.text).toBe('new')
  })

  it('survives a worker that cannot search', async () => {
    find.mockRejectedValue(new Error('nope'))
    const store = await search('hit')
    expect(store.count).toBe(0)
    expect(store.searching).toBe(false)
  })

  it('reports matches for one page', async () => {
    const store = await search('hit')
    expect(store.onPage(1)).toHaveLength(1)
    expect(store.onPage(9)).toHaveLength(0)
  })
})

describe('FindPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    find.mockResolvedValue({ matches: [match(0), match(1), match(2)], capped: false })
    seed()
  })

  it('says how many matches there are, and which one you are on', async () => {
    const w = mount(FindPanel)
    await search('hit')
    await flushPromises()
    expect(w.get('[data-find-count]').text()).toContain('1 of 3')
  })

  it('says so plainly when there are none', async () => {
    find.mockResolvedValue({ matches: [], capped: false })
    const w = mount(FindPanel)
    await search('nothing')
    await flushPromises()
    expect(w.get('[data-find-count]').text()).toContain('No matches')
  })

  // A capped count that reads as exact would be a lie about a long
  // document.
  it('marks a capped count rather than reporting it as exact', async () => {
    find.mockResolvedValue({ matches: [match(0)], capped: true })
    const w = mount(FindPanel)
    await search('e')
    await flushPromises()
    expect(w.get('[data-find-count]').text()).toContain('+')
  })

  it('steps through matches from the buttons', async () => {
    const w = mount(FindPanel)
    const store = await search('hit')
    await flushPromises()
    await w.get('[data-find-next]').trigger('click')
    expect(store.current).toBe(1)
    await w.get('[data-find-prev]').trigger('click')
    expect(store.current).toBe(0)
  })

  it('disables the buttons when there is nothing to step through', async () => {
    find.mockResolvedValue({ matches: [], capped: false })
    const w = mount(FindPanel)
    await search('nothing')
    await flushPromises()
    expect(w.get('[data-find-next]').attributes('disabled')).toBeDefined()
  })

  /**
   * The worker searches the SOURCE document, so a match carries a source
   * page index. The viewport anchors on display position, and the two
   * diverge the moment a page is reordered -- jumping to match.page would
   * scroll somewhere the match is not.
   */
  it('scrolls to where the page actually is after a reorder', async () => {
    const edits = useEditsStore()
    seed(3)
    // Reverse the document: source page 2 is now displayed FIRST and
    // source page 0 is displayed last.
    edits.applyOp({ type: 'reorderPages', pageOrder: ['p2', 'p1', 'p0'] }, 'Reorder')
    /**
     * Asserted on the CALL rather than on anchorIndex, because the store
     * clamps against the document store's page count -- which is zero here,
     * since these tests seed the edit store only. An earlier version
     * checked anchorIndex and passed while the lookup returned "not found"
     * every time and nothing was ever called: 0 was both the expected
     * answer and the untouched default.
     *
     * `goToPage`, not `setAnchor`: following a match has to MOVE the
     * viewport. `setAnchor` only records where the user already is, and a
     * find that merely recorded a position would highlight a match on a
     * page nobody was shown.
     */
    const goToPage = vi.spyOn(useViewportStore(), 'goToPage')

    mount(FindPanel)
    const store = useFindStore()
    find.mockResolvedValue({ matches: [match(0)], capped: false })
    store.query = 'hit'
    await store.search()
    await flushPromises()

    // Source page 0 is display index 2 after the reversal.
    expect(goToPage).toHaveBeenCalledWith(2)
  })

  it('clears the search when closed', async () => {
    const w = mount(FindPanel)
    const store = await search('hit')
    await w.get('[data-find-close]').trigger('click')
    expect(store.count).toBe(0)
    expect(store.query).toBe('')
    expect(w.emitted('close')).toBeTruthy()
  })
})

describe('FindHighlights', () => {
  const page: PageState = {
    id: 'p1', sourceId: 'src-0', sourceIndex: 1,
    geometry: { cropBox: [0, 0, 612, 792], rotate: 0 },
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    seed()
  })

  it('draws nothing when there is no search', () => {
    expect(mount(FindHighlights, { props: { page } }).find('[data-find-highlights]').exists())
      .toBe(false)
  })

  it('marks only the matches on this page', async () => {
    find.mockResolvedValue({ matches: [match(0), match(1)], capped: false })
    await search('hit')
    const w = mount(FindHighlights, { props: { page } })
    // Three characters in 'hit', so three quads -- and only for page 1.
    expect(w.findAll('polygon')).toHaveLength(3)
  })

  /**
   * "40 matches" and "you are looking at this one" are different pieces of
   * information, and one colour makes the second unanswerable without
   * counting.
   */
  it('distinguishes the current match from the others', async () => {
    find.mockResolvedValue({ matches: [match(1, 'a'), match(1, 'b')], capped: false })
    await search('hit')
    const w = mount(FindHighlights, { props: { page } })
    const marks = w.findAll('[data-find-mark]').map((p) => p.attributes('data-find-mark'))
    expect(marks).toContain('current')
    expect(marks).toContain('other')
  })
})

/**
 * Replace is patching applied to search hits, which is why it ships after
 * patching rather than beside find.
 */
describe('replace', () => {
  const patches = (edits: ReturnType<typeof useEditsStore>) =>
    Object.values(edits.doc.objects).filter((o) => o.kind === 'textPatch')

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    seed()
  })

  async function open(matches: PageMatch[]) {
    find.mockResolvedValue({ matches, capped: false })
    const w = mount(FindPanel)
    const store = useFindStore()
    store.query = 'the'
    await store.search()
    await flushPromises()
    await w.get('[data-find-toggle-replace]').trigger('click')
    return w
  }

  it('is hidden until asked for', () => {
    expect(mount(FindPanel).find('[data-find-replace-row]').exists()).toBe(false)
  })

  it('replaces the current match', async () => {
    const edits = useEditsStore()
    const w = await open([
      { ...match(0), lineText: 'the cat', start: 0, end: 3 },
    ])
    await w.get('[data-find-replacement]').setValue('a')
    await w.get('[data-find-replace-one]').trigger('click')

    const made = patches(edits)
    expect(made).toHaveLength(1)
    expect((made[0] as { text: string }).text).toBe('a cat')
  })

  it('replaces every match', async () => {
    const edits = useEditsStore()
    const w = await open([
      { ...match(0), lineText: 'the cat', start: 0, end: 3 },
      { ...match(1), lineText: 'the dog', start: 0, end: 3 },
    ])
    await w.get('[data-find-replacement]').setValue('a')
    await w.get('[data-find-replace-all]').trigger('click')
    expect(patches(edits)).toHaveLength(2)
  })

  // Replacing forty occurrences is one decision and should cost one Cmd+Z.
  it('records replace-all as ONE undo entry', async () => {
    const edits = useEditsStore()
    const w = await open([
      { ...match(0), lineText: 'the cat', start: 0, end: 3 },
      { ...match(1), lineText: 'the dog', start: 0, end: 3 },
    ])
    edits.clearHistory()
    await w.get('[data-find-replacement]').setValue('a')
    await w.get('[data-find-replace-all]').trigger('click')
    expect(edits.historySize).toBe(1)
    edits.undo()
    expect(patches(edits)).toHaveLength(0)
  })

  it('leaves the other matches alone when replacing one', async () => {
    const edits = useEditsStore()
    const w = await open([
      { ...match(0), lineText: 'the cat', start: 0, end: 3 },
      { ...match(1), lineText: 'the dog', start: 0, end: 3 },
    ])
    await w.get('[data-find-replacement]').setValue('a')
    await w.get('[data-find-replace-one]').trigger('click')
    expect(patches(edits)).toHaveLength(1)
  })

  /**
   * The count the user was shown has to reconcile with what happened, or a
   * partial result becomes an unexplained silence.
   */
  it('reports what it did', async () => {
    const w = await open([
      { ...match(0), lineText: 'the cat', start: 0, end: 3 },
      { ...match(1), lineText: 'the dog', start: 0, end: 3 },
    ])
    await w.get('[data-find-replacement]').setValue('a')
    await w.get('[data-find-replace-all]').trigger('click')
    expect(w.get('[data-find-report]').text()).toContain('Replaced 2 of 2')
  })

  /**
   * Replace-all reaches pages the user has never scrolled to, which have
   * no bitmap to sample -- so it says how many may show a mark rather than
   * pretending they were all checked.
   */
  it('warns how many may show a visible mark', async () => {
    const w = await open([{ ...match(0), lineText: 'the cat', start: 0, end: 3 }])
    await w.get('[data-find-replacement]').setValue('a')
    await w.get('[data-find-replace-all]').trigger('click')
    expect(w.get('[data-find-report]').text()).toMatch(/visible mark/)
  })

  it('can delete text by replacing with nothing', async () => {
    const edits = useEditsStore()
    const w = await open([{ ...match(0), lineText: 'the cat', start: 0, end: 3 }])
    await w.get('[data-find-replace-all]').trigger('click')
    expect((patches(edits)[0] as { text: string }).text).toBe(' cat')
  })

  it('does nothing with no matches', async () => {
    find.mockResolvedValue({ matches: [], capped: false })
    const w = mount(FindPanel)
    await w.get('[data-find-toggle-replace]').trigger('click')
    expect(w.get('[data-find-replace-all]').attributes('disabled')).toBeDefined()
  })
})
