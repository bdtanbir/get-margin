import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import Inspector from '@/features/tools/Inspector.vue'
import ToolRail from '@/features/tools/ToolRail.vue'
import { useEditsStore } from '@/stores/edits'
import type { EditObject } from '@margin/pdf-core'

const whiteout: EditObject = {
  id: 'w1', pageId: 'p1', kind: 'whiteout',
  rect: { x: 10, y: 20, w: 100, h: 50 },
  rotation: 0, z: 1, locked: false, opacity: 1, fill: [1, 1, 1],
}

const shape: EditObject = {
  id: 'r1', pageId: 'p1', kind: 'rect',
  rect: { x: 10, y: 20, w: 100, h: 50 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  stroke: [0, 0, 0], strokeWidth: 1, fill: null,
}

/**
 * Spec 2.1. Whiteout covers content and does not remove it; the underlying
 * text stays extractable (pdf-core/test/write/whiteout.test.ts asserts
 * exactly that). Users white out SSNs believing the data is gone, so the UI
 * has to say otherwise in plain words. These tests are the guard on that
 * copy -- if they ever start failing, the product has quietly started
 * implying redaction it does not perform.
 */
describe('whiteout honesty', () => {
  /**
   * Rendered markup with HTML comments stripped. Comments are checked out of
   * this assertion deliberately: the source comments in Inspector.vue and
   * toolList.ts warn future editors never to call this tool "redact", and
   * quoting the forbidden word in order to forbid it must not read as the
   * product using it. Attributes stay in scope -- an aria-label saying
   * "Redact" would be exactly the failure this guards.
   */
  const visibleMarkup = (w: { html: () => string }): string =>
    w.html().replace(/<!--[\s\S]*?-->/g, '').toLowerCase()

  let edits: ReturnType<typeof useEditsStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'], { p1: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } })
    edits.applyOp({ type: 'addObject', object: whiteout }, 'add')
    edits.applyOp({ type: 'addObject', object: shape }, 'add')
  })

  it('tells the user, on the whiteout object, that it does not delete', () => {
    edits.select(['w1'])
    expect(mount(Inspector).text()).toContain('does not delete')
  })

  it('says the covered text can still be copied out', () => {
    edits.select(['w1'])
    expect(mount(Inspector).text()).toContain('still be copied out')
  })

  /**
   * NARROWED in Phase 6, when a real redaction shipped.
   *
   * The original assertion was that the word "redact" appeared nowhere in
   * the inspector or the rail. That was right while no genuine redaction
   * existed: the only thing the word could have referred to was whiteout,
   * and that would have been the user-harm risk this file guards.
   *
   * There is now a tool that actually removes text, verified by two
   * extractors that share no code with MuPDF. So the word is allowed --
   * pointing someone from whiteout TO it is the honest thing to do -- and
   * what must remain true is the narrower, real claim: whiteout itself is
   * never called redaction.
   */
  it('never calls the whiteout tool "redact"', () => {
    const rail = mount(ToolRail)
    const labels = rail.findAll('button').map((b) => (b.attributes('aria-label') ?? '').toLowerCase())
    // A Redact entry may exist. A whiteout entry named "redact" may not.
    expect(labels).toContain('whiteout')
    expect(labels.filter((l) => l.includes('redact'))).toEqual(['redact'])
  })

  it('never describes whiteout as removing anything', () => {
    edits.select(['w1'])
    const notice = mount(Inspector).get('[data-whiteout-notice]').text().toLowerCase()
    expect(notice).toContain('does not delete it')
    expect(notice).not.toMatch(/whiteout (removes|deletes|redacts)/)
  })

  /**
   * The other half, and new: now that a real one exists, the notice has
   * somewhere to send people. Saying "this does not delete" without saying
   * what does is half an answer.
   */
  it('points at the tool that does remove text', () => {
    edits.select(['w1'])
    expect(mount(Inspector).get('[data-whiteout-notice]').text()).toContain('Redact')
  })

  it('does not show the notice for other kinds', () => {
    edits.select(['r1'])
    expect(mount(Inspector).find('[data-whiteout-notice]').exists()).toBe(false)
  })
})
